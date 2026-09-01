import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger as PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { IngestJobData } from '../webhooks/webhooks.service';
import { SpamFilterService } from './services/spam-filter.service';
import { AttachmentExtractorService } from './services/attachment-extractor.service';
import { ExtractionAgentService, CandidateExtract, resolveAgencyFromEmail } from './services/extraction-agent.service';
import { CvClassifierService, CvClassification } from './services/cv-classifier.service';
import { JobMatcherService } from './services/job-matcher.service';
import { StorageService } from '../storage/storage.service';
import { DedupService, DedupResult } from '../dedup/dedup.service';
import { ScoringAgentService, ScoringInput } from '../scoring/scoring.service';
import { VoiceCallsService } from '../voice/voice-calls.service';
import { sanitizePgText } from '../common/sanitize-pg-text';
import { parseShortIdAliases, applyShortIdAliases } from '../config/short-id-aliases';
import { mergeEnrichment, EnrichmentFields } from './merge-enrichment';

export interface ProcessingContext {
  fullText: string;
  fileKey: string | null; // R2 object key (D-04) or null if no CV attachment found
  cvText: string; // Phase 3 extracted text — written to candidates.cv_text in Phase 7
  candidateId: string; // Phase 6 output — set immediately after INSERT/UPSERT; consumed by Phase 7
}

@Injectable()
@Processor('ingest-email', {
  lockDuration: 30000, // 30s lock per job (Issue Fix 1: prevents timeout on long-running scoring loops)
  lockRenewTime: 5000, // renew lock every 5s
  maxStalledCount: 2, // retry if stalled 2x
})
export class IngestionProcessor extends WorkerHost {
  private readonly shortIdAliases: Map<string, string>;

  constructor(
    private readonly spamFilter: SpamFilterService,
    private readonly cvClassifier: CvClassifierService,
    private readonly attachmentExtractor: AttachmentExtractorService,
    private readonly prisma: PrismaService,
    private readonly extractionAgent: ExtractionAgentService,
    private readonly storageService: StorageService,
    private readonly dedupService: DedupService,
    private readonly scoringService: ScoringAgentService,
    private readonly voiceCallsService: VoiceCallsService,
    private readonly jobMatcher: JobMatcherService,
    private readonly config: ConfigService,
    private readonly pinoLogger: PinoLogger,
  ) {
    super();
    this.shortIdAliases = parseShortIdAliases(this.config.get<string>('SHORT_ID_ALIASES'));
  }

  /**
   * Extract candidate short_ids from combined subject + body text.
   * Short_ids are plain numbers >= 100 (e.g., 100, 245, 1053).
   * Returns array of candidate short_id strings (may include false positives
   * like years or zip codes — the downstream DB query filters those out).
   */
  private extractCandidateShortIds(subject: string | null | undefined, body: string | null | undefined): string[] {
    const combinedText = [subject, body].filter(Boolean).join(' ');

    if (!combinedText) return [];

    // Match all 3+ digit numbers as word boundaries
    const numberPattern = /\b(\d{3,})\b/g;
    const matches = [...combinedText.matchAll(numberPattern)];

    if (matches.length === 0) return [];

    // Filter >= 100, deduplicate, keep as strings (shortId is string type in DB)
    return [...new Set(matches.map((m) => m[1]).filter((s) => parseInt(s, 10) >= 100))];
  }

  async process(job: Job<IngestJobData>): Promise<void> {
    if (!job.data.tenantId || !job.data.messageId) {
      throw new Error(
        `Job ${job.id} has pre-P1 format — drain queue before upgrading (job data: ${JSON.stringify(job.data).slice(0, 100)})`,
      );
    }
    const { tenantId, messageId: jobMessageId } = job.data;
    const payload = await this.storageService.downloadPayload(tenantId, jobMessageId);

    this.pinoLogger.log({ jobId: job.id, jobName: job.name, tenantId }, 'Job started');
    this.pinoLogger.log({ jobId: job.id, messageId: payload.MessageID }, 'Job processing started');

    // Fetch intake once — used for idempotency guard (Phase 6) and cvFileKey
    const existingIntake = await this.prisma.emailIntakeLog.findUnique({
      where: { idx_intake_message_id: { tenantId, messageId: payload.MessageID } },
      select: { candidateId: true, cvFileKey: true },
    });

    // Step 0: Spam filter FIRST — before any parsing (D-11)
    const filterResult = this.spamFilter.check(payload);

    if (filterResult.isSpam) {
      // D-12: Hard reject — update status to 'spam' and stop
      await this.prisma.emailIntakeLog.update({
        where: {
          idx_intake_message_id: { tenantId, messageId: payload.MessageID },
        },
        data: { processingStatus: 'spam' },
      });
      this.pinoLogger.log({ messageId: payload.MessageID }, 'Spam filter rejected');
      return;
    }

    // INGEST GATE — per-tenant kill-switch for all AI spend in this pipeline.
    // Sits after the (free) spam filter and before the first OpenRouter call.
    // Payload is already durable (R2 + intake row), so holding loses nothing;
    // POST /ingest-control/replay re-enqueues held messages through this same path.
    const org = await this.prisma.organization.findUnique({
      where: { id: tenantId },
      select: { aiIngestEnabled: true },
    });
    if (org && !org.aiIngestEnabled) {
      await this.prisma.emailIntakeLog.update({
        where: { idx_intake_message_id: { tenantId, messageId: payload.MessageID } },
        data: { processingStatus: 'held' },
      });
      this.pinoLogger.log({ messageId: payload.MessageID }, 'Ingest gate: AI ingest disabled — email held');
      return;
    }

    // D-13: Passed spam filter — update status to 'processing'
    await this.prisma.emailIntakeLog.update({
      where: {
        idx_intake_message_id: { tenantId, messageId: payload.MessageID },
      },
      data: { processingStatus: 'processing' },
    });

    // Step 1: Extract text from attachments (D-02, D-03)
    const attachmentText = await this.attachmentExtractor.extract(payload.Attachments ?? []);

    // Build fullText: email body first, then attachment sections (D-02)
    const bodySection = payload.TextBody?.trim() ? `--- Email Body ---\n${payload.TextBody.trim()}` : '';

    // Defense in depth: sanitize the combined text once more here. The attachment extractor
    // already strips NUL/lone-surrogates at the source, but the email body can carry them too,
    // and this fullText is what becomes candidates.cv_text (a Postgres text column) in Phase 7.
    const fullText = sanitizePgText([bodySection, attachmentText].filter(Boolean).join('\n\n'));

    // CV CLASSIFICATION GATE — decide whether this email is a job application
    // BEFORE any candidate is created. Runs after fullText is built (so attachment
    // text is available to judge) and before AI extraction. The extractor is told
    // "this is a CV", so it cannot be trusted to also judge whether it is one.
    let classification: CvClassification;
    try {
      classification = await this.cvClassifier.classify({
        fullText,
        subject: payload.Subject ?? '',
        fromEmail: payload.From,
        suspicious: filterResult.suspicious,
        hasMeaningfulAttachment: this.spamFilter.hasMeaningfulAttachment(payload.Attachments),
        bodyLength: (payload.TextBody ?? '').trim().length,
        resolvedAgency: resolveAgencyFromEmail(payload.From),
        tenantId,
        messageId: payload.MessageID,
      });
    } catch (err) {
      await this.prisma.emailIntakeLog.update({
        where: { idx_intake_message_id: { tenantId, messageId: payload.MessageID } },
        data: { processingStatus: 'failed', errorMessage: (err as Error).message },
      });
      this.pinoLogger.error(
        { messageId: payload.MessageID, attempt: job.attemptsMade + 1, error: (err as Error).message },
        'CV classification failed',
      );
      throw err;
    }

    if (classification.verdict === 'not_cv') {
      await this.prisma.emailIntakeLog.update({
        where: { idx_intake_message_id: { tenantId, messageId: payload.MessageID } },
        data: { processingStatus: 'not_cv' },
      });
      this.pinoLogger.log(
        { messageId: payload.MessageID, reason: classification.reason },
        'CV classifier: not a job application',
      );
      return;
    }

    if (classification.verdict === 'uncertain') {
      await this.prisma.emailIntakeLog.update({
        where: { idx_intake_message_id: { tenantId, messageId: payload.MessageID } },
        data: { processingStatus: 'needs_review' },
      });
      this.pinoLogger.log(
        { messageId: payload.MessageID, reason: classification.reason },
        'CV classifier: uncertain — needs human review',
      );
      return;
    }

    // verdict === 'cv' → continue the existing pipeline unchanged
    this.pinoLogger.log(
      { messageId: payload.MessageID, reason: classification.reason },
      'CV classifier: confirmed job application',
    );

    // Phase 3 output — passed to Phase 4 inline
    const context: ProcessingContext = {
      fullText,
      fileKey: existingIntake?.cvFileKey ?? null, // set by webhook (P1)
      cvText: fullText,
      candidateId: '',
    };

    // Phase 4: AI extraction — passes metadata for context (Phase 14: metadata enables source_hint detection)
    let extraction: CandidateExtract;
    try {
      extraction = await this.extractionAgent.extract(context.fullText, {
        subject: payload.Subject ?? '',
        fromEmail: payload.From,
        tenantId,
        messageId: payload.MessageID,
      });
    } catch (err) {
      await this.prisma.emailIntakeLog.update({
        where: { idx_intake_message_id: { tenantId, messageId: payload.MessageID } },
        data: { processingStatus: 'failed', errorMessage: (err as Error).message },
      });
      this.pinoLogger.error(
        { messageId: payload.MessageID, attempt: job.attemptsMade + 1, error: (err as Error).message },
        'AI extraction failed',
      );
      throw err;
    }

    // D-04, D-05: empty fullName is treated the same as extraction failure (permanent — do not retry)
    if (!extraction!.full_name?.trim()) {
      await this.prisma.emailIntakeLog.update({
        where: {
          idx_intake_message_id: { tenantId, messageId: payload.MessageID },
        },
        data: { processingStatus: 'failed' },
      });
      this.pinoLogger.error({ messageId: payload.MessageID }, 'Extraction returned empty fullName');
      return;
    }

    this.pinoLogger.log({ messageId: payload.MessageID, fullName: extraction!.full_name }, 'Phase 4 complete');

    // Phase 6: Duplicate detection + minimal candidate shell INSERT/UPSERT (atomic)
    // === IDEMPOTENCY GUARD ===
    // If this is a BullMQ retry and Phase 6 already completed (candidateId is set),
    // skip the entire dedup + insert transaction and reuse the existing candidateId.
    let candidateId!: string;

    if (existingIntake?.candidateId) {
      this.pinoLogger.log(
        { messageId: payload.MessageID, candidateId: existingIntake.candidateId },
        'Idempotency guard: skipping Phase 6',
      );
      candidateId = existingIntake.candidateId;
    } else {
      try {
        await this.prisma.$transaction(async (tx) => {
          // Advisory locks: serialize concurrent workers processing the same email or phone so
          // the dedup check below sees committed rows. The email lock prevents two same-email
          // submissions from both passing the dedup check and racing to INSERT (which would
          // violate the unique email index). Locks release automatically on commit/rollback.
          if (extraction!.email?.trim()) {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${extraction!.email.trim()}))`;
          }
          if (extraction!.phone?.trim()) {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${extraction!.phone}))`;
          }

          // Dedup check — now INSIDE the transaction, protected by advisory lock
          let dedupResult: DedupResult | null = null;
          try {
            dedupResult = await this.dedupService.check(extraction!, tenantId, tx);
          } catch (err) {
            this.pinoLogger.error(
              { messageId: payload.MessageID, error: (err as Error).message },
              'Dedup check failed',
            );
            throw err; // Transaction will rollback
          }

          if (dedupResult?.fields.includes('email')) {
            // Email match — this person already exists in the tenant (one email per tenant is
            // enforced by the DB). Reuse the existing candidate instead of inserting a duplicate
            // row (which would violate the unique index and drop the candidate). Phase 7 then
            // enriches/refreshes that row with the latest CV data. Must come BEFORE the
            // confidence === 1.0 branch, since an email match also has confidence 1.0.
            candidateId = dedupResult.match!.id;
          } else if (dedupResult === null) {
            // No phone match — new candidate, proceed normally
            candidateId = await this.dedupService.insertCandidate(
              extraction!,
              tenantId,
              payload.From,
              tx,
              extraction!.source_hint,
            );
          } else if (dedupResult.fields.includes('phone_missing')) {
            // Phone not extracted from CV — insert as new candidate + flag for HR review
            candidateId = await this.dedupService.insertCandidate(
              extraction!,
              tenantId,
              payload.From,
              tx,
              extraction!.source_hint,
            );
            await this.dedupService.createFlag(
              candidateId,
              null, // no match target — self-referencing flag
              0, // confidence 0 — not a real duplicate signal
              tenantId,
              ['phone_missing'],
              tx,
            );
          } else if (dedupResult.confidence === 1.0) {
            // Exact phone match — insert a NEW candidate row so both submissions appear in the UI
            // The existing candidate is untouched (first-submission attribution preserved, D-07)
            candidateId = await this.dedupService.insertCandidate(
              extraction!,
              tenantId,
              payload.From,
              tx,
              extraction!.source_hint,
            );

            // Link new row → existing row so HR can see both are the same person
            await this.dedupService.createFlag(
              candidateId, // new candidate (incoming submission)
              dedupResult.match!.id, // existing candidate (first submission)
              dedupResult.confidence, // 1.0 — exact phone match
              tenantId,
              dedupResult.fields, // ['phone']
              tx,
            );
          }

          // D-10: Set email_intake_log.candidate_id atomically — if this fails, candidate INSERT rolls back too
          await tx.emailIntakeLog.update({
            where: { idx_intake_message_id: { tenantId, messageId: payload.MessageID } },
            data: { candidateId: candidateId! },
          });
        });
      } catch (err) {
        this.pinoLogger.error(
          { messageId: payload.MessageID, error: (err as Error).message },
          'Phase 6 transaction failed',
        );
        this.pinoLogger.error(
          {
            jobId: job.id,
            jobName: job.name,
            tenantId,
            error: err instanceof Error ? err.message : String(err),
          },
          'Job failed',
        );
        // Log failure in intake status — transaction errors may be transient (DB connection loss)
        // or permanent (constraint violation). BullMQ will retry up to 3 attempts.
        await this.prisma.emailIntakeLog.update({
          where: { idx_intake_message_id: { tenantId, messageId: payload.MessageID } },
          data: { processingStatus: 'failed', errorMessage: (err as Error).message },
        });
        throw err; // Re-throw so BullMQ retries (attempt 1, 2, 3) for transient errors
      }
    } // end else (idempotency guard)

    // Pass candidateId to Phase 7 via context (D-16)
    context.candidateId = candidateId!;

    this.pinoLogger.log({ messageId: payload.MessageID, candidateId }, 'Phase 6 complete');

    // Phase 15: Deterministic Job ID extraction + multi-job lookup
    // Extract candidate short_ids (pure text parse — no DB query), then rewrite any
    // known-wrong ad number onto its real short_id before the lookup.
    const parsedShortIds = this.extractCandidateShortIds(payload.Subject, payload.TextBody);
    const matchedShortIds = applyShortIdAliases(parsedShortIds, this.shortIdAliases);

    let matchedJobs: Array<{
      id: string;
      title: string;
      description: string | null;
      requirements: string[];
      hiringStages: { id: string }[];
    }> = [];

    // Phase 15 job lookup + Phase 7 enrichment are wrapped so any failure here is RECORDED on
    // the intake log (status=failed + errorMessage) instead of being swallowed. Previously an
    // uncaught throw (e.g. a bad char rejected by the cv_text column) left the candidate as a
    // bare Phase-6 shell with the intake stuck at 'processing' and no error — invisible in logs.
    try {
      if (matchedShortIds.length > 0) {
        // Look up each matched job
        const jobsData = await this.prisma.job.findMany({
          where: {
            tenantId,
            shortId: { in: matchedShortIds },
            status: 'open',
          },
          select: {
            id: true,
            title: true,
            description: true,
            requirements: true,
            shortId: true,
            hiringStages: {
              where: { isEnabled: true },
              orderBy: { order: 'asc' },
              take: 1,
            },
          },
        });

        matchedJobs = jobsData;

        if (matchedJobs.length > 0) {
          this.pinoLogger.log(
            { messageId: payload.MessageID, count: matchedJobs.length },
            'Phase 15: matched jobs found',
          );
        }
      } else {
        this.pinoLogger.debug({ messageId: payload.MessageID }, 'Phase 15: no matching job short_ids');
      }

      // D3/D4: no job number resolved to an open job. Ask a small model which open job
      // this application targets, then let CODE enforce "exactly one" — the model only
      // suggests. Zero or 2+ suggestions leave the candidate in the talent pool for a
      // human, which is strictly better than a wrong pipeline placement.
      if (matchedJobs.length === 0) {
        const openJobs = await this.prisma.job.findMany({
          where: { tenantId, status: 'open' },
          select: {
            id: true,
            title: true,
            description: true,
            requirements: true,
            shortId: true,
            department: true,
            hiringStages: {
              where: { isEnabled: true },
              orderBy: { order: 'asc' },
              take: 1,
            },
          },
        });

        const suggested = await this.jobMatcher.match({
          openJobs: openJobs.map((j) => ({ shortId: j.shortId, title: j.title, department: j.department })),
          emailSubject: payload.Subject ?? null,
          emailBody: payload.TextBody ?? null,
          currentRole: extraction!.current_role ?? null,
        });

        if (suggested.length === 1) {
          const picked = openJobs.find((j) => j.shortId === suggested[0]);
          if (picked) matchedJobs = [picked];
        }

        this.pinoLogger.log(
          {
            messageId: payload.MessageID,
            candidateId: context.candidateId,
            matcher_result: suggested,
            matcher_assigned: matchedJobs.length === 1,
          },
          'Phase 15: role matcher',
        );
      }

      // For backward compatibility: set jobId/hiringStageId from first match (if any)
      // Later: Phase 7 will iterate over ALL matched jobs for multi-job scoring
      const jobId = matchedJobs.length > 0 ? matchedJobs[0].id : null;
      const hiringStageId = matchedJobs.length > 0 ? matchedJobs[0].hiringStages[0]?.id : null;

      // Phase 7: Candidate enrichment (CAND-01, D-01, D-02, D-03)
      // ALWAYS enrich candidate fields, even if no job matched — but never downgrade a
      // field that already holds data (mergeEnrichment).
      const existing = await this.prisma.candidate.findUniqueOrThrow({
        where: { id: context.candidateId },
        select: {
          jobId: true,
          hiringStageId: true,
          currentRole: true,
          yearsExperience: true,
          location: true,
          skills: true,
          cvText: true,
          cvFileUrl: true,
          aiSummary: true,
        },
      });

      const incoming: EnrichmentFields = {
        jobId,
        hiringStageId: hiringStageId ?? null,
        currentRole: extraction!.current_role ?? null,
        yearsExperience: extraction!.years_experience ?? null,
        location: extraction!.location ?? null,
        skills: extraction!.skills ?? [],
        cvText: context.cvText,
        cvFileUrl: context.fileKey, // R2 object key used as URL placeholder in Phase 1 (D-02)
        aiSummary: extraction!.ai_summary ?? null,
      };

      await this.prisma.candidate.update({
        where: { id: context.candidateId },
        data: mergeEnrichment({ ...existing, cvText: existing.cvText ?? '' }, incoming),
      });
    } catch (err) {
      this.pinoLogger.error(
        { messageId: payload.MessageID, candidateId: context.candidateId, error: (err as Error).message },
        'Phase 7 enrichment failed',
      );
      await this.prisma.emailIntakeLog.update({
        where: { idx_intake_message_id: { tenantId, messageId: payload.MessageID } },
        data: { processingStatus: 'failed', errorMessage: (err as Error).message },
      });
      throw err; // Re-throw so BullMQ records the failure (transient errors get retried)
    }

    // If no jobs were matched, skip scoring loop
    if (matchedJobs.length === 0) {
      this.pinoLogger.log({ messageId: payload.MessageID }, 'No matching jobs — skipping scoring');
      await this.prisma.emailIntakeLog.update({
        where: { idx_intake_message_id: { tenantId, messageId: payload.MessageID } },
        data: { processingStatus: 'completed' },
      });
      return;
    }

    // Phase 7: Score candidate against ALL matched jobs in parallel (SCOR-01, D-11, P3)
    // Promise.all runs N scoring calls concurrently — one per matched job.
    // Tuples (not bare numbers): the voice-screening seam below needs per-job scores.
    let jobScores: Array<{ jobId: string; score: number }>;
    try {
      jobScores = await Promise.all(
        matchedJobs.map(async (activeJob) => {
          // SCOR-02: upsert application row first — idempotent on retry
          const application = await this.prisma.application.upsert({
            where: { idx_applications_unique: { tenantId, candidateId: context.candidateId, jobId: activeJob.id } },
            create: { tenantId, candidateId: context.candidateId, jobId: activeJob.id, stage: 'new' },
            update: {}, // No-op on retry
            select: { id: true },
          });

          // SCOR-03: score candidate against this job
          const scoreResult = await this.scoringService.score({
            cvText: context.cvText,
            candidateFields: {
              currentRole: extraction!.current_role ?? null,
              yearsExperience: extraction!.years_experience ?? null,
              skills: extraction!.skills ?? [],
            },
            job: {
              title: activeJob.title,
              description: activeJob.description ?? null,
              requirements: activeJob.requirements,
            },
          } satisfies ScoringInput);

          // SCOR-04, SCOR-05: upsert — idempotent on BullMQ retry
          await this.prisma.candidateJobScore.upsert({
            where: { idx_scores_unique_per_app: { tenantId, applicationId: application.id } },
            create: {
              tenantId,
              applicationId: application.id,
              score: scoreResult.score,
              reasoning: scoreResult.reasoning,
              strengths: scoreResult.strengths,
              gaps: scoreResult.gaps,
              modelUsed: scoreResult.modelUsed,
            },
            update: {},
          });

          this.pinoLogger.log(
            {
              messageId: payload.MessageID,
              candidateId: context.candidateId,
              jobId: activeJob.id,
              score: scoreResult.score,
            },
            'Phase 7 scored',
          );

          return { jobId: activeJob.id, score: scoreResult.score };
        }),
      );
    } catch (err) {
      this.pinoLogger.error(
        { messageId: payload.MessageID, candidateId: context.candidateId, error: (err as Error).message },
        'Scoring failed for one or more jobs',
      );
      await this.prisma.emailIntakeLog.update({
        where: { idx_intake_message_id: { tenantId, messageId: payload.MessageID } },
        data: { processingStatus: 'failed', errorMessage: (err as Error).message },
      });
      throw err;
    }

    const maxAiScore = Math.max(-1, ...jobScores.map((r) => r.score));

    // Update denormalized aiScore once after all jobs scored
    // Only set if we actually scored any jobs (maxAiScore > -1)
    if (maxAiScore > -1) {
      // Skip the denormalized write when a recruiter override is sticky (TO-58).
      // Per-job CandidateJobScore rows above are still written for record-keeping.
      await this.prisma.candidate.updateMany({
        where: { id: context.candidateId, isScoreOverridden: false },
        data: { aiScore: maxAiScore },
      });
    }

    // Voice screening trigger (layers 3+4 + threshold live inside scheduleAutoCalls).
    // Non-fatal by design: a throw here must never strand the intake in 'processing'
    // or trigger a BullMQ retry that would re-run paid AI phases.
    try {
      await this.voiceCallsService.scheduleAutoCalls({
        tenantId,
        candidateId: context.candidateId,
        jobScores,
      });
    } catch (err) {
      this.pinoLogger.error(
        { messageId: payload.MessageID, candidateId: context.candidateId, error: (err as Error).message },
        'Voice screening scheduling failed — intake continues',
      );
    }

    // D-16: terminal status — set AFTER all Phase 7 work completes (only reached if no error thrown)
    await this.prisma.emailIntakeLog.update({
      where: { idx_intake_message_id: { tenantId, messageId: payload.MessageID } },
      data: { processingStatus: 'completed' },
    });

    this.pinoLogger.log({ jobId: job.id, jobName: job.name, tenantId }, 'Job completed');
  }
}
