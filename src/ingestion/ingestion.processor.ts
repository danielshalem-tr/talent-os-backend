import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { PostmarkPayloadDto } from '../webhooks/dto/postmark-payload.dto';
import { SpamFilterService } from './services/spam-filter.service';
import { AttachmentExtractorService } from './services/attachment-extractor.service';
import { ExtractionAgentService, CandidateExtract } from './services/extraction-agent.service';
import { StorageService } from '../storage/storage.service';

export interface ProcessingContext {
  fullText: string;
  suspicious: boolean;
  fileKey: string | null;  // R2 object key (D-04) or null if no CV attachment found
  cvText: string;          // Phase 3 extracted text — written to candidates.cv_text in Phase 7
}

@Processor('ingest-email')
export class IngestionProcessor extends WorkerHost {
  private readonly logger = new Logger(IngestionProcessor.name);

  constructor(
    private readonly spamFilter: SpamFilterService,
    private readonly attachmentExtractor: AttachmentExtractorService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly extractionAgent: ExtractionAgentService,
    private readonly storageService: StorageService,
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
    const attachmentText = await this.attachmentExtractor.extract(
      payload.Attachments ?? [],
    );

    // Build fullText: email body first, then attachment sections (D-02)
    const bodySection = payload.TextBody?.trim()
      ? `--- Email Body ---\n${payload.TextBody.trim()}`
      : '';

    const fullText = [bodySection, attachmentText]
      .filter(Boolean)
      .join('\n\n');

    // Phase 3 output — passed to Phase 4 inline
    const context: ProcessingContext = {
      fullText,
      suspicious: filterResult.suspicious,
      fileKey: null,    // populated after Phase 5 upload below
      cvText: fullText, // same as fullText — alias for Phase 7 clarity
    };

    // Phase 5: Upload original CV to Cloudflare R2 BEFORE AI extraction (D-07: errors propagate to BullMQ, no catch)
    // BUG-CV-LOSS fix: upload must happen before extraction so the file is persisted even if AI fails
    const fileKey = await this.storageService.upload(
      payload.Attachments ?? [],
      tenantId,
      payload.MessageID,
    );
    context.fileKey = fileKey;
    context.cvText = fullText;

    this.logger.log(
      `Phase 5 complete for MessageID: ${payload.MessageID} — fileKey: ${fileKey ?? 'none'}`,
    );

    // Phase 4: AI extraction (D-06 mock — real call activated in follow-up task)
    let extraction: CandidateExtract;
    try {
      extraction = await this.extractionAgent.extract(
        context.fullText,
        context.suspicious,
      );
    } catch (err) {
      // D-04: extraction failure → mark as failed, do not insert placeholder
      await this.prisma.emailIntakeLog.update({
        where: {
          idx_intake_message_id: { tenantId, messageId: payload.MessageID },
        },
        data: { processingStatus: 'failed' },
      });
      this.logger.error(
        `Extraction failed for MessageID: ${payload.MessageID} — ${(err as Error).message}`,
      );
      // BUG-RETRY fix: re-throw so BullMQ sees a failure and retries via exponential backoff
      throw err;
    }

    // D-04, D-05: empty fullName is treated the same as extraction failure (permanent — do not retry)
    if (!extraction.fullName?.trim()) {
      await this.prisma.emailIntakeLog.update({
        where: {
          idx_intake_message_id: { tenantId, messageId: payload.MessageID },
        },
        data: { processingStatus: 'failed' },
      });
      this.logger.error(
        `Extraction returned empty fullName for MessageID: ${payload.MessageID}`,
      );
      return;
    }

    this.logger.log(
      `Phase 4 complete for MessageID: ${payload.MessageID} — extracted: ${extraction.fullName}`,
    );
    // Phase 6 stub — duplicate detection will be implemented in Phase 6
  }
}
