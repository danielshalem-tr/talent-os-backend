import { ConflictException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../auth/jwt.service';
import { IngestJobData } from '../webhooks/webhooks.service';
import { INGEST_JOB_NAME, INGEST_JOB_OPTS, ingestReplayJobId } from '../ingestion/ingest-queue';

export interface IngestControlStatus {
  ai_ingest_enabled: boolean;
  held_count: number;
}

export interface HeldEmailRow {
  id: string;
  from_email: string;
  subject: string | null;
  received_at: string;
}

const CONTROL_ROLES: JwtPayload['role'][] = ['owner', 'admin'];

/** One HTTP call replays at most this many rows (oldest first); the UI calls again while held_count > 0. */
export const REPLAY_BATCH_SIZE = 200;

@Injectable()
export class IngestControlService {
  private readonly logger = new Logger(IngestControlService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('ingest-email') private readonly ingestQueue: Queue,
  ) {}

  private assertCanControl(session: JwtPayload): void {
    // Inline role enforcement (D-18 pattern) — pausing/resuming spend is an admin action
    if (!CONTROL_ROLES.includes(session.role)) {
      throw new ForbiddenException('Only owners and admins can control ingest');
    }
  }

  async getStatus(session: JwtPayload): Promise<IngestControlStatus> {
    const [org, heldCount] = await Promise.all([
      this.prisma.organization.findUniqueOrThrow({
        where: { id: session.org },
        select: { aiIngestEnabled: true },
      }),
      this.prisma.emailIntakeLog.count({
        where: { tenantId: session.org, processingStatus: 'held' },
      }),
    ]);
    return { ai_ingest_enabled: org.aiIngestEnabled, held_count: heldCount };
  }

  async setEnabled(session: JwtPayload, enabled: boolean): Promise<IngestControlStatus> {
    this.assertCanControl(session);
    const org = await this.prisma.organization.update({
      where: { id: session.org },
      data: { aiIngestEnabled: enabled },
      select: { aiIngestEnabled: true },
    });
    const heldCount = await this.prisma.emailIntakeLog.count({
      where: { tenantId: session.org, processingStatus: 'held' },
    });
    return { ai_ingest_enabled: org.aiIngestEnabled, held_count: heldCount };
  }

  async listHeld(session: JwtPayload): Promise<{ held: HeldEmailRow[] }> {
    const rows = await this.prisma.emailIntakeLog.findMany({
      where: { tenantId: session.org, processingStatus: 'held' },
      orderBy: { receivedAt: 'desc' },
      select: { id: true, fromEmail: true, subject: true, receivedAt: true, messageId: true },
    });
    return {
      held: rows.map((r) => ({
        id: r.id,
        from_email: r.fromEmail,
        subject: r.subject,
        received_at: r.receivedAt.toISOString(),
      })),
    };
  }

  async replayHeld(session: JwtPayload): Promise<{ replayed: number; failed: number }> {
    this.assertCanControl(session);

    const org = await this.prisma.organization.findUniqueOrThrow({
      where: { id: session.org },
      select: { aiIngestEnabled: true },
    });
    if (!org.aiIngestEnabled) {
      // The worker's gate would hold every replayed row again within seconds — a "successful"
      // replay that changes nothing. The agent card enables first, then replays.
      throw new ConflictException({ code: 'INGEST_PAUSED', message: 'Resume ingest before replaying held emails' });
    }

    const rows = await this.prisma.emailIntakeLog.findMany({
      where: { tenantId: session.org, processingStatus: 'held' },
      select: { id: true, messageId: true },
      orderBy: { receivedAt: 'asc' },
      take: REPLAY_BATCH_SIZE,
    });

    let replayed = 0;
    let failed = 0;
    for (const row of rows) {
      // Claim each row individually (held → pending). count === 0 means a concurrent replay
      // already claimed it — skip, so double-clicks can't enqueue duplicates.
      const claimed = await this.prisma.emailIntakeLog.updateMany({
        where: { id: row.id, tenantId: session.org, processingStatus: 'held' },
        data: { processingStatus: 'pending' },
      });
      if (claimed.count === 0) continue;

      // Fresh id — BullMQ ignores add() for an id retained in ANY set, and the held run
      // completed under the deterministic id.
      const jobId = ingestReplayJobId(session.org, row.messageId);
      try {
        await this.ingestQueue.add(
          INGEST_JOB_NAME,
          { tenantId: session.org, messageId: row.messageId } satisfies IngestJobData,
          { ...INGEST_JOB_OPTS, jobId },
        );
        replayed += 1;
      } catch (err) {
        // add() can reject AFTER Redis accepted the job (socket closed on the reply). Reverting
        // the claim then would leave a live job pointed at a 'held' row and replay it twice.
        const accepted = await this.ingestQueue.getJob(jobId).catch(() => null);
        if (accepted) {
          replayed += 1;
          continue;
        }
        // Put the row back in 'held' so it stays visible in the queue UI and the next replay
        // picks it up. Without this it would strand in 'pending' forever (Mailgun already got
        // its 200; no webhook retry is coming).
        await this.prisma.emailIntakeLog.updateMany({
          where: { id: row.id, tenantId: session.org, processingStatus: 'pending' },
          data: { processingStatus: 'held' },
        });
        failed += 1;
        this.logger.error(`Replay enqueue failed for intake ${row.id}: ${(err as Error).message}`);
      }
    }
    return { replayed, failed };
  }
}
