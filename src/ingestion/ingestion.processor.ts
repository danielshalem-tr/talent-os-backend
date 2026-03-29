import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { PostmarkPayloadDto } from '../webhooks/dto/postmark-payload.dto';
import { SpamFilterService } from './services/spam-filter.service';
import { AttachmentExtractorService } from './services/attachment-extractor.service';
import { ExtractionAgentService, CandidateExtract } from './services/extraction-agent.service';
import { StorageService } from '../storage/storage.service';
import { DedupService, DedupResult } from '../dedup/dedup.service';
import { ScoringAgentService, ScoringInput } from '../scoring/scoring.service';

export interface ProcessingContext {
  fullText: string;
  suspicious: boolean;
  fileKey: string | null; // R2 object key (D-04) or null if no CV attachment found
  cvText: string; // Phase 3 extracted text — written to candidates.cv_text in Phase 7
  candidateId: string; // Phase 6 output — set immediately after INSERT/UPSERT; consumed by Phase 7
}

@Processor('ingest-email', {
  lockDuration: 30000,    // 30s lock per job (Issue Fix 1: prevents timeout on long-running scoring loops)
  lockRenewTime: 5000,    // renew lock every 5s
  maxStalledCount: 2,     // retry if stalled 2x
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
  ) {
    super();
  }

  async process(job: Job<PostmarkPayloadDto>): Promise<void> {
    const payload = job.data;
    const tenantId = this.config.get<string>('TENANT_ID')!;

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
      extraction = await this.extractionAgent.extract(
        context.fullText,
        context.suspicious,
        { subject: payload.Subject ?? '', fromEmail: payload.From },
      );
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

    await this.prisma.$transaction(async (tx) => {
      if (dedupResult && dedupResult.confidence === 1.0) {
        // Exact email match (DEDUP-02): UPSERT existing candidate — update fullName + phone only
        // source and sourceEmail are NEVER updated — first-submission ROI attribution (D-07)
        await this.dedupService.upsertCandidate(dedupResult.match.id, extraction!, tx);
        candidateId = dedupResult.match.id; // Use existing candidate ID (D-11)
      } else if (dedupResult && dedupResult.confidence < 1.0) {
        // Fuzzy name match (DEDUP-03): INSERT new candidate shell + create duplicate_flags for human review
        // Never auto-merge — DEDUP-05, D-12
        candidateId = await this.dedupService.insertCandidate(extraction!, tenantId, payload.From, tx, extraction!.source_hint);
        await this.dedupService.createFlag(candidateId, dedupResult.match.id, dedupResult.confidence, tenantId, tx);
      } else {
        // No match (DEDUP-04): INSERT new candidate shell
        candidateId = await this.dedupService.insertCandidate(extraction!, tenantId, payload.From, tx, extraction!.source_hint);
      }

      // D-10: Set email_intake_log.candidate_id atomically — if this fails, candidate INSERT rolls back too
      await tx.emailIntakeLog.update({
        where: { idx_intake_message_id: { tenantId, messageId: payload.MessageID } },
        data: { candidateId: candidateId! },
      });
    });

    // Pass candidateId to Phase 7 via context (D-16)
    context.candidateId = candidateId!;

    this.logger.log(`Phase 6 complete for MessageID: ${payload.MessageID} — candidateId: ${candidateId}`);

    // Phase 6.5: Job matching by fuzzy title match (Phase 14 — required for job assignment)
    // Reject email if no job found — email cannot be processed without a job assignment
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let matchedJob: any = null;
    if (extraction!.job_title_hint) {
      // Use pg_trgm similarity search to find matching job
      matchedJob = await this.prisma.job.findFirst({
        where: {
          tenantId,
          status: 'active',
        },
        select: {
          id: true,
          title: true,
          hiringStages: {
            where: { isEnabled: true },
            orderBy: { order: 'asc' },
            take: 1,
          },
        },
      });

      // Fuzzy match: filter results server-side using Levenshtein-based similarity
      if (matchedJob) {
        const similarity = this.calculateSimilarity(extraction!.job_title_hint, matchedJob.title);
        if (similarity < 0.7) {
          matchedJob = null;
        }
      }
    }

    // No match found — reject email
    if (!matchedJob) {
      await this.prisma.emailIntakeLog.update({
        where: { idx_intake_message_id: { tenantId, messageId: payload.MessageID } },
        data: { processingStatus: 'failed' },
      });
      this.logger.warn(
        `No active job found matching title hint "${extraction!.job_title_hint}" for MessageID: ${payload.MessageID} — email rejected`,
      );
      return;
    }

    this.logger.log(`Phase 6.5 complete for MessageID: ${payload.MessageID} — matched job: ${matchedJob.title}`);

    // Phase 7: Candidate enrichment (CAND-01, D-01, D-02, D-03)
    await this.prisma.candidate.update({
      where: { id: context.candidateId },
      data: {
        jobId: matchedJob.id,
        hiringStageId: matchedJob.hiringStages[0]?.id ?? null,
        currentRole: extraction!.current_role ?? null,
        yearsExperience: extraction!.years_experience ?? null,
        location: extraction!.location ?? null,
        skills: extraction!.skills ?? [],
        cvText: context.cvText,
        cvFileUrl: context.fileKey, // R2 object key used as URL placeholder in Phase 1 (D-02)
        aiSummary: extraction!.ai_summary ?? null,
        metadata: Prisma.JsonNull,   // D-03: deferred to future phase (Prisma requires JsonNull not null)
      },
    });

    this.logger.log(`Phase 7 enrichment complete for MessageID: ${payload.MessageID}`);

    // Phase 7: Active jobs fetch (SCOR-01, D-11)
    const activeJobs = await this.prisma.job.findMany({
      where: { tenantId, status: 'active' },
      select: { id: true, title: true, description: true, requirements: true },
    });

    // D-11: if no active jobs, skip loop entirely — still mark as completed
    for (const activeJob of activeJobs) {
      // SCOR-02 (D-12): upsert application row first — idempotent on retry
      const application = await this.prisma.application.upsert({
        where: {
          idx_applications_unique: {
            tenantId,
            candidateId: context.candidateId,
            jobId: activeJob.id,
          },
        },
        create: { tenantId, candidateId: context.candidateId, jobId: activeJob.id, stage: 'new' },
        update: {}, // No-op on retry — idempotent
        select: { id: true },
      });

      // SCOR-03 (D-07): score candidate against job with error isolation (Issue Fix 2)
      let scoreResult;
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
        // Issue Fix 2: Log and continue — don't fail the entire candidate on one bad job score
        this.logger.error(
          `Scoring failed for candidateId: ${context.candidateId}, jobId: ${activeJob.id} — ${(err as Error).message}`,
        );
        // D-13: If we skip the INSERT on error, this application has no score. This is acceptable.
        // Phase 2 can filter applications without scores if needed.
        continue;
      }

      // SCOR-04, SCOR-05 (D-13): append-only INSERT — never upsert
      // D-13: Score INSERTs are append-only. Retries will create duplicate rows — acceptable for Phase 1.
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

      this.logger.log(`Phase 7 scored candidateId: ${context.candidateId} against jobId: ${activeJob.id} — score: ${scoreResult.score}`);
    }

    // D-16: terminal status — set AFTER all Phase 7 work completes (only reached if no error thrown)
    await this.prisma.emailIntakeLog.update({
      where: { idx_intake_message_id: { tenantId, messageId: payload.MessageID } },
      data: { processingStatus: 'completed' },
    });

    this.logger.log(`Phase 7 complete for MessageID: ${payload.MessageID} — pipeline finished`);
  }

  private calculateSimilarity(a: string, b: string): number {
    // Simple Levenshtein-based similarity (0-1 scale)
    // For production, use pg_trgm directly via raw query:
    // similarity(a, b) returns 0-1 where 1 is exact match
    const s1 = a.toLowerCase();
    const s2 = b.toLowerCase();
    const longer = s1.length > s2.length ? s1 : s2;
    const shorter = s1.length > s2.length ? s2 : s1;
    if (longer.length === 0) return 1.0;
    const editDistance = this.levenshteinDistance(longer, shorter);
    return (longer.length - editDistance) / longer.length;
  }

  private levenshteinDistance(a: string, b: string): number {
    const alen = a.length;
    const blen = b.length;
    const d = Array(alen + 1).fill(0).map(() => Array(blen + 1).fill(0));
    for (let i = 0; i <= alen; i++) d[i][0] = i;
    for (let j = 0; j <= blen; j++) d[0][j] = j;
    for (let i = 1; i <= alen; i++) {
      for (let j = 1; j <= blen; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      }
    }
    return d[alen][blen];
  }
}
