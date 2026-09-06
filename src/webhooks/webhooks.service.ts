import { Injectable, InternalServerErrorException, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { EmailPayloadDto, fallbackMessageId, parseMessageHeaders } from './dto/mailgun-payload.dto';
import { sanitizePgText } from '../common/sanitize-pg-text';
import { StorageService } from '../storage/storage.service';

export interface IngestJobData {
  tenantId: string;
  messageId: string;
}

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('ingest-email') private readonly ingestQueue: Queue,
    private readonly configService: ConfigService,
    private readonly storageService: StorageService,
  ) {}

  async enqueue(payload: EmailPayloadDto, _files: Express.Multer.File[] = []): Promise<{ status: string }> {
    const tenantId = this.configService.get<string>('TENANT_ID')!;
    const messageId = payload.MessageID;

    const existing = await this.prisma.emailIntakeLog.findUnique({
      where: { idx_intake_message_id: { tenantId, messageId } },
      select: { processingStatus: true },
    });

    if (existing) {
      if (existing.processingStatus === 'pending') {
        // Payload already in R2 from first attempt — re-enqueue reference only
        await this.ingestQueue.add('ingest-email', { tenantId, messageId } satisfies IngestJobData, {
          jobId: messageId,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: { count: 1000 },
          removeOnFail: { count: 500 },
        });
        this.logger.log(`Re-enqueued job for MessageID: ${messageId}`);
      } else {
        this.logger.log(`Skipping duplicate MessageID: ${messageId} (status: ${existing.processingStatus})`);
      }
      return { status: 'queued' };
    }

    // Upload full payload JSON to R2 BEFORE inserting DB row.
    // If R2 upload fails → return 5xx → Mailgun retries → no orphaned DB row created.
    const rawPayloadKey = await this.storageService.uploadPayload(payload, tenantId, messageId);

    // Upload CV attachment to R2 (moved from worker Phase 5 — fixes M3 orphan risk).
    const cvFileKey = await this.storageService.upload(payload.Attachments ?? [], tenantId, messageId);

    const sanitizedPayload = this.stripAttachmentBlobs(payload);
    try {
      await this.prisma.emailIntakeLog.create({
        data: {
          tenantId,
          messageId,
          fromEmail: payload.From,
          subject: payload.Subject ?? '',
          receivedAt: new Date(payload.Date),
          processingStatus: 'pending',
          rawPayload: sanitizedPayload as object,
          rawPayloadKey,
          cvFileKey: cvFileKey ?? null,
        },
      });
    } catch (err) {
      if ((err as any)?.code === 'P2002') {
        this.logger.log(`Concurrent duplicate for MessageID: ${messageId} — skipping`);
        return { status: 'queued' };
      }
      throw err;
    }

    try {
      await this.ingestQueue.add('ingest-email', { tenantId, messageId } satisfies IngestJobData, {
        jobId: messageId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 500 },
      });
    } catch (error) {
      this.logger.error(`Failed to enqueue job for MessageID: ${messageId}`, error);
      throw new InternalServerErrorException('Failed to enqueue job');
    }

    this.logger.log(`Enqueued job for MessageID: ${messageId}`);
    return { status: 'queued' };
  }

  /**
   * The request authenticated (HMAC) but could not be parsed — a multipart limit or a schema
   * miss. Record it as a `failed` intake row and let the controller answer 200 so Mailgun stops
   * retrying an input that will never parse. Before this the email was lost with no trace.
   */
  async recordRejected(body: Record<string, unknown>, reason: string): Promise<{ status: 'rejected' }> {
    const tenantId = this.configService.get<string>('TENANT_ID')!;
    const str = (value: unknown): string => (typeof value === 'string' ? value : '');
    const headers = parseMessageHeaders(str(body['message-headers']));
    const find = (name: string) => headers.find(([n]) => n.toLowerCase() === name)?.[1];
    const headerMessageId = find('message-id')
      ?.replace(/^<|>$/g, '')
      .trim();
    const messageId =
      headerMessageId ||
      fallbackMessageId(
        { from: str(body.from), subject: str(body.subject), 'body-plain': str(body['body-plain']) },
        find('date'),
      );

    await this.prisma.emailIntakeLog.upsert({
      where: { idx_intake_message_id: { tenantId, messageId } },
      create: {
        tenantId,
        messageId,
        fromEmail: sanitizePgText(str(body.from)).slice(0, 500) || 'unknown',
        subject: sanitizePgText(str(body.subject)).slice(0, 1000),
        receivedAt: new Date(),
        processingStatus: 'failed',
        errorMessage: reason,
      },
      // A row already here means an earlier delivery of this message was accepted — never downgrade it.
      update: {},
    });
    this.logger.warn(`Rejected inbound email ${messageId}: ${reason}`);
    return { status: 'rejected' };
  }

  async checkHealth(): Promise<{ status: string; db: string; redis: string }> {
    let dbStatus = 'ok';
    let redisStatus = 'ok';

    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      dbStatus = 'error';
    }

    try {
      const client = await this.ingestQueue.client;
      await client.ping();
    } catch {
      redisStatus = 'error';
    }

    const overallStatus = dbStatus === 'ok' && redisStatus === 'ok' ? 'ok' : 'degraded';

    if (overallStatus === 'degraded') {
      throw new HttpException(
        { status: overallStatus, db: dbStatus, redis: redisStatus },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    return { status: overallStatus, db: dbStatus, redis: redisStatus };
  }

  private stripAttachmentBlobs(payload: EmailPayloadDto): Omit<EmailPayloadDto, 'Attachments'> & {
    Attachments: Omit<NonNullable<EmailPayloadDto['Attachments']>[number], 'Content'>[];
  } {
    return {
      ...payload,
      Attachments: (payload.Attachments ?? []).map(({ Content: _content, ...meta }) => meta),
    };
  }
}
