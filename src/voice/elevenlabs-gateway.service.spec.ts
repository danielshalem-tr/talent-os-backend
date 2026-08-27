import { ElevenLabsGatewayService, VoiceCallBlockedError } from './elevenlabs-gateway.service';
import { ConfigService } from '@nestjs/config';

// SDK mocked at module level (jest hoists jest.mock; referenced names must start with `mock`).
const mockTwilioOutboundCall = jest.fn();
const mockSipTrunkOutboundCall = jest.fn();
const mockConversationsGet = jest.fn();
const mockAudioGet = jest.fn();
jest.mock('@elevenlabs/elevenlabs-js', () => ({
  ElevenLabsClient: jest.fn().mockImplementation(() => ({
    conversationalAi: {
      twilio: { outboundCall: mockTwilioOutboundCall },
      sipTrunk: { outboundCall: mockSipTrunkOutboundCall },
      conversations: { get: mockConversationsGet, audio: { get: mockAudioGet } },
    },
  })),
}));

function makeConfig(overrides: Record<string, string | undefined> = {}): ConfigService {
  const values: Record<string, string | undefined> = {
    ELEVENLABS_API_KEY: 'xi-test-key',
    ELEVENLABS_AGENT_ID: 'agent_123',
    ELEVENLABS_AGENT_PHONE_NUMBER_ID: 'phnum_123',
    ELEVENLABS_TELEPHONY: 'sip',
    VOICE_CALL_MODE: 'test',
    VOICE_CALL_ALLOWLIST: '',
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

const CALL = { toNumber: '+972-52-4203543', dynamicVariables: { candidate_name: 'Dana' } };
const SIP_SUCCESS = { success: true, message: 'ok', conversationId: 'conv_1', sipCallId: 'sip_1' };
const TWILIO_SUCCESS = { success: true, message: 'ok', conversationId: 'conv_1', callSid: 'CA1' };

describe('ElevenLabsGatewayService — safety gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSipTrunkOutboundCall.mockResolvedValue(SIP_SUCCESS);
    mockTwilioOutboundCall.mockResolvedValue(TWILIO_SUCCESS);
  });

  it('BLOCKS in test mode with an empty allowlist (fail-closed) — nothing reaches the SDK', async () => {
    const svc = new ElevenLabsGatewayService(makeConfig());
    await expect(svc.startOutboundCall(CALL)).rejects.toMatchObject({ reason: 'blocked_test_mode' });
    expect(mockSipTrunkOutboundCall).not.toHaveBeenCalled();
    expect(mockTwilioOutboundCall).not.toHaveBeenCalled();
  });

  it('BLOCKS in test mode when the number is not in the allowlist', async () => {
    const svc = new ElevenLabsGatewayService(makeConfig({ VOICE_CALL_ALLOWLIST: '+972501111111' }));
    await expect(svc.startOutboundCall(CALL)).rejects.toBeInstanceOf(VoiceCallBlockedError);
    expect(mockSipTrunkOutboundCall).not.toHaveBeenCalled();
  });

  it('ALLOWS in test mode when the normalized number is allowlisted (dashed env entry matches dashed phone)', async () => {
    const svc = new ElevenLabsGatewayService(makeConfig({ VOICE_CALL_ALLOWLIST: ' +972-52-4203543 , +972501111111' }));
    const result = await svc.startOutboundCall(CALL);
    expect(result).toEqual({ conversationId: 'conv_1', callSid: 'sip_1' });
    expect(mockSipTrunkOutboundCall.mock.calls[0][0].toNumber).toBe('+972524203543');
  });

  it('ALLOWS in live mode without an allowlist', async () => {
    const svc = new ElevenLabsGatewayService(makeConfig({ VOICE_CALL_MODE: 'live' }));
    await expect(svc.startOutboundCall(CALL)).resolves.toMatchObject({ conversationId: 'conv_1' });
  });

  it('BLOCKS as not_configured when any core ELEVENLABS_* var is missing — even in live mode', async () => {
    const svc = new ElevenLabsGatewayService(makeConfig({ ELEVENLABS_AGENT_ID: undefined, VOICE_CALL_MODE: 'live' }));
    await expect(svc.startOutboundCall(CALL)).rejects.toMatchObject({ reason: 'not_configured' });
    expect(mockSipTrunkOutboundCall).not.toHaveBeenCalled();
  });

  it('BLOCKS an unnormalizable phone before anything reaches the SDK', async () => {
    const svc = new ElevenLabsGatewayService(makeConfig({ VOICE_CALL_MODE: 'live' }));
    await expect(svc.startOutboundCall({ ...CALL, toNumber: 'call me maybe' })).rejects.toMatchObject({ reason: 'invalid_phone' });
    expect(mockSipTrunkOutboundCall).not.toHaveBeenCalled();
  });

  it('throws a plain Error (retryable) when the SDK rejects', async () => {
    const svc = new ElevenLabsGatewayService(makeConfig({ VOICE_CALL_MODE: 'live' }));
    mockSipTrunkOutboundCall.mockRejectedValueOnce(new Error('502 from ElevenLabs'));
    const err = await svc.startOutboundCall(CALL).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(VoiceCallBlockedError);
  });

  it('throws a plain Error when the API returns success=false or no conversation id', async () => {
    const svc = new ElevenLabsGatewayService(makeConfig({ VOICE_CALL_MODE: 'live' }));
    mockSipTrunkOutboundCall.mockResolvedValueOnce({ success: false, message: 'busy line' });
    await expect(svc.startOutboundCall(CALL)).rejects.toThrow(/busy line/);
  });

  it('routes by ELEVENLABS_TELEPHONY (sip default → sipTrunk, twilio → twilio) with the documented camelCase request and no SDK-internal retries', async () => {
    const sipSvc = new ElevenLabsGatewayService(makeConfig({ VOICE_CALL_MODE: 'live' }));
    await sipSvc.startOutboundCall(CALL);
    expect(mockSipTrunkOutboundCall).toHaveBeenCalledTimes(1);
    expect(mockTwilioOutboundCall).not.toHaveBeenCalled();

    const twilioSvc = new ElevenLabsGatewayService(makeConfig({ VOICE_CALL_MODE: 'live', ELEVENLABS_TELEPHONY: 'twilio' }));
    const result = await twilioSvc.startOutboundCall(CALL);
    expect(result).toEqual({ conversationId: 'conv_1', callSid: 'CA1' });
    const [request, requestOptions] = mockTwilioOutboundCall.mock.calls[0];
    expect(request).toEqual({
      agentId: 'agent_123',
      agentPhoneNumberId: 'phnum_123',
      toNumber: '+972524203543',
      conversationInitiationClientData: { dynamicVariables: { candidate_name: 'Dana' } },
    });
    // A silently re-POSTed dial could ring a candidate twice — SDK retries must stay off.
    expect(requestOptions).toMatchObject({ maxRetries: 0 });
  });

  it('getConversation normalizes the SDK camelCase model to the webhook snake_case shape', async () => {
    const svc = new ElevenLabsGatewayService(makeConfig());
    mockConversationsGet.mockResolvedValueOnce({
      conversationId: 'conv_1',
      status: 'done',
      hasAudio: true,
      transcript: [{ role: 'agent', message: 'Hi', timeInCallSecs: 0, toolCalls: [{ big: 'blob' }] }],
      analysis: {
        transcriptSummary: 'Summary.',
        callSuccessful: 'success',
        dataCollectionResults: { answers: { value: '1. Yes' } },
        evaluationCriteriaResults: { call_completed: { result: 'success' } },
      },
      metadata: { callDurationSecs: 241, cost: 830 },
    });
    await expect(svc.getConversation('conv_1')).resolves.toEqual({
      conversation_id: 'conv_1',
      status: 'done',
      has_audio: true,
      transcript: [{ role: 'agent', message: 'Hi', time_in_call_secs: 0 }],
      analysis: {
        transcript_summary: 'Summary.',
        call_successful: 'success',
        data_collection_results: { answers: { value: '1. Yes' } },
        evaluation_criteria_results: { call_completed: { result: 'success' } },
      },
      metadata: { call_duration_secs: 241, cost: 830 },
    });
  });

  it('getConversationAudio drains the SDK stream into a Buffer', async () => {
    const svc = new ElevenLabsGatewayService(makeConfig());
    const bytes = new TextEncoder().encode('mp3-bytes');
    mockAudioGet.mockResolvedValueOnce(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    );
    const buf = await svc.getConversationAudio('conv_1');
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.toString('utf8')).toBe('mp3-bytes');
  });
});
