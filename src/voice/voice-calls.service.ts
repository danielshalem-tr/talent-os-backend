import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { VoiceCall } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../auth/jwt.service';
import { StorageService } from '../storage/storage.service';
import { ElevenLabsGatewayService } from './elevenlabs-gateway.service';
import { nextBusinessWindowSlot } from './call-window';

export interface VoiceCallJobData {
  voiceCallId: string;
}

// Shared BullMQ enqueue options (mirrors webhooks.service.ts:82-88).
export const VOICE_JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 500 },
};

export const ACTIVE_CALL_STATUSES = ['scheduled', 'calling', 'in_progress'] as const;
const CONTROL_ROLES: JwtPayload['role'][] = ['owner', 'admin'];
const CALLER_FORBIDDEN_ROLES: JwtPayload['role'][] = ['viewer'];
export const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 4 * 60 * 60 * 1000; // 4 hours, then snapped into the business window

export interface VoiceCallResponse {
  id: string;
  job_id: string;
  job_title: string | null;
  status: string;
  trigger: string;
  attempt: number;
  scheduled_for: string | null;
  started_at: string | null;
  duration_secs: number | null;
  summary: string | null;
  transcript: unknown | null;
  qa_results: unknown | null;
  audio_available: boolean;
  cost: number | null;
  error: string | null;
  created_at: string;
}

export interface VoiceControlStatusResponse {
  voice_calls_enabled: boolean;
  mode: 'test' | 'live';
  allowlist_size: number;
  configured: boolean;
  scheduled_count: number;
}

@Injectable()
export class VoiceCallsService {
  private readonly logger = new Logger(VoiceCallsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('voice-call') private readonly voiceQueue: Queue,
    private readonly gateway: ElevenLabsGatewayService,
    private readonly storageService: StorageService,
  ) {}

  /**
   * Create a scheduled row + delayed queue job. Returns null when the idempotency key
   * already exists (P2002 — BullMQ re-runs of ingestion / webhook redeliveries).
   * An enqueue failure rolls the row to 'failed' so nothing strands in 'scheduled'
   * (mirrors the replayHeld rollback in ingest-control.service.ts).
   */
  async scheduleCall(params: {
    tenantId: string;
    candidateId: string;
    jobId: string;
    trigger: 'auto' | 'manual';
    attempt?: number;
    idempotencyKey?: string | null;
    notBefore?: Date;
  }): Promise<VoiceCall | null> {
    const scheduledFor = nextBusinessWindowSlot(params.notBefore ?? new Date());

    let row: VoiceCall;
    try {
      row = await this.prisma.voiceCall.create({
        data: {
          tenantId: params.tenantId,
          candidateId: params.candidateId,
          jobId: params.jobId,
          status: 'scheduled',
          trigger: params.trigger,
          attempt: params.attempt ?? 1,
          idempotencyKey: params.idempotencyKey ?? null,
          scheduledFor,
        },
      });
    } catch (err) {
      if ((err as { code?: string })?.code === 'P2002') {
        this.logger.log(`Duplicate voice call skipped (key: ${params.idempotencyKey})`);
        return null;
      }
      throw err;
    }

    try {
      await this.voiceQueue.add('call', { voiceCallId: row.id } satisfies VoiceCallJobData, {
        jobId: `call-${row.id}`,
        delay: Math.max(0, scheduledFor.getTime() - Date.now()),
        ...VOICE_JOB_OPTS,
      });
    } catch (err) {
      await this.prisma.voiceCall.update({
        where: { id: row.id },
        data: { status: 'failed', error: 'enqueue_failed' },
      });
      throw err;
    }
    return row;
  }

  /**
   * Automatic trigger seam (called from the ingestion processor after scoring).
   * Layer 3 (tenant switch) + layer 4 (job toggle) + threshold + phone presence.
   * Never throws for "gate closed" — those are normal outcomes.
   */
  async scheduleAutoCalls(params: {
    tenantId: string;
    candidateId: string;
    jobScores: Array<{ jobId: string; score: number }>;
  }): Promise<void> {
    if (params.jobScores.length === 0) return;

    const [org, candidate] = await Promise.all([
      this.prisma.organization.findUnique({ where: { id: params.tenantId }, select: { voiceCallsEnabled: true } }),
      this.prisma.candidate.findFirst({
        where: { id: params.candidateId, tenantId: params.tenantId },
        select: { phone: true },
      }),
    ]);
    if (!org?.voiceCallsEnabled) return; // Layer 3
    // No row for phone-less candidates — the existing phone_missing DuplicateFlag already
    // surfaces the condition; the candidate card explains "no phone".
    if (!candidate?.phone || candidate.phone.trim() === '') return;

    const jobs = await this.prisma.job.findMany({
      where: { id: { in: params.jobScores.map((j) => j.jobId) }, tenantId: params.tenantId },
      select: { id: true, voiceScreeningEnabled: true, voiceMinScore: true },
    });
    const byId = new Map(jobs.map((j) => [j.id, j]));

    for (const { jobId, score } of params.jobScores) {
      const job = byId.get(jobId);
      if (!job?.voiceScreeningEnabled) continue; // Layer 4
      if (score < job.voiceMinScore) continue; // threshold
      await this.scheduleCall({
        tenantId: params.tenantId,
        candidateId: params.candidateId,
        jobId,
        trigger: 'auto',
        attempt: 1,
        idempotencyKey: `auto:${params.candidateId}:${jobId}:1`,
      });
    }
  }

  /** New row for the next attempt, 4h later snapped into the window. Keyed by predecessor. */
  async scheduleRetry(previous: VoiceCall): Promise<void> {
    if (previous.attempt >= MAX_ATTEMPTS) return;
    await this.scheduleCall({
      tenantId: previous.tenantId,
      candidateId: previous.candidateId,
      jobId: previous.jobId,
      trigger: previous.trigger as 'auto' | 'manual',
      attempt: previous.attempt + 1,
      idempotencyKey: `retry:${previous.id}`,
      notBefore: new Date(Date.now() + RETRY_DELAY_MS),
    });
  }

  /**
   * Manual "Call now". Skips the job toggle + threshold (layer 4) by design — a recruiter
   * decision overrides them — but layers 1–3 still apply (1+2 in the gateway at dial time).
   */
  async triggerManualCall(candidateId: string, jobId: string, session: JwtPayload): Promise<VoiceCallResponse> {
    if (CALLER_FORBIDDEN_ROLES.includes(session.role)) {
      throw new ForbiddenException({ error: { code: 'FORBIDDEN', message: 'Viewers cannot trigger calls' } });
    }
    const tenantId = session.org;

    const candidate = await this.prisma.candidate.findFirst({
      where: { id: candidateId, tenantId },
      select: { id: true, phone: true },
    });
    if (!candidate) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'Candidate not found' } });
    if (!candidate.phone || candidate.phone.trim() === '') {
      throw new UnprocessableEntityException({ error: { code: 'NO_PHONE', message: 'Candidate has no phone number' } });
    }

    const job = await this.prisma.job.findFirst({ where: { id: jobId, tenantId }, select: { id: true } });
    if (!job) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'Job not found' } });

    const org = await this.prisma.organization.findUnique({
      where: { id: tenantId },
      select: { voiceCallsEnabled: true },
    });
    if (!org?.voiceCallsEnabled) {
      throw new ConflictException({
        error: { code: 'VOICE_DISABLED', message: 'Voice calls are disabled for this workspace' },
      });
    }

    const active = await this.prisma.voiceCall.findFirst({
      where: { tenantId, candidateId, jobId, status: { in: [...ACTIVE_CALL_STATUSES] } },
      select: { id: true },
    });
    if (active) {
      throw new ConflictException({
        error: {
          code: 'CALL_ACTIVE',
          message: 'A call is already scheduled or in progress for this candidate and job',
        },
      });
    }

    // idempotencyKey null: repeat manual calls are legitimate; the active-call check above
    // is the concurrency guard. create() therefore cannot P2002 → row is non-null.
    const row = await this.scheduleCall({
      tenantId,
      candidateId,
      jobId,
      trigger: 'manual',
      attempt: 1,
      idempotencyKey: null,
    });
    return this.serialize(row!);
  }

  /** Claim-row cancel: only 'scheduled' → 'canceled'. Queue-job removal is best-effort. */
  async cancelCall(candidateId: string, callId: string, session: JwtPayload): Promise<{ success: boolean }> {
    if (CALLER_FORBIDDEN_ROLES.includes(session.role)) {
      throw new ForbiddenException({ error: { code: 'FORBIDDEN', message: 'Viewers cannot cancel calls' } });
    }
    const claimed = await this.prisma.voiceCall.updateMany({
      where: { id: callId, candidateId, tenantId: session.org, status: 'scheduled' },
      data: { status: 'canceled', error: 'canceled_by_user' },
    });
    if (claimed.count === 0) {
      throw new ConflictException({ error: { code: 'NOT_CANCELABLE', message: 'Call is not in a cancelable state' } });
    }
    try {
      const job = await this.voiceQueue.getJob(`call-${callId}`);
      if (job) await job.remove();
    } catch (err) {
      // The processor's claim check (status must be 'scheduled') is the real guard.
      this.logger.warn(`Could not remove queue job for canceled call ${callId}: ${(err as Error).message}`);
    }
    return { success: true };
  }

  async listCalls(candidateId: string, tenantId: string): Promise<{ calls: VoiceCallResponse[] }> {
    const candidate = await this.prisma.candidate.findFirst({
      where: { id: candidateId, tenantId },
      select: { id: true },
    });
    if (!candidate) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'Candidate not found' } });
    const rows = await this.prisma.voiceCall.findMany({
      where: { tenantId, candidateId },
      orderBy: { createdAt: 'desc' },
      include: { job: { select: { title: true } } },
    });
    return { calls: rows.map((r) => this.serialize(r)) };
  }

  async getAudioBytes(candidateId: string, callId: string, tenantId: string): Promise<Buffer> {
    const row = await this.prisma.voiceCall.findFirst({
      where: { id: callId, candidateId, tenantId },
      select: { audioKey: true },
    });
    if (!row) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'Call not found' } });
    if (!row.audioKey)
      throw new NotFoundException({ error: { code: 'NO_AUDIO', message: 'No recording available for this call' } });
    const { body } = await this.storageService.getObject(row.audioKey);
    return body;
  }

  async getStatus(session: JwtPayload): Promise<VoiceControlStatusResponse> {
    const [org, scheduledCount] = await Promise.all([
      this.prisma.organization.findUniqueOrThrow({ where: { id: session.org }, select: { voiceCallsEnabled: true } }),
      this.prisma.voiceCall.count({ where: { tenantId: session.org, status: 'scheduled' } }),
    ]);
    return {
      voice_calls_enabled: org.voiceCallsEnabled,
      mode: this.gateway.mode(),
      allowlist_size: this.gateway.allowlist().size,
      configured: this.gateway.isConfigured(),
      scheduled_count: scheduledCount,
    };
  }

  async setEnabled(session: JwtPayload, enabled: boolean): Promise<VoiceControlStatusResponse> {
    // Inline role enforcement (D-18 pattern) — enabling calls is spend + outreach, admin action
    if (!CONTROL_ROLES.includes(session.role)) {
      throw new ForbiddenException({
        error: { code: 'FORBIDDEN', message: 'Only owners and admins can control voice calls' },
      });
    }
    await this.prisma.organization.update({ where: { id: session.org }, data: { voiceCallsEnabled: enabled } });
    return this.getStatus(session);
  }

  serialize(row: VoiceCall & { job?: { title: string } | null }): VoiceCallResponse {
    return {
      id: row.id,
      job_id: row.jobId,
      job_title: row.job?.title ?? null,
      status: row.status,
      trigger: row.trigger,
      attempt: row.attempt,
      scheduled_for: row.scheduledFor?.toISOString() ?? null,
      started_at: row.startedAt?.toISOString() ?? null,
      duration_secs: row.durationSecs,
      summary: row.summary,
      transcript: row.transcript ?? null,
      qa_results: row.qaResults ?? null,
      audio_available: row.audioKey != null,
      cost: row.cost,
      error: row.error,
      created_at: row.createdAt.toISOString(),
    };
  }
}
