import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { VoiceCallsService, VoiceCallJobData, VOICE_JOB_OPTS, MAX_ATTEMPTS } from './voice-calls.service';
import { ElevenLabsWebhookEvent } from './dto/elevenlabs-webhook.dto';

interface TranscriptTurn {
  role: string;
  message: string | null;
  time_in_call_secs: number | null;
}

// Trim ElevenLabs transcript turns to the fields the UI renders (drop tool_calls etc.)
function mapTranscript(raw: unknown): TranscriptTurn[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((t: Record<string, any>) => ({
    role: String(t?.role ?? ''),
    message: (t?.message as string) ?? null,
    time_in_call_secs: typeof t?.time_in_call_secs === 'number' ? t.time_in_call_secs : null,
  }));
}

@Injectable()
export class VoiceResultsService {
  private readonly logger = new Logger(VoiceResultsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('voice-call') private readonly voiceQueue: Queue,
    private readonly voiceCalls: VoiceCallsService,
  ) {}

  /**
   * Webhook dispatch. NEVER throws: ElevenLabs disables webhooks after repeated 5xx, and
   * the 30-min watchdog poll re-derives anything a lost event would have written.
   */
  async handleWebhookEvent(event: ElevenLabsWebhookEvent): Promise<void> {
    const conversationId = event.data?.conversation_id;
    if (!conversationId) return;
    try {
      switch (event.type) {
        case 'post_call_transcription':
          await this.finalizeFromTranscription(conversationId, event.data as Record<string, any>);
          break;
        case 'call_initiation_failure':
          await this.handleInitiationFailure(
            conversationId,
            String((event.data as Record<string, any>).failure_reason ?? 'unknown'),
          );
          break;
        case 'post_call_audio':
          // Deliberately ignored: audio is PULLED via the API by the worker (plan D2).
          break;
        default:
          this.logger.log(`Unhandled ElevenLabs event type: ${event.type}`);
      }
    } catch (err) {
      this.logger.error(`Webhook handling failed for ${conversationId}: ${(err as Error).message}`);
    }
  }

  /**
   * Shared finalization for webhook payloads AND watchdog-polled conversations —
   * `data` is ConversationHistoryCommonModel in both cases. Idempotent: redeliveries
   * overwrite with identical values; the audio job is deduped by jobId.
   */
  async finalizeFromTranscription(conversationId: string, data: Record<string, any>): Promise<void> {
    const row = await this.prisma.voiceCall.findUnique({ where: { conversationId } });
    if (!row) {
      // Other agents in the workspace may share the webhook — 200-and-ignore by design.
      this.logger.warn(`Transcription for unknown conversation ${conversationId} — ignored`);
      return;
    }

    const analysis = (data.analysis ?? {}) as Record<string, any>;
    const metadata = (data.metadata ?? {}) as Record<string, any>;
    const summary = (analysis.transcript_summary as string) ?? null;

    await this.prisma.voiceCall.update({
      where: { id: row.id },
      data: {
        status: 'completed',
        summary,
        transcript: mapTranscript(data.transcript) as unknown as Prisma.InputJsonValue,
        qaResults: {
          data_collection_results: analysis.data_collection_results ?? null,
          evaluation_criteria_results: analysis.evaluation_criteria_results ?? null,
          call_successful: analysis.call_successful ?? null,
        } as unknown as Prisma.InputJsonValue,
        durationSecs: typeof metadata.call_duration_secs === 'number' ? metadata.call_duration_secs : null,
        cost: typeof metadata.cost === 'number' ? Math.round(metadata.cost) : null,
        error: null,
      },
    });

    if (data.has_audio !== false) {
      await this.voiceQueue.add('audio', { voiceCallId: row.id } satisfies VoiceCallJobData, {
        jobId: `audio-${row.id}`, // BullMQ ignores adds whose jobId already exists → redelivery-safe
        ...VOICE_JOB_OPTS,
      });
    }

    // Hand off to the worker: AI assessment + stage write + advance (spec §5). Never in the
    // webhook request path; jobId dedup makes webhook redeliveries and watchdog races no-ops.
    // Enqueued LAST so a Redis hiccup here cannot cost us the recording.
    await this.voiceQueue.add('assess', { voiceCallId: row.id } satisfies VoiceCallJobData, {
      jobId: `assess-${row.id}`,
      ...VOICE_JOB_OPTS,
      // Overrides VOICE_JOB_OPTS' retained failed set: a kept `assess-{id}` would make every
      // later add a silent no-op (BullMQ rejects duplicate ids), so an OpenRouter outage would
      // lose the assessment permanently. Dropping it lets the watchdog / a redelivery retry.
      removeOnFail: true,
    });
  }

  /** busy / no-answer → no_answer (+retry while attempts remain); anything else → failed. */
  async handleInitiationFailure(conversationId: string, failureReason: string): Promise<void> {
    const row = await this.prisma.voiceCall.findUnique({ where: { conversationId } });
    if (!row) {
      this.logger.warn(`Initiation failure for unknown conversation ${conversationId} — ignored`);
      return;
    }
    // Redelivery guard: only an in-flight row transitions; a final row already did its retry.
    if (row.status !== 'calling' && row.status !== 'in_progress') return;

    const retryable = failureReason === 'busy' || failureReason === 'no-answer';
    await this.prisma.voiceCall.update({
      where: { id: row.id },
      data: { status: retryable ? 'no_answer' : 'failed', error: failureReason },
    });
    if (retryable && row.attempt < MAX_ATTEMPTS) {
      await this.voiceCalls.scheduleRetry(row);
    }
  }
}
