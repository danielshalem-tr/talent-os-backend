import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../auth/jwt.service';
import { IngestJobData } from '../webhooks/webhooks.service';

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

@Injectable()
export class IngestControlService {
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

  async replayHeld(session: JwtPayload): Promise<{ replayed: number }> {
    this.assertCanControl(session);
    const rows = await this.prisma.emailIntakeLog.findMany({
      where: { tenantId: session.org, processingStatus: 'held' },
      select: { id: true, messageId: true },
    });

    let replayed = 0;
    for (const row of rows) {
      // Claim each row individually (held → pending). count === 0 means a concurrent
      // replay already claimed it — skip, so double-clicks can't enqueue duplicates.
      const claimed = await this.prisma.emailIntakeLog.updateMany({
        where: { id: row.id, tenantId: session.org, processingStatus: 'held' },
        data: { processingStatus: 'pending' },
      });
      if (claimed.count === 0) continue;

      try {
        // Fresh jobId — BullMQ silently ignores an add() whose jobId matches a completed
        // job still retained in Redis (removeOnComplete keeps 1000), and the original
        // held run completed under jobId === messageId.
        await this.ingestQueue.add(
          'ingest-email',
          { tenantId: session.org, messageId: row.messageId } satisfies IngestJobData,
          {
            jobId: `${row.messageId}:replay:${Date.now()}`,
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 },
            removeOnComplete: { count: 1000 },
            removeOnFail: { count: 500 },
          },
        );
      } catch (err) {
        // Enqueue failed — put the row back in 'held' so it stays visible in the queue UI
        // and the next replay picks it up. Without this it would strand in 'pending' forever
        // (Mailgun already got its 200; no webhook retry is coming).
        await this.prisma.emailIntakeLog.updateMany({
          where: { id: row.id, tenantId: session.org },
          data: { processingStatus: 'held' },
        });
        throw err;
      }
      replayed++;
    }
    return { replayed };
  }
}
