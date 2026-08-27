import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { normalizeToE164 } from './phone';

export type VoiceCallBlockReason = 'blocked_test_mode' | 'invalid_phone' | 'not_configured';

/** Thrown instead of dialing — terminal for the row, never retried by BullMQ. */
export class VoiceCallBlockedError extends Error {
  constructor(public readonly reason: VoiceCallBlockReason) {
    super(reason);
    this.name = 'VoiceCallBlockedError';
  }
}

export interface OutboundCallParams {
  /** Raw phone exactly as stored on the candidate — normalized here, at the last mile. */
  toNumber: string;
  dynamicVariables: Record<string, string>;
}

export interface OutboundCallResult {
  conversationId: string;
  /** Twilio callSid or SIP call id — whichever telephony placed the call (one column, Scheduler-style). */
  callSid: string | null;
}

const DIAL_TIMEOUT_SECS = 15;
const POLL_TIMEOUT_SECS = 15;
const AUDIO_TIMEOUT_SECS = 60;

@Injectable()
export class ElevenLabsGatewayService {
  private readonly logger = new Logger(ElevenLabsGatewayService.name);
  private client: ElevenLabsClient | null = null;

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(
      this.config.get<string>('ELEVENLABS_API_KEY') &&
        this.config.get<string>('ELEVENLABS_AGENT_ID') &&
        this.config.get<string>('ELEVENLABS_AGENT_PHONE_NUMBER_ID'),
    );
  }

  /** Safety layer 2: anything other than the literal 'live' enforces the allowlist. */
  mode(): 'test' | 'live' {
    return this.config.get<string>('VOICE_CALL_MODE') === 'live' ? 'live' : 'test';
  }

  /** How the agent's number lives in ElevenLabs: Twilio import vs SIP trunk (Scheduler switch). */
  telephony(): 'twilio' | 'sip' {
    return this.config.get<string>('ELEVENLABS_TELEPHONY') === 'twilio' ? 'twilio' : 'sip';
  }

  /** Safety layer 1: env allowlist, normalized so dashed entries match dashed phones. */
  allowlist(): Set<string> {
    const raw = this.config.get<string>('VOICE_CALL_ALLOWLIST') ?? '';
    return new Set(
      raw
        .split(',')
        .map((n) => normalizeToE164(n.trim()))
        .filter((n): n is string => n !== null),
    );
  }

  /** Lazy: an unconfigured deployment never constructs a client (isConfigured gates every use). */
  private sdk(): ElevenLabsClient {
    if (!this.client) {
      this.client = new ElevenLabsClient({ apiKey: this.config.get<string>('ELEVENLABS_API_KEY') ?? '' });
    }
    return this.client;
  }

  /**
   * THE LAST MILE. Every code path that dials (auto trigger, manual button, retry)
   * funnels through here. In test mode a number outside the allowlist raises
   * VoiceCallBlockedError before ANYTHING reaches the ElevenLabs SDK.
   */
  async startOutboundCall(params: OutboundCallParams): Promise<OutboundCallResult> {
    if (!this.isConfigured()) throw new VoiceCallBlockedError('not_configured');

    const toNumber = normalizeToE164(params.toNumber);
    if (!toNumber) throw new VoiceCallBlockedError('invalid_phone');

    if (this.mode() !== 'live' && !this.allowlist().has(toNumber)) {
      this.logger.warn(`Blocked outbound call to ${toNumber} (test mode, not in allowlist)`);
      throw new VoiceCallBlockedError('blocked_test_mode');
    }

    // Mirrors the Scheduler's lib/clients/elevenlabs.ts. maxRetries: 0 because the SDK
    // retries twice by default and a silently re-POSTed dial could ring a candidate twice —
    // retries belong to BullMQ, which re-claims through the row state machine.
    const request = {
      agentId: this.config.get<string>('ELEVENLABS_AGENT_ID') as string,
      agentPhoneNumberId: this.config.get<string>('ELEVENLABS_AGENT_PHONE_NUMBER_ID') as string,
      toNumber,
      conversationInitiationClientData: { dynamicVariables: params.dynamicVariables },
    };
    const requestOptions = { maxRetries: 0, timeoutInSeconds: DIAL_TIMEOUT_SECS };

    if (this.telephony() === 'twilio') {
      const res = await this.sdk().conversationalAi.twilio.outboundCall(request, requestOptions);
      if (!res.success || !res.conversationId) {
        throw new Error(`ElevenLabs outbound-call rejected: ${res.message ?? 'no conversation id'}`);
      }
      return { conversationId: res.conversationId, callSid: res.callSid ?? null };
    }
    const res = await this.sdk().conversationalAi.sipTrunk.outboundCall(request, requestOptions);
    if (!res.success || !res.conversationId) {
      throw new Error(`ElevenLabs outbound-call rejected: ${res.message ?? 'no conversation id'}`);
    }
    return { conversationId: res.conversationId, callSid: res.sipCallId ?? null };
  }

  /**
   * Watchdog fallback. The SDK deserializes the wire's snake_case into camelCase models;
   * normalize back to the post_call_transcription webhook's `data` shape so
   * VoiceResultsService.finalizeFromTranscription treats both sources identically.
   * (Inner data_collection_results values keep `value`/`rationale` unchanged — the only
   * fields the UI and results service read.)
   */
  async getConversation(conversationId: string): Promise<Record<string, any>> {
    const c = await this.sdk().conversationalAi.conversations.get(conversationId, undefined, {
      timeoutInSeconds: POLL_TIMEOUT_SECS,
    });
    return {
      conversation_id: c.conversationId,
      status: c.status,
      has_audio: c.hasAudio,
      transcript: (c.transcript ?? []).map((t) => ({
        role: t.role,
        message: t.message ?? '',
        time_in_call_secs: t.timeInCallSecs,
      })),
      analysis: c.analysis
        ? {
            transcript_summary: c.analysis.transcriptSummary,
            call_successful: c.analysis.callSuccessful,
            data_collection_results: c.analysis.dataCollectionResults ?? {},
            evaluation_criteria_results: c.analysis.evaluationCriteriaResults ?? {},
          }
        : undefined,
      metadata: { call_duration_secs: c.metadata?.callDurationSecs, cost: c.metadata?.cost },
    };
  }

  /** MP3 bytes of the full call. Pulled by the worker (never pushed via webhook — see plan D2). */
  async getConversationAudio(conversationId: string): Promise<Buffer> {
    const stream = await this.sdk().conversationalAi.conversations.audio.get(conversationId, {
      timeoutInSeconds: AUDIO_TIMEOUT_SECS,
    });
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    return Buffer.concat(chunks);
  }
}
