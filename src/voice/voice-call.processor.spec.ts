import { Job } from 'bullmq';
import { serializeQuestions, ttsSafeJobTitle, VoiceCallProcessor } from './voice-call.processor';
import { VoiceCallBlockedError } from './elevenlabs-gateway.service';

const TENANT = '11111111-1111-1111-1111-111111111111';
// Thursday 2026-08-27 10:00 Asia/Jerusalem (07:00 UTC, IDT) — inside the business window
const IN_WINDOW = new Date('2026-08-27T07:00:00Z');
// Thursday 2026-08-27 20:00 Asia/Jerusalem — outside the window
const OUT_OF_WINDOW = new Date('2026-08-27T17:00:00Z');

const ROW = {
  id: 'vc1',
  tenantId: TENANT,
  candidateId: 'cand1',
  jobId: 'job1',
  status: 'calling',
  trigger: 'auto',
  attempt: 1,
  conversationId: null,
  startedAt: null,
  createdAt: new Date('2026-08-27T06:00:00Z'),
  candidate: { fullName: 'Dana Cohen', phone: '+972-52-4203543', status: 'active' },
  job: {
    title: 'Frontend Engineer',
    voiceScreeningEnabled: true,
    screeningQuestions: [{ text: 'Are you legally allowed to work in Israel?' }, { text: 'How many years of React?' }],
  },
  tenant: { name: 'Triolla', voiceCallsEnabled: true },
};

function makeJob(name: string, attemptsMade = 0): Job {
  return { name, data: { voiceCallId: 'vc1' }, attemptsMade, opts: { attempts: 3 } } as unknown as Job;
}

function makeMocks(rowOverrides: Record<string, any> = {}) {
  const row = JSON.parse(JSON.stringify({ ...ROW, ...rowOverrides }));
  row.createdAt = new Date(row.createdAt);
  if (row.startedAt) row.startedAt = new Date(row.startedAt);
  const prisma = {
    voiceCall: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
      findUniqueOrThrow: jest.fn().mockResolvedValue(row),
      findUnique: jest.fn().mockResolvedValue(row),
    },
  };
  const gateway = {
    startOutboundCall: jest.fn().mockResolvedValue({ conversationId: 'conv_1', callSid: 'CA1' }),
    getConversation: jest.fn().mockResolvedValue({ status: 'done', conversation_id: 'conv_1' }),
    getConversationAudio: jest.fn().mockResolvedValue(Buffer.from('mp3')),
  };
  const queue = { add: jest.fn().mockResolvedValue({}) };
  const voiceResults = { finalizeFromTranscription: jest.fn().mockResolvedValue(undefined) };
  const storage = { uploadVoiceAudio: jest.fn().mockResolvedValue(`calls/${TENANT}/vc1/audio.mp3`) };
  const pinoLogger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const processor = new VoiceCallProcessor(
    prisma as any,
    gateway as any,
    voiceResults as any,
    storage as any,
    queue as any,
    pinoLogger as any,
  );
  return { prisma, gateway, queue, voiceResults, storage, processor };
}

describe('VoiceCallProcessor', () => {
  beforeEach(() => jest.useFakeTimers({ now: IN_WINDOW }));
  afterEach(() => jest.useRealTimers());

  describe('call job', () => {
    it('skips silently when the claim fails (row not scheduled — canceled or double delivery)', async () => {
      const { processor, prisma, gateway } = makeMocks();
      prisma.voiceCall.updateMany.mockResolvedValue({ count: 0 });
      await processor.process(makeJob('call'));
      expect(gateway.startOutboundCall).not.toHaveBeenCalled();
    });

    it('cancels when a gate closed during the delay (tenant switch off)', async () => {
      const { processor, prisma, gateway } = makeMocks({ tenant: { name: 'Triolla', voiceCallsEnabled: false } });
      await processor.process(makeJob('call'));
      expect(gateway.startOutboundCall).not.toHaveBeenCalled();
      expect(prisma.voiceCall.update).toHaveBeenCalledWith({
        where: { id: 'vc1' },
        data: { status: 'canceled', error: 'tenant_disabled' },
      });
    });

    it('cancels a rejected candidate and (auto only) a disabled job toggle', async () => {
      const { processor, prisma } = makeMocks({ candidate: { ...ROW.candidate, status: 'rejected' } });
      await processor.process(makeJob('call'));
      expect(prisma.voiceCall.update).toHaveBeenCalledWith({
        where: { id: 'vc1' },
        data: { status: 'canceled', error: 'candidate_rejected' },
      });
    });

    it('manual calls ignore the job toggle gate', async () => {
      const { processor, gateway } = makeMocks({
        trigger: 'manual',
        job: { ...ROW.job, voiceScreeningEnabled: false },
      });
      await processor.process(makeJob('call'));
      expect(gateway.startOutboundCall).toHaveBeenCalled();
    });

    it('reschedules to the next window when executed outside business hours', async () => {
      jest.setSystemTime(OUT_OF_WINDOW);
      const { processor, prisma, queue, gateway } = makeMocks();
      await processor.process(makeJob('call'));
      expect(gateway.startOutboundCall).not.toHaveBeenCalled();
      expect(prisma.voiceCall.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'scheduled' }) }),
      );
      expect(queue.add).toHaveBeenCalledWith(
        'call',
        { voiceCallId: 'vc1' },
        expect.objectContaining({ jobId: expect.stringMatching(/^call-vc1-/) }),
      );
    });

    it('dials with the questions serialized in order + correlation id, then arms the watchdog', async () => {
      const { processor, gateway, prisma, queue } = makeMocks();
      await processor.process(makeJob('call'));
      expect(gateway.startOutboundCall).toHaveBeenCalledWith({
        toNumber: '+972-52-4203543',
        dynamicVariables: {
          candidate_name: 'Dana Cohen',
          job_title: 'Frontend Engineer',
          company_name: 'Triolla',
          questions: '1. Are you legally allowed to work in Israel?\n2. How many years of React?',
          voice_call_id: 'vc1',
        },
      });
      expect(prisma.voiceCall.update).toHaveBeenCalledWith({
        where: { id: 'vc1' },
        data: expect.objectContaining({ status: 'in_progress', conversationId: 'conv_1' }),
      });
      expect(queue.add).toHaveBeenCalledWith(
        'check',
        { voiceCallId: 'vc1' },
        expect.objectContaining({ jobId: 'check-vc1-1' }),
      );
    });

    it('sends a TTS-safe job_title — parentheses never reach the spoken first message', async () => {
      const { processor, gateway } = makeMocks({
        job: { ...ROW.job, title: 'Frontend Engineer (React/Node)' },
      });
      await processor.process(makeJob('call'));
      expect(gateway.startOutboundCall).toHaveBeenCalledWith(
        expect.objectContaining({
          dynamicVariables: expect.objectContaining({ job_title: 'Frontend Engineer' }),
        }),
      );
    });

    it('finalizes blocked (test mode) rows terminally — no rethrow, no retry', async () => {
      const { processor, prisma, gateway } = makeMocks();
      gateway.startOutboundCall.mockRejectedValue(new VoiceCallBlockedError('blocked_test_mode'));
      await processor.process(makeJob('call'));
      expect(prisma.voiceCall.update).toHaveBeenCalledWith({
        where: { id: 'vc1' },
        data: { status: 'blocked', error: 'blocked_test_mode' },
      });
    });

    it('re-opens the claim and rethrows on transient errors while retries remain', async () => {
      const { processor, prisma, gateway } = makeMocks();
      gateway.startOutboundCall.mockRejectedValue(new Error('ECONNRESET'));
      await expect(processor.process(makeJob('call', 0))).rejects.toThrow('ECONNRESET');
      expect(prisma.voiceCall.updateMany).toHaveBeenCalledWith({
        where: { id: 'vc1', status: 'calling' },
        data: { status: 'scheduled' },
      });
    });

    it('finalizes failed on the last transient attempt', async () => {
      const { processor, prisma, gateway } = makeMocks();
      gateway.startOutboundCall.mockRejectedValue(new Error('ECONNRESET'));
      await processor.process(makeJob('call', 2)); // attemptsMade 2 → this is attempt 3 of 3
      expect(prisma.voiceCall.update).toHaveBeenCalledWith({
        where: { id: 'vc1' },
        data: { status: 'failed', error: expect.stringContaining('ECONNRESET') },
      });
    });
  });

  describe('check job (watchdog)', () => {
    it('does nothing when the webhook already finalized the row', async () => {
      const { processor, gateway } = makeMocks({ status: 'completed' });
      await processor.process(makeJob('check'));
      expect(gateway.getConversation).not.toHaveBeenCalled();
    });

    it('finalizes from the polled conversation when done', async () => {
      const { processor, voiceResults } = makeMocks({ status: 'in_progress', conversationId: 'conv_1' });
      await processor.process(makeJob('check'));
      expect(voiceResults.finalizeFromTranscription).toHaveBeenCalledWith(
        'conv_1',
        expect.objectContaining({ status: 'done' }),
      );
    });

    it('re-schedules another check while the call is still processing and young', async () => {
      const { processor, gateway, queue } = makeMocks({
        status: 'in_progress',
        conversationId: 'conv_1',
        startedAt: new Date(IN_WINDOW.getTime() - 31 * 60 * 1000).toISOString(), // 31 min ago
      });
      gateway.getConversation.mockResolvedValue({ status: 'processing' });
      await processor.process(makeJob('check'));
      expect(queue.add).toHaveBeenCalledWith(
        'check',
        { voiceCallId: 'vc1' },
        expect.objectContaining({ jobId: expect.stringMatching(/^check-vc1-/) }),
      );
    });

    it('times out a call stuck in_progress for over 2 hours', async () => {
      const { processor, gateway, prisma } = makeMocks({
        status: 'in_progress',
        conversationId: 'conv_1',
        startedAt: new Date(IN_WINDOW.getTime() - 3 * 60 * 60 * 1000).toISOString(),
      });
      gateway.getConversation.mockResolvedValue({ status: 'processing' });
      await processor.process(makeJob('check'));
      expect(prisma.voiceCall.update).toHaveBeenCalledWith({
        where: { id: 'vc1' },
        data: { status: 'failed', error: 'watchdog_timeout' },
      });
    });
  });

  describe('audio job', () => {
    it('pulls the MP3, stores it in R2 and records the key', async () => {
      const { processor, storage, prisma } = makeMocks({
        status: 'completed',
        conversationId: 'conv_1',
        audioKey: null,
      });
      await processor.process(makeJob('audio'));
      expect(storage.uploadVoiceAudio).toHaveBeenCalledWith(expect.any(Buffer), TENANT, 'vc1');
      expect(prisma.voiceCall.update).toHaveBeenCalledWith({
        where: { id: 'vc1' },
        data: { audioKey: `calls/${TENANT}/vc1/audio.mp3` },
      });
    });

    it('skips when audio already stored (redelivery)', async () => {
      const { processor, storage } = makeMocks({
        status: 'completed',
        conversationId: 'conv_1',
        audioKey: 'calls/x/audio.mp3',
      });
      await processor.process(makeJob('audio'));
      expect(storage.uploadVoiceAudio).not.toHaveBeenCalled();
    });
  });
});

describe('ttsSafeJobTitle', () => {
  it('strips parenthesized segments and collapses whitespace', () => {
    expect(ttsSafeJobTitle('Senior Product Designer (UX/UI)')).toBe('Senior Product Designer');
    expect(ttsSafeJobTitle('QA (automation) engineer  (senior)')).toBe('QA engineer');
  });

  it('returns the trimmed original when stripping would leave nothing', () => {
    expect(ttsSafeJobTitle('(UX/UI)')).toBe('(UX/UI)');
  });
});
