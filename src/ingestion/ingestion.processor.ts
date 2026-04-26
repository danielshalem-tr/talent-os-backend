import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger as PinoLogger } from 'nestjs-pino';
import { Prisma } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { PostmarkPayloadDto } from '../webhooks/dto/postmark-payload.dto';
import { SpamFilterService } from './services/spam-filter.service';
import { AttachmentExtractorService } from './services/attachment-extractor.service';
import { ExtractionAgentService, CandidateExtract } from './services/extraction-agent.service';
import { StorageService } from '../storage/storage.service';
import { DedupService, DedupResult } from '../dedup/dedup.service';
import { ScoringAgentService, ScoringInput, ScoreResult } from '../scoring/scoring.service';

export interface ProcessingContext {
  fullText: string;
  suspicious: boolean;
  fileKey: string | null; // R2 object key (D-04) or null if no CV attachment found
  cvText: string; // Phase 3 extracted text — written to candidates.cv_text in Phase 7
  candidateId: string; // Phase 6 output — set immediately after INSERT/UPSERT; consumed by Phase 7
}

@Processor('ingest-email', {
  lockDuration: 30000, // 30s lock per job (Issue Fix 1: prevents timeout on long-running scoring loops)
  lockRenewTime: 5000, // renew lock every 5s
  maxStalledCount: 2, // retry if stalled 2x
})
export class IngestionProcessor extends WorkerHost {
  constructor(
    private readonly spamFilter: SpamFilterService,
    private readonly attachmentExtractor: AttachmentExtractorService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly extractionAgent: ExtractionAgentService,
    private readonly storageService: StorageService,
    private readonly dedupService: DedupService,
    private readonly scoringService: ScoringAgentService,
    private readonly pinoLogger: PinoLogger,
  ) {
    super();
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

  async process(job: Job<PostmarkPayloadDto>): Promise<void> {
    const payload = job.data;
    const tenantId = this.config.get<string>('TENANT_ID')!;

    this.pinoLogger.log({ jobId: job.id, jobName: job.name, tenantId }, 'Job started');
    this.pinoLogger.log({ jobId: job.id, messageId: payload.MessageID }, 'Job processing started');

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

    const fullText = [bodySection, attachmentText].filter(Boolean).join('\n\n');

    // Phase 3 output — passed to Phase 4 inline
    const context: ProcessingContext = {
      fullText,
      suspicious: filterResult.suspicious,
      fileKey: null, // populated after Phase 5 upload below
      cvText: fullText, // same as fullText — alias for Phase 7 clarity
      candidateId: '', // set by Phase 6 below
    };

    // Phase 5: Upload original CV to Cloudflare R2 BEFORE AI extraction (D-07: errors propagate to BullMQ, no catch)
    // BUG-CV-LOSS fix: upload must happen before extraction so the file is persisted even if AI fails
    const fileKey = await this.storageService.upload(payload.Attachments ?? [], tenantId, payload.MessageID);
    context.fileKey = fileKey;
    context.cvText = fullText;

    this.pinoLogger.log({ messageId: payload.MessageID, fileKey: fileKey ?? null }, 'Phase 5 complete');

    // Phase 4: AI extraction — passes metadata for context (Phase 14: metadata enables source_hint detection)
    let extraction: CandidateExtract;
    try {
      extraction = await this.extractionAgent.extract(context.fullText, context.suspicious, {
        subject: payload.Subject ?? '',
        fromEmail: payload.From,
      });
    } catch (err) {
      // Final attempt: try deterministic extraction as last resort before marking failed
      if (job.attemptsMade >= (job.opts?.attempts ?? 3) - 1) {
        this.pinoLogger.warn({ messageId: payload.MessageID }, 'AI extraction failed on final attempt — trying deterministic fallback');
        try {
          const deterministicResult = this.extractionAgent.extractDeterministically(context.fullText);
          extraction = {
            ...deterministicResult,
            suspicious: context.suspicious,
            source_hint: null,
          };
          // Don't throw — continue with partial data from deterministic extraction
        } catch (fallbackErr) {
          // Even deterministic failed — mark as permanently failed, don't retry
          await this.prisma.emailIntakeLog.update({
            where: { idx_intake_message_id: { tenantId, messageId: payload.MessageID } },
            data: { processingStatus: 'failed' },
          });
          this.pinoLogger.error({ messageId: payload.MessageID, error: (fallbackErr as Error).message }, 'Both AI and deterministic extraction failed');
          return; // Don't re-throw — job is permanently done (failed terminal state)
        }
      } else {
        // Non-final attempt — mark status and re-throw for BullMQ exponential backoff retry
        await this.prisma.emailIntakeLog.update({
          where: { idx_intake_message_id: { tenantId, messageId: payload.MessageID } },
          data: { processingStatus: 'failed' },
        });
        this.pinoLogger.error({ messageId: payload.MessageID, attempt: job.attemptsMade + 1, error: (err as Error).message }, 'Extraction failed');
        throw err;
      }
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
    const existingIntake = await this.prisma.emailIntakeLog.findUnique({
      where: { idx_intake_message_id: { tenantId, messageId: payload.MessageID } },
      select: { candidateId: true },
    });

    let candidateId!: string;

    if (existingIntake?.candidateId) {
      this.pinoLogger.log({ messageId: payload.MessageID, candidateId: existingIntake.candidateId }, 'Idempotency guard: skipping Phase 6');
      candidateId = existingIntake.candidateId;
    } else {
      try {
        await this.prisma.$transaction(async (tx) => {
          // Advisory lock: serialize concurrent workers processing the same phone
          // Lock is automatically released when the transaction commits/rollbacks
          if (extraction!.phone?.trim()) {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${extraction!.phone}))`;
          }

          // Dedup check — now INSIDE the transaction, protected by advisory lock
          let dedupResult: DedupResult | null = null;
          try {
            dedupResult = await this.dedupService.check(extraction!, tenantId, tx);
          } catch (err) {
            this.pinoLogger.error({ messageId: payload.MessageID, error: (err as Error).message }, 'Dedup check failed');
            throw err; // Transaction will rollback
          }

          if (dedupResult === null) {
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
        this.pinoLogger.error({ messageId: payload.MessageID, error: (err as Error).message }, 'Phase 6 transaction failed');
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
    // Extract candidate short_ids (pure text parse — no DB query)
    const matchedShortIds = this.extractCandidateShortIds(payload.Subject, payload.TextBody);

    let matchedJobs: Array<{
      id: string;
      title: string;
      description: string | null;
      requirements: string[];
      hiringStages: { id: string }[];
    }> = [];

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
        this.pinoLogger.log({ messageId: payload.MessageID, count: matchedJobs.length }, 'Phase 15: matched jobs found');
      }
    } else {
      this.pinoLogger.debug({ messageId: payload.MessageID }, 'Phase 15: no matching job short_ids');
    }

    // For backward compatibility: set jobId/hiringStageId from first match (if any)
    // Later: Phase 7 will iterate over ALL matched jobs for multi-job scoring
    const jobId = matchedJobs.length > 0 ? matchedJobs[0].id : null;
    const hiringStageId = matchedJobs.length > 0 ? matchedJobs[0].hiringStages[0]?.id : null;

    // Phase 7: Candidate enrichment (CAND-01, D-01, D-02, D-03)
    // ALWAYS enrich candidate fields, even if no job matched
    await this.prisma.candidate.update({
      where: { id: context.candidateId },
      data: {
        jobId,
        hiringStageId,
        currentRole: extraction!.current_role ?? null,
        yearsExperience: extraction!.years_experience ?? null,
        location: extraction!.location ?? null,
        skills: extraction!.skills ?? [],
        cvText: context.cvText,
        cvFileUrl: context.fileKey, // R2 object key used as URL placeholder in Phase 1 (D-02)
        aiSummary: extraction!.ai_summary ?? null,
        metadata: Prisma.JsonNull, // D-03: deferred to future phase (Prisma requires JsonNull not null)
      },
    });

    // If no jobs were matched, skip scoring loop
    if (matchedJobs.length === 0) {
      this.pinoLogger.log({ messageId: payload.MessageID }, 'No matching jobs — skipping scoring');
      await this.prisma.emailIntakeLog.update({
        where: { idx_intake_message_id: { tenantId, messageId: payload.MessageID } },
        data: { processingStatus: 'completed' },
      });
      return;
    }

    // Phase 7: Score candidate against ALL matched jobs (SCOR-01, D-11)
    // Loop over each matched job and create application + score record
    // Track MAX score across all jobs for denormalized aiScore field
    let maxAiScore = -1;

    for (const activeJob of matchedJobs) {
      // SCOR-02: upsert application row first — idempotent on retry
      const application = await this.prisma.application.upsert({
        where: {
          idx_applications_unique: {
            tenantId,
            candidateId: context.candidateId,
            jobId: activeJob.id,
          },
        },
        create: { tenantId, candidateId: context.candidateId, jobId: activeJob.id, stage: 'new' },
        update: {}, // No-op on retry
        select: { id: true },
      });

      // SCOR-03: score candidate against this job
      let scoreResult: ScoreResult & { modelUsed: string };
      try {
        scoreResult = await this.scoringService.score({
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
      } catch (err) {
        this.pinoLogger.error({ messageId: payload.MessageID, candidateId: context.candidateId, jobId: activeJob.id, error: (err as Error).message }, 'Scoring failed');
        // Mark intake as failed if scoring fails for ANY matched job
        await this.prisma.emailIntakeLog.update({
          where: { idx_intake_message_id: { tenantId, messageId: payload.MessageID } },
          data: { processingStatus: 'failed', errorMessage: (err as Error).message },
        });
        throw err;
      }

      // SCOR-04, SCOR-05: append-only INSERT
      await this.prisma.candidateJobScore.create({
        data: {
          tenantId,
          applicationId: application.id,
          score: scoreResult.score,
          reasoning: scoreResult.reasoning,
          strengths: scoreResult.strengths,
          gaps: scoreResult.gaps,
          modelUsed: scoreResult.modelUsed,
        },
      });

      // Track maximum score across all jobs for denormalized aiScore
      // (C-5 fix: prevents race condition from repeated updates in loop)
      maxAiScore = Math.max(maxAiScore, scoreResult.score);

      this.pinoLogger.log({ messageId: payload.MessageID, candidateId: context.candidateId, jobId: activeJob.id, score: scoreResult.score }, 'Phase 7 scored');
    }

    // Update denormalized aiScore once after all jobs scored
    // Only set if we actually scored any jobs (maxAiScore > -1)
    if (maxAiScore > -1) {
      await this.prisma.candidate.update({
        where: { id: context.candidateId },
        data: { aiScore: maxAiScore },
      });
    }

    // D-16: terminal status — set AFTER all Phase 7 work completes (only reached if no error thrown)
    await this.prisma.emailIntakeLog.update({
      where: { idx_intake_message_id: { tenantId, messageId: payload.MessageID } },
      data: { processingStatus: 'completed' },
    });

    this.pinoLogger.log({ jobId: job.id, jobName: job.name, tenantId }, 'Job completed');
  }
}
