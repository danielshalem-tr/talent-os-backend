import { Injectable, InternalServerErrorException, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EmailPayloadDto, fallbackMessageId, parseMessageHeaders } from './dto/mailgun-payload.dto';
import { sanitizePgText } from '../common/sanitize-pg-text';
import { StorageService } from '../storage/storage.service';
import { INGEST_JOB_NAME, INGEST_JOB_OPTS, ingestJobId, ingestReplayJobId } from '../ingestion/ingest-queue';

export interface IngestJobData {
  tenantId: string;
  messageId: string;
}

/**
 * What `email_intake_log.raw_payload` keeps: routing metadata only. The complete payload
 * (bodies, base64 attachments) lives once, in R2 at `raw_payload_key`. Bodies used to be
 * duplicated here as JSONB on the hottest table for no reader that could not use R2.
 */
export function intakeMetadata(payload: EmailPayloadDto): Prisma.InputJsonObject {
  return {
    MessageID: payload.MessageID,
    From: payload.From,
    FromName: payload.FromName ?? null,
    Subject: payload.Subject ?? '',
    Date: payload.Date,
    Attachments: (payload.Attachments ?? []).map(({ Name, ContentType, ContentLength, ContentID }) => ({
      Name,
      ContentType,
      ContentLength,
      ContentID: ContentID ?? null,
    })),
  };
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

  async enqueue(payload: EmailPayloadDto, files: Express.Multer.File[] = []): Promise<{ status: string }> {
    const tenantId = this.configService.get<string>('TENANT_ID')!;
    const messageId = payload.MessageID;

    const existing = await this.prisma.emailIntakeLog.findUnique({
      where: { idx_intake_message_id: { tenantId, messageId } },
      select: { processingStatus: true },
    });

    if (existing) {
      if (existing.processingStatus === 'pending') {
        // Payload already in R2 from the first attempt — make sure exactly one job is live.
        const outcome = await this.ensureEnqueued(tenantId, messageId);
        this.logger.log(`Redelivery for MessageID ${messageId}: ${outcome}`);
      } else {
        this.logger.log(`Skipping duplicate MessageID: ${messageId} (status: ${existing.processingStatus})`);
      }
      return { status: 'queued' };
    }

    // Upload full payload JSON to R2 BEFORE inserting DB row.
    // If R2 upload fails → return 5xx → Mailgun retries → no orphaned DB row created.
    const rawPayloadKey = await this.storageService.uploadPayload(payload, tenantId, messageId);

    // CV to R2 from the ORIGINAL multer buffers — no base64 → Buffer re-decode of a 10 MB file.
    const cvFileKey = await this.storageService.upload(
      payload.Attachments ?? [],
      tenantId,
      messageId,
      files.map((file) => file.buffer),
    );

    try {
      await this.prisma.emailIntakeLog.create({
        data: {
          tenantId,
          messageId,
          fromEmail: payload.From,
          subject: payload.Subject ?? '',
          receivedAt: new Date(payload.Date),
          processingStatus: 'pending',
          rawPayload: intakeMetadata(payload),
          rawPayloadKey,
          cvFileKey: cvFileKey ?? null,
        },
      });
    } catch (err) {
      if ((err as { code?: string })?.code === 'P2002') {
        // Lost a race with a concurrent delivery of the same message. The winner owns the row;
        // converge on the same job id so the message is processed exactly once either way.
        this.logger.log(`Concurrent duplicate for MessageID: ${messageId} — converging on the existing row`);
        await this.ensureEnqueued(tenantId, messageId);
        return { status: 'queued' };
      }
      throw err;
    }

    try {
      await this.ensureEnqueued(tenantId, messageId);
    } catch (error) {
      this.logger.error(`Failed to enqueue job for MessageID: ${messageId}`, error);
      throw new InternalServerErrorException('Failed to enqueue job');
    }

    this.logger.log(`Enqueued job for MessageID: ${messageId}`);
    return { status: 'queued' };
  }

  /**
   * Exactly one live job per message. BullMQ silently ignores add() for an id that exists in ANY
   * retained set — including failed (removeOnFail keeps 500) — which is precisely the state a
   * `pending` row is in when its job burned every attempt before the first status write.
   */
  private async ensureEnqueued(tenantId: string, messageId: string): Promise<'added' | 'retried' | 'already-queued'> {
    const data = { tenantId, messageId } satisfies IngestJobData;
    const jobId = ingestJobId(tenantId, messageId);
    const existingJob = await this.ingestQueue.getJob(jobId);
    if (!existingJob) {
      await this.ingestQueue.add(INGEST_JOB_NAME, data, { ...INGEST_JOB_OPTS, jobId });
      return 'added';
    }
    if (await existingJob.isFailed()) {
      await existingJob.retry();
      return 'retried';
    }
    if (await existingJob.isCompleted()) {
      await this.ingestQueue.add(INGEST_JOB_NAME, data, {
        ...INGEST_JOB_OPTS,
        jobId: ingestReplayJobId(tenantId, messageId),
      });
      return 'added';
    }
    return 'already-queued';
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
}
