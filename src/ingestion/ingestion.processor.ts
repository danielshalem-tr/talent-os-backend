import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
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
  private readonly logger = new Logger(IngestionProcessor.name);

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
   * Extract all short_ids from combined subject + body text.
   * Searches for each active job's short_id using word boundaries.
   * Returns array of matched short_ids (may be empty).
   */
  private async extractAllJobIdsFromEmailText(
    subject: string | null | undefined,
    body: string | null | undefined,
    tenantId: string,
  ): Promise<string[]> {
    // Fetch all active jobs for this tenant (needed to get their short_ids)
    const activeJobs = await this.prisma.job.findMany({
      where: {
        tenantId,
        status: 'open', // Only search active job listings
      },
      select: {
        id: true,
        shortId: true,
      },
    });


    if (activeJobs.length === 0) {
      return [];
    }

    // Combine subject and body for searching
    const combinedText = [subject, body].filter(Boolean).join(' ').toLowerCase();

    // For each job's shortId, search with word boundaries
    const matchedShortIds: string[] = [];

    for (const job of activeJobs) {
      const cleanShortId = job.shortId.trim();
      // Use word boundaries: \b matches at word start/end
      // Escape hyphens in shortId for regex safety
      const escapedShortId = cleanShortId.replace(/[-[\]{}()*+?.\\^$|#\s]/g, '\\$&');
      const pattern = new RegExp(`(?:^|\\s|[.,!?"'])(${escapedShortId})(?:\\s|[.,!?"']|$)`, 'i');

      if (pattern.test(combinedText)) {
        matchedShortIds.push(job.shortId);
      }
    }

    return [...new Set(matchedShortIds)]; // Deduplicate in case of typos/duplicates
  }

  async process(job: Job<PostmarkPayloadDto>): Promise<void> {
    const payload = job.data;
    const tenantId = this.config.get<string>('TENANT_ID')!;

    // D-24: structured lifecycle log — pino object-first pattern
    this.pinoLogger.log(
      { jobId: job.id, jobName: job.name, tenantId },
      'Job started',
    );
    this.logger.log(`Processing job ${job.id} for MessageID: ${payload.MessageID}`);

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
      this.logger.log(`Spam filter rejected MessageID: ${payload.MessageID}`);
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

    this.logger.log(`Phase 5 complete for MessageID: ${payload.MessageID} — fileKey: ${fileKey ?? 'none'}`);

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
        this.logger.warn(
          `AI extraction failed on final attempt for ${payload.MessageID} — trying deterministic fallback`,
        );
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
          this.logger.error(
            `Both AI and deterministic extraction failed for ${payload.MessageID}: ${(fallbackErr as Error).message}`,
          );
          return; // Don't re-throw — job is permanently done (failed terminal state)
        }
      } else {
        // Non-final attempt — mark status and re-throw for BullMQ exponential backoff retry
        await this.prisma.emailIntakeLog.update({
          where: { idx_intake_message_id: { tenantId, messageId: payload.MessageID } },
          data: { processingStatus: 'failed' },
        });
        this.logger.error(
          `Extraction failed for MessageID: ${payload.MessageID} (attempt ${job.attemptsMade + 1}) — ${(err as Error).message}`,
        );
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
      this.logger.error(`Extraction returned empty fullName for MessageID: ${payload.MessageID}`);
      return;
    }

    this.logger.log(`Phase 4 complete for MessageID: ${payload.MessageID} — extracted: ${extraction!.full_name}`);

    // Phase 6: Duplicate detection + minimal candidate shell INSERT/UPSERT (atomic)
    // dedupService.check() runs OUTSIDE the transaction — read-only query, no benefit from holding lock
    const dedupResult: DedupResult | null = await this.dedupService.check(extraction!, tenantId);

    let candidateId!: string;

    try {
      await this.prisma.$transaction(async (tx) => {
        if (dedupResult && dedupResult.confidence === 1.0) {
          // Exact email match (DEDUP-02): UPSERT existing candidate — update fullName + phone only
          // source and sourceEmail are NEVER updated — first-submission ROI attribution (D-07)
          await this.dedupService.upsertCandidate(dedupResult.match.id, extraction!, tx);
          candidateId = dedupResult.match.id; // Use existing candidate ID (D-11)
        } else if (dedupResult && dedupResult.confidence < 1.0) {
          // Fuzzy name match (DEDUP-03): INSERT new candidate shell + create duplicate_flags for human review
          // Never auto-merge — DEDUP-05, D-12
          candidateId = await this.dedupService.insertCandidate(
            extraction!,
            tenantId,
            payload.From,
            tx,
            extraction!.source_hint,
          );
          await this.dedupService.createFlag(candidateId, dedupResult.match.id, dedupResult.confidence, tenantId, tx);
        } else {
          // No match (DEDUP-04): INSERT new candidate shell
          candidateId = await this.dedupService.insertCandidate(
            extraction!,
            tenantId,
            payload.From,
            tx,
            extraction!.source_hint,
          );
        }

        // D-10: Set email_intake_log.candidate_id atomically — if this fails, candidate INSERT rolls back too
        await tx.emailIntakeLog.update({
          where: { idx_intake_message_id: { tenantId, messageId: payload.MessageID } },
          data: { candidateId: candidateId! },
        });
      });
    } catch (err) {
      this.logger.error(
        `Phase 6 transaction failed for MessageID: ${payload.MessageID} — ${(err as Error).message}`,
        (err as Error).stack,
      );
      // D-24: structured lifecycle log — job failed
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

    // Pass candidateId to Phase 7 via context (D-16)
    context.candidateId = candidateId!;

    this.logger.log(`Phase 6 complete for MessageID: ${payload.MessageID} — candidateId: ${candidateId}`);

    // Phase 15: Deterministic Job ID extraction + multi-job lookup
    // Extract ALL matching short_ids from combined subject + body text
    const matchedShortIds = await this.extractAllJobIdsFromEmailText(payload.Subject, payload.TextBody, tenantId);

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
        const jobTitles = matchedJobs.map((j) => `"${j.title}"`).join(', ');
        this.logger.log(
          `Phase 15: Found ${matchedJobs.length} matching job(s) for short_ids [${matchedShortIds.join(', ')}]: ${jobTitles}`,
        );
      }
    } else {
      // No matching short_ids in email text
      this.logger.debug(`Phase 15: No matching job short_ids found in email text for MessageID: ${payload.MessageID}`);
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
      this.logger.log(`No matching jobs for MessageID: ${payload.MessageID} — skipping scoring`);
      await this.prisma.emailIntakeLog.update({
        where: { idx_intake_message_id: { tenantId, messageId: payload.MessageID } },
        data: { processingStatus: 'completed' },
      });
      return;
    }

    // Phase 7: Score candidate against ALL matched jobs (SCOR-01, D-11)
    // Loop over each matched job and create application + score record
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
        this.logger.error(
          `Scoring failed for candidateId: ${context.candidateId}, jobId: ${activeJob.id} — ${(err as Error).message}`,
        );
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

      // Update denormalized aiScore on candidate
      await this.prisma.candidate.update({
        where: { id: context.candidateId },
        data: { aiScore: scoreResult.score },
      });

      this.logger.log(
        `Phase 7 scored candidateId: ${context.candidateId} against jobId: ${activeJob.id} — score: ${scoreResult.score}`,
      );
    }

    // D-16: terminal status — set AFTER all Phase 7 work completes (only reached if no error thrown)
    await this.prisma.emailIntakeLog.update({
      where: { idx_intake_message_id: { tenantId, messageId: payload.MessageID } },
      data: { processingStatus: 'completed' },
    });

    // D-24: structured lifecycle log — job completed
    this.pinoLogger.log(
      { jobId: job.id, jobName: job.name, tenantId },
      'Job completed',
    );
    this.logger.log(`Phase 7 complete for MessageID: ${payload.MessageID} — pipeline finished`);
  }
}
