import { VoiceResultsService } from './voice-results.service';

const TENANT = '11111111-1111-1111-1111-111111111111';
const ROW = {
  id: 'vc1',
  tenantId: TENANT,
  candidateId: 'cand1',
  jobId: 'job1',
  status: 'in_progress',
  trigger: 'auto',
  attempt: 1,
  conversationId: 'conv_1',
};

const TRANSCRIPTION_DATA = {
  conversation_id: 'conv_1',
  status: 'done',
  has_audio: true,
  transcript: [
    { role: 'agent', message: 'Hi, is this Dana?', time_in_call_secs: 0, tool_calls: [{ big: 'blob' }] },
    { role: 'user', message: 'Yes, speaking', time_in_call_secs: 4 },
  ],
  analysis: {
    transcript_summary: 'Dana confirmed 5 years of React experience.',
    call_successful: 'success',
    data_collection_results: { answers: { value: '1. Yes\n2. 5 years' } },
    evaluation_criteria_results: { call_completed: { result: 'success' } },
  },
  metadata: { call_duration_secs: 241, cost: 830 },
};

function makeMocks(rowOverrides: Partial<typeof ROW> | null = {}) {
  const row = rowOverrides === null ? null : { ...ROW, ...rowOverrides };
  const prisma = {
    voiceCall: {
      findUnique: jest.fn().mockResolvedValue(row),
      update: jest.fn().mockResolvedValue({}),
    },
    jobStage: { findFirst: jest.fn().mockResolvedValue({ id: 'stage-screening' }) },
    candidateStageSummary: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
    },
  };
  const queue = { add: jest.fn().mockResolvedValue({}) };
  const voiceCalls = { scheduleRetry: jest.fn().mockResolvedValue(undefined) };
  const svc = new VoiceResultsService(prisma as any, queue as any, voiceCalls as any);
  return { prisma, queue, voiceCalls, svc };
}

describe('VoiceResultsService', () => {
  describe('finalizeFromTranscription', () => {
    it('marks completed, maps summary/transcript/qa/duration/cost, and enqueues the audio pull', async () => {
      const { svc, prisma, queue } = makeMocks();
      await svc.finalizeFromTranscription('conv_1', TRANSCRIPTION_DATA);
      const update = prisma.voiceCall.update.mock.calls[0][0];
      expect(update.where).toEqual({ id: 'vc1' });
      expect(update.data.status).toBe('completed');
      expect(update.data.summary).toBe('Dana confirmed 5 years of React experience.');
      expect(update.data.durationSecs).toBe(241);
      expect(update.data.cost).toBe(830);
      // Transcript is trimmed to {role, message, time_in_call_secs} — tool_calls dropped
      expect(update.data.transcript).toEqual([
        { role: 'agent', message: 'Hi, is this Dana?', time_in_call_secs: 0 },
        { role: 'user', message: 'Yes, speaking', time_in_call_secs: 4 },
      ]);
      expect(update.data.qaResults).toEqual({
        data_collection_results: { answers: { value: '1. Yes\n2. 5 years' } },
        evaluation_criteria_results: { call_completed: { result: 'success' } },
        call_successful: 'success',
      });
      expect(queue.add).toHaveBeenCalledWith(
        'audio',
        { voiceCallId: 'vc1' },
        expect.objectContaining({ jobId: 'audio-vc1' }),
      );
    });

    it('ignores unknown conversation ids (200-and-log, never throw)', async () => {
      const { svc, prisma } = makeMocks(null);
      await expect(svc.finalizeFromTranscription('conv_unknown', TRANSCRIPTION_DATA)).resolves.toBeUndefined();
      expect(prisma.voiceCall.update).not.toHaveBeenCalled();
    });

    it('skips the audio pull when has_audio is false', async () => {
      const { svc, queue } = makeMocks();
      await svc.finalizeFromTranscription('conv_1', { ...TRANSCRIPTION_DATA, has_audio: false });
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('writes a Screening stage summary only when none exists (never overwrite a recruiter note)', async () => {
      const { svc, prisma } = makeMocks();
      await svc.finalizeFromTranscription('conv_1', TRANSCRIPTION_DATA);
      expect(prisma.candidateStageSummary.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tenantId: TENANT,
          candidateId: 'cand1',
          jobStageId: 'stage-screening',
          summary: expect.stringContaining('Dana confirmed'),
        }),
      });

      prisma.candidateStageSummary.findUnique.mockResolvedValue({ id: 'existing' });
      prisma.candidateStageSummary.create.mockClear();
      await svc.finalizeFromTranscription('conv_1', TRANSCRIPTION_DATA);
      expect(prisma.candidateStageSummary.create).not.toHaveBeenCalled();
    });

    it('skips write-through gracefully when the job has no "Screening" stage', async () => {
      const { svc, prisma } = makeMocks();
      prisma.jobStage.findFirst.mockResolvedValue(null);
      await expect(svc.finalizeFromTranscription('conv_1', TRANSCRIPTION_DATA)).resolves.toBeUndefined();
      expect(prisma.candidateStageSummary.create).not.toHaveBeenCalled();
    });
  });

  describe('handleInitiationFailure', () => {
    it('busy → no_answer + schedules a retry when attempts remain', async () => {
      const { svc, prisma, voiceCalls } = makeMocks();
      await svc.handleInitiationFailure('conv_1', 'busy');
      expect(prisma.voiceCall.update).toHaveBeenCalledWith({
        where: { id: 'vc1' },
        data: { status: 'no_answer', error: 'busy' },
      });
      expect(voiceCalls.scheduleRetry).toHaveBeenCalledWith(expect.objectContaining({ id: 'vc1', attempt: 1 }));
    });

    it('no retry after the final attempt', async () => {
      const { svc, voiceCalls } = makeMocks({ attempt: 3 });
      await svc.handleInitiationFailure('conv_1', 'no-answer');
      expect(voiceCalls.scheduleRetry).not.toHaveBeenCalled();
    });

    it('unknown reason → failed, no retry', async () => {
      const { svc, prisma, voiceCalls } = makeMocks();
      await svc.handleInitiationFailure('conv_1', 'unknown');
      expect(prisma.voiceCall.update).toHaveBeenCalledWith({
        where: { id: 'vc1' },
        data: { status: 'failed', error: 'unknown' },
      });
      expect(voiceCalls.scheduleRetry).not.toHaveBeenCalled();
    });

    it('is idempotent under webhook redelivery (already-final row → no second retry)', async () => {
      const { svc, prisma, voiceCalls } = makeMocks({ status: 'no_answer' });
      await svc.handleInitiationFailure('conv_1', 'busy');
      expect(prisma.voiceCall.update).not.toHaveBeenCalled();
      expect(voiceCalls.scheduleRetry).not.toHaveBeenCalled();
    });
  });

  describe('handleWebhookEvent', () => {
    it('dispatches post_call_transcription and swallows handler errors (never 5xx)', async () => {
      const { svc, prisma } = makeMocks();
      prisma.voiceCall.update.mockRejectedValue(new Error('db down'));
      await expect(
        svc.handleWebhookEvent({
          type: 'post_call_transcription',
          data: { conversation_id: 'conv_1', ...TRANSCRIPTION_DATA },
        }),
      ).resolves.toBeUndefined();
    });

    it('ignores post_call_audio (audio is pulled, not pushed) and unknown types', async () => {
      const { svc, prisma } = makeMocks();
      await svc.handleWebhookEvent({
        type: 'post_call_audio',
        data: { conversation_id: 'conv_1', full_audio: 'AAAA' },
      });
      await svc.handleWebhookEvent({ type: 'some_future_event', data: { conversation_id: 'conv_1' } });
      expect(prisma.voiceCall.update).not.toHaveBeenCalled();
    });
  });
});
