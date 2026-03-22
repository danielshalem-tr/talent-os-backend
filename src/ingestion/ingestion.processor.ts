import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { PostmarkPayloadDto } from '../webhooks/dto/postmark-payload.dto';
import { SpamFilterService } from './services/spam-filter.service';
import { AttachmentExtractorService } from './services/attachment-extractor.service';

export interface ProcessingContext {
  fullText: string;
  suspicious: boolean;
}

@Processor('ingest-email')
export class IngestionProcessor extends WorkerHost {
  private readonly logger = new Logger(IngestionProcessor.name);

  constructor(
    private readonly spamFilter: SpamFilterService,
    private readonly attachmentExtractor: AttachmentExtractorService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
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

    // Phase 3 output — ProcessingContext passed to Phase 4 inline (same processor method)
    // Phase 4 will use: { fullText, suspicious: filterResult.suspicious }
    const _context: ProcessingContext = {
      fullText,
      suspicious: filterResult.suspicious,
    };

    // Phase 4 stub — AI extraction will be implemented in Phase 4
    this.logger.log(
      `Phase 3 complete for MessageID: ${payload.MessageID} ` +
        `(${fullText.length} chars, suspicious: ${filterResult.suspicious})`,
    );
  }
}
