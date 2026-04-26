import { Injectable, InternalServerErrorException, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { PostmarkPayloadDto } from './dto/postmark-payload.dto';
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

  async enqueue(payload: PostmarkPayloadDto): Promise<{ status: string }> {
    const tenantId = this.configService.get<string>('TENANT_ID')!;
    const messageId = payload.MessageID;

    if (messageId === '00000000-0000-0000-0000-000000000000') {
      this.logger.log('Skipping Postmark test payload (Ping)');
      return { status: 'queued' };
    }

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
    // If R2 upload fails → return 5xx → Postmark retries → no orphaned DB row created.
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

  private stripAttachmentBlobs(payload: PostmarkPayloadDto): Omit<PostmarkPayloadDto, 'Attachments'> & {
    Attachments: Omit<NonNullable<PostmarkPayloadDto['Attachments']>[number], 'Content'>[];
  } {
    return {
      ...payload,
      Attachments: (payload.Attachments ?? []).map(({ Content: _content, ...meta }) => meta),
    };
  }
}
