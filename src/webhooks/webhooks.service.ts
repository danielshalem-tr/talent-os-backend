import {
  Injectable,
  InternalServerErrorException,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { PostmarkPayloadDto } from './dto/postmark-payload.dto';

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('ingest-email') private readonly ingestQueue: Queue,
    private readonly configService: ConfigService,
  ) {}

  async enqueue(payload: PostmarkPayloadDto): Promise<{ status: string }> {
    const tenantId = this.configService.get<string>('TENANT_ID')!;
    const messageId = payload.MessageID;

    // Step 1: Check for existing intake log row (idempotency per D-02)
    const existing = await this.prisma.emailIntakeLog.findUnique({
      where: { idx_intake_message_id: { tenantId, messageId } },
      select: { processingStatus: true },
    });

    if (existing) {
      if (existing.processingStatus === 'pending') {
        // Enqueue failed previously — re-attempt (D-02: status=pending means retry is needed)
        await this.ingestQueue.add('ingest-email', this.stripAttachmentBlobs(payload), {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        });
        this.logger.log(`Re-enqueued job for MessageID: ${messageId}`);
      } else {
        // Already completed/failed/spam — silently return 200 (idempotent delivery)
        this.logger.log(`Skipping duplicate MessageID: ${messageId} (status: ${existing.processingStatus})`);
      }
      return { status: 'queued' };
    }

    // Step 2: INSERT intake log row BEFORE enqueueing — this IS the idempotency guard (WBHK-04)
    // If process crashes after this INSERT but before queue.add() acks,
    // a Postmark retry finds the row with status=pending and re-enqueues safely.
    const sanitizedPayload = this.stripAttachmentBlobs(payload);

    await this.prisma.emailIntakeLog.create({
      data: {
        tenantId,
        messageId,
        fromEmail: payload.From,
        subject: payload.Subject ?? '',
        receivedAt: new Date(payload.Date),
        processingStatus: 'pending',
        rawPayload: sanitizedPayload as object,
      },
    });

    // Step 3: Enqueue to BullMQ — if this fails, return 5xx so Postmark retries (D-01)
    try {
      await this.ingestQueue.add('ingest-email', sanitizedPayload, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      });
    } catch (error) {
      this.logger.error(`Failed to enqueue job for MessageID: ${messageId}`, error);
      // D-01: return 5xx — Postmark will retry on non-2xx, and next delivery finds
      // the pending row and re-enqueues it
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

  private stripAttachmentBlobs(
    payload: PostmarkPayloadDto,
  ): Omit<PostmarkPayloadDto, 'Attachments'> & {
    Attachments: Omit<NonNullable<PostmarkPayloadDto['Attachments']>[number], 'Content'>[];
  } {
    return {
      ...payload,
      // D-03: strip only Content (binary blob); preserve Name, ContentType, ContentLength
      Attachments: (payload.Attachments ?? []).map(({ Content: _content, ...meta }) => meta),
    };
  }
}
