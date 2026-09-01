import { Injectable } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { Logger as PinoLogger } from 'nestjs-pino';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { ElevenLabsGatewayService, VoiceCallBlockedError } from './elevenlabs-gateway.service';
import { VoiceResultsService } from './voice-results.service';
import { VoiceAssessmentService } from './voice-assessment.service';
import { VoiceCallJobData, VOICE_JOB_OPTS } from './voice-calls.service';
import { isInBusinessWindow, nextBusinessWindowSlot } from './call-window';

const WATCHDOG_DELAY_MS = 30 * 60 * 1000; // first check 30 min after dialing
const WATCHDOG_RECHECK_MS = 10 * 60 * 1000; // then every 10 min
const MAX_CALL_AGE_MS = 2 * 60 * 60 * 1000; // hard timeout 2h after startedAt

type ClaimedRow = Prisma.VoiceCallGetPayload<{
  include: {
    candidate: { select: { fullName: true; phone: true; status: true } };
    job: {
      select: {
        title: true;
        voiceScreeningEnabled: true;
        screeningQuestions: { orderBy: { order: 'asc' }; select: { text: true } };
      };
    };
    tenant: { select: { name: true; voiceCallsEnabled: true } };
  };
}>;

// Numbered plain-text serialization the agent prompt iterates over ({{questions}}).
export function serializeQuestions(questions: Array<{ text: string }>): string {
  if (questions.length === 0) {
    return 'No specific screening questions were configured — hold a short, friendly general screening conversation about availability and experience.';
  }
  return questions.map((q, i) => `${i + 1}. ${q.text}`).join('\n');
}

// The agent's first message is spoken verbatim by TTS (no LLM pass) — "(UX/UI)" in a job
// title would be read aloud. The raw title is unchanged everywhere else; the prompt's own
// drop-parentheses rule stays as defense-in-depth for LLM-generated turns.
export function ttsSafeJobTitle(title: string): string {
  const stripped = title
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > 0 ? stripped : title.trim();
}

@Injectable()
@Processor('voice-call', {
  lockDuration: 60000, // outbound dial SDK call has a 15s timeout; 60s lock leaves ample room
  lockRenewTime: 5000,
  maxStalledCount: 2,
})
export class VoiceCallProcessor extends WorkerHost {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: ElevenLabsGatewayService,
    private readonly voiceResults: VoiceResultsService,
    private readonly voiceAssessment: VoiceAssessmentService,
    private readonly storageService: StorageService,
    @InjectQueue('voice-call') private readonly voiceQueue: Queue,
    private readonly pinoLogger: PinoLogger,
  ) {
    super();
  }

  async process(job: Job<VoiceCallJobData>): Promise<void> {
    switch (job.name) {
      case 'call':
        return this.executeCall(job);
      case 'check':
        return this.checkCall(job);
      case 'audio':
        return this.fetchAudio(job);
      case 'assess':
        // Errors propagate so BullMQ retries per the enqueue's VOICE_JOB_OPTS; a terminal
        // failure leaves transcript/summary/audio intact — the assessment is additive.
        return this.voiceAssessment.assessCall(job.data.voiceCallId);
      default:
        this.pinoLogger.warn({ jobName: job.name }, 'Unknown voice-call job name — skipping');
    }
  }

  private async executeCall(job: Job<VoiceCallJobData>): Promise<void> {
    const { voiceCallId } = job.data;

    // 1. Claim (double-delivery + cancel safe): only 'scheduled' rows may dial.
    const claimed = await this.prisma.voiceCall.updateMany({
      where: { id: voiceCallId, status: 'scheduled' },
      data: { status: 'calling' },
    });
    if (claimed.count === 0) {
      this.pinoLogger.log({ voiceCallId }, 'Voice call not claimable — skipping');
      return;
    }

    const row = (await this.prisma.voiceCall.findUniqueOrThrow({
      where: { id: voiceCallId },
      include: {
        candidate: { select: { fullName: true, phone: true, status: true } },
        job: {
          select: {
            title: true,
            voiceScreeningEnabled: true,
            screeningQuestions: { orderBy: { order: 'asc' }, select: { text: true } },
          },
        },
        tenant: { select: { name: true, voiceCallsEnabled: true } },
      },
    })) as ClaimedRow;

    // 2. Re-check gates — config may have changed during the delay.
    const gateFailure = this.checkGates(row);
    if (gateFailure) {
      await this.prisma.voiceCall.update({
        where: { id: voiceCallId },
        data: { status: 'canceled', error: gateFailure },
      });
      this.pinoLogger.log({ voiceCallId, gateFailure }, 'Voice call canceled at execution gate');
      return;
    }

    // 3. Window re-check — worker downtime may have pushed execution past 19:00.
    const now = new Date();
    if (!isInBusinessWindow(now)) {
      const nextSlot = nextBusinessWindowSlot(now);
      await this.prisma.voiceCall.update({
        where: { id: voiceCallId },
        data: { status: 'scheduled', scheduledFor: nextSlot },
      });
      // Fresh jobId — the original job is completing right now and its id may be retained.
      await this.voiceQueue.add('call', { voiceCallId } satisfies VoiceCallJobData, {
        jobId: `call-${voiceCallId}-${nextSlot.getTime()}`,
        delay: nextSlot.getTime() - now.getTime(),
        ...VOICE_JOB_OPTS,
      });
      this.pinoLogger.log({ voiceCallId, nextSlot }, 'Voice call rescheduled into the business window');
      return;
    }

    // 4. Dial. The gateway owns safety layers 1+2 (mode + allowlist) at the last mile.
    try {
      const result = await this.gateway.startOutboundCall({
        toNumber: row.candidate.phone!,
        dynamicVariables: {
          candidate_name: row.candidate.fullName,
          job_title: ttsSafeJobTitle(row.job.title),
          company_name: row.tenant.name,
          questions: serializeQuestions(row.job.screeningQuestions),
          voice_call_id: row.id, // correlation — echoed back in conversation_initiation_client_data
        },
      });
      await this.prisma.voiceCall.update({
        where: { id: voiceCallId },
        data: { status: 'in_progress', conversationId: result.conversationId, startedAt: new Date() },
      });
      this.pinoLogger.log({ voiceCallId, conversationId: result.conversationId }, 'Voice call dialing');
    } catch (err) {
      if (err instanceof VoiceCallBlockedError) {
        // Expected terminal outcome (test-mode block / bad phone / unconfigured) — no retry.
        await this.prisma.voiceCall.update({
          where: { id: voiceCallId },
          data: { status: err.reason === 'blocked_test_mode' ? 'blocked' : 'failed', error: err.reason },
        });
        this.pinoLogger.log({ voiceCallId, reason: err.reason }, 'Voice call blocked by safety gate');
        return;
      }
      // Transient (network / ElevenLabs 5xx): re-open the claim so the BullMQ retry can
      // claim again, then rethrow. On the final attempt, finalize as failed instead.
      if (job.attemptsMade + 1 < (job.opts.attempts ?? 1)) {
        await this.prisma.voiceCall.updateMany({
          where: { id: voiceCallId, status: 'calling' },
          data: { status: 'scheduled' },
        });
        throw err;
      }
      await this.prisma.voiceCall.update({
        where: { id: voiceCallId },
        data: { status: 'failed', error: (err as Error).message.slice(0, 500) },
      });
      return;
    }

    // 5. Watchdog: finalize from polling if the webhook never arrives.
    await this.voiceQueue.add('check', { voiceCallId } satisfies VoiceCallJobData, {
      jobId: `check-${voiceCallId}-1`,
      delay: WATCHDOG_DELAY_MS,
      ...VOICE_JOB_OPTS,
    });
  }

  /** Gate re-check at execution time. Returns the reason string or null when all gates pass. */
  private checkGates(row: ClaimedRow): string | null {
    if (!row.tenant.voiceCallsEnabled) return 'tenant_disabled';
    // Layer 4 applies to auto calls only — a manual call is an explicit recruiter decision.
    if (row.trigger === 'auto' && !row.job.voiceScreeningEnabled) return 'job_disabled';
    if (!row.candidate.phone || row.candidate.phone.trim() === '') return 'phone_missing';
    if (row.candidate.status === 'rejected') return 'candidate_rejected';
    return null;
  }

  private async checkCall(job: Job<VoiceCallJobData>): Promise<void> {
    const { voiceCallId } = job.data;
    const row = await this.prisma.voiceCall.findUnique({ where: { id: voiceCallId } });
    if (!row || row.status !== 'in_progress' || !row.conversationId) return; // webhook won the race

    // A throw here must NOT propagate: BullMQ would retry three times over ~15s and then
    // drop the job, and since the next check is only ever armed from inside this handler,
    // a brief ElevenLabs outage would silently disable the watchdog for good — leaving the
    // row stuck in 'in_progress' forever whenever the webhook is also lost.
    let conversation: Record<string, any> | null = null;
    try {
      conversation = await this.gateway.getConversation(row.conversationId);
    } catch (err) {
      this.pinoLogger.warn(
        { voiceCallId, error: (err as Error).message },
        'Watchdog poll failed — re-arming the next check',
      );
    }

    if (conversation) {
      const status = conversation.status as string;
      if (status === 'done') {
        await this.voiceResults.finalizeFromTranscription(row.conversationId, conversation);
        return;
      }
      if (status === 'failed') {
        await this.prisma.voiceCall.update({
          where: { id: voiceCallId },
          data: { status: 'failed', error: 'provider_reported_failure' },
        });
        return;
      }
    }

    // Poll failed, or the call is still initiated / in-progress / processing — either still
    // young (re-check) or stuck (timeout). MAX_CALL_AGE_MS bounds the re-arm loop.
    const ageMs = Date.now() - (row.startedAt?.getTime() ?? row.createdAt.getTime());
    if (ageMs > MAX_CALL_AGE_MS) {
      await this.prisma.voiceCall.update({
        where: { id: voiceCallId },
        data: { status: 'failed', error: 'watchdog_timeout' },
      });
      return;
    }
    await this.voiceQueue.add('check', { voiceCallId } satisfies VoiceCallJobData, {
      jobId: `check-${voiceCallId}-${Date.now()}`,
      delay: WATCHDOG_RECHECK_MS,
      ...VOICE_JOB_OPTS,
    });
  }

  private async fetchAudio(job: Job<VoiceCallJobData>): Promise<void> {
    const { voiceCallId } = job.data;
    const row = await this.prisma.voiceCall.findUnique({ where: { id: voiceCallId } });
    if (!row || !row.conversationId || row.audioKey) return; // nothing to do / already stored
    const audio = await this.gateway.getConversationAudio(row.conversationId);
    const key = await this.storageService.uploadVoiceAudio(audio, row.tenantId, row.id);
    await this.prisma.voiceCall.update({ where: { id: voiceCallId }, data: { audioKey: key } });
    this.pinoLogger.log({ voiceCallId, key, bytes: audio.length }, 'Voice call audio stored');
  }
}
