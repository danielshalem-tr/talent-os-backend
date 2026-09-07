import { ConflictException, ForbiddenException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { VoiceCallsService } from './voice-calls.service';
import { JwtPayload } from '../auth/jwt.service';

const TENANT = '11111111-1111-1111-1111-111111111111';
const CAND = '22222222-2222-2222-2222-222222222222';
const JOB = '33333333-3333-3333-3333-333333333333';
const session = (role: JwtPayload['role'] = 'admin'): JwtPayload => ({ sub: 'u1', org: TENANT, role });

function makeMocks() {
  const prisma = {
    voiceCall: {
      create: jest.fn().mockResolvedValue({ id: 'vc1', scheduledFor: new Date() }),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    organization: {
      findUnique: jest.fn().mockResolvedValue({ voiceCallsEnabled: true }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ voiceCallsEnabled: true }),
      update: jest.fn().mockResolvedValue({ voiceCallsEnabled: true }),
    },
    candidate: { findFirst: jest.fn().mockResolvedValue({ id: CAND, phone: '+972-52-4203543' }) },
    job: { findFirst: jest.fn().mockResolvedValue({ id: JOB }), findMany: jest.fn().mockResolvedValue([]) },
  };
  const queue = { add: jest.fn().mockResolvedValue({}), getJob: jest.fn().mockResolvedValue(null) };
  const gateway = {
    mode: jest.fn().mockReturnValue('test'),
    allowlist: jest.fn().mockReturnValue(new Set(['+972524203543'])),
    isConfigured: jest.fn().mockReturnValue(true),
  };
  const storage = { getObject: jest.fn().mockResolvedValue({ body: Buffer.from('mp3'), contentType: 'audio/mpeg' }) };
  const svc = new VoiceCallsService(prisma as any, queue as any, gateway as any, storage as any);
  return { prisma, queue, gateway, storage, svc };
}

describe('VoiceCallsService', () => {
  describe('scheduleCall', () => {
    it('creates a scheduled row and enqueues a delayed BullMQ job with dedup jobId', async () => {
      const { svc, prisma, queue } = makeMocks();
      prisma.voiceCall.create.mockResolvedValue({ id: 'vc1', scheduledFor: new Date() });
      const row = await svc.scheduleCall({
        tenantId: TENANT,
        candidateId: CAND,
        jobId: JOB,
        trigger: 'auto',
        idempotencyKey: `auto:${CAND}:${JOB}:1`,
      });
      expect(row).not.toBeNull();
      expect(prisma.voiceCall.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'scheduled', trigger: 'auto', attempt: 1 }),
        }),
      );
      expect(queue.add).toHaveBeenCalledWith(
        'call',
        { voiceCallId: 'vc1' },
        expect.objectContaining({ jobId: 'call-vc1', attempts: 3 }),
      );
    });

    it('swallows P2002 (idempotent under BullMQ re-runs) and returns null', async () => {
      const { svc, prisma, queue } = makeMocks();
      prisma.voiceCall.create.mockRejectedValue({ code: 'P2002' });
      const row = await svc.scheduleCall({
        tenantId: TENANT,
        candidateId: CAND,
        jobId: JOB,
        trigger: 'auto',
        idempotencyKey: 'dup',
      });
      expect(row).toBeNull();
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('re-arms a row whose enqueue failed instead of treating the P2002 as a duplicate', async () => {
      const { svc, prisma, queue } = makeMocks();
      prisma.voiceCall.create.mockRejectedValue({ code: 'P2002' });
      prisma.voiceCall.findFirst.mockResolvedValueOnce({ id: 'vc-stuck', status: 'failed', error: 'enqueue_failed' });
      prisma.voiceCall.update.mockResolvedValueOnce({ id: 'vc-stuck', status: 'scheduled', scheduledFor: new Date() });
      const row = await svc.scheduleCall({
        tenantId: TENANT,
        candidateId: CAND,
        jobId: JOB,
        trigger: 'auto',
        idempotencyKey: `auto:${CAND}:${JOB}:1`,
      });
      expect(row?.id).toBe('vc-stuck');
      expect(prisma.voiceCall.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'vc-stuck' },
          data: expect.objectContaining({ status: 'scheduled', error: null }),
        }),
      );
      expect(queue.add).toHaveBeenCalledWith('call', { voiceCallId: 'vc-stuck' }, expect.objectContaining({ jobId: 'call-vc-stuck' }));
    });

    it('rolls the row to failed when the enqueue throws (never strands scheduled)', async () => {
      const { svc, prisma, queue } = makeMocks();
      prisma.voiceCall.create.mockResolvedValue({ id: 'vc1', scheduledFor: new Date() });
      queue.add.mockRejectedValue(new Error('redis down'));
      await expect(
        svc.scheduleCall({ tenantId: TENANT, candidateId: CAND, jobId: JOB, trigger: 'auto' }),
      ).rejects.toThrow('redis down');
      expect(prisma.voiceCall.update).toHaveBeenCalledWith({
        where: { id: 'vc1' },
        data: { status: 'failed', error: 'enqueue_failed' },
      });
    });
  });

  describe('scheduleAutoCalls (layers 3+4 + threshold)', () => {
    it('does nothing when the tenant kill switch is off', async () => {
      const { svc, prisma } = makeMocks();
      prisma.organization.findUnique.mockResolvedValue({ voiceCallsEnabled: false });
      await svc.scheduleAutoCalls({ tenantId: TENANT, candidateId: CAND, jobScores: [{ jobId: JOB, score: 99 }] });
      expect(prisma.voiceCall.create).not.toHaveBeenCalled();
    });

    it('does nothing when the candidate has no phone', async () => {
      const { svc, prisma } = makeMocks();
      prisma.candidate.findFirst.mockResolvedValue({ id: CAND, phone: null });
      await svc.scheduleAutoCalls({ tenantId: TENANT, candidateId: CAND, jobScores: [{ jobId: JOB, score: 99 }] });
      expect(prisma.voiceCall.create).not.toHaveBeenCalled();
    });

    it('schedules only for enabled jobs whose score clears the threshold', async () => {
      const { svc, prisma } = makeMocks();
      const JOB2 = '44444444-4444-4444-4444-444444444444';
      prisma.job.findMany.mockResolvedValue([
        { id: JOB, voiceScreeningEnabled: true, voiceMinScore: 70 },
        { id: JOB2, voiceScreeningEnabled: true, voiceMinScore: 90 },
      ]);
      await svc.scheduleAutoCalls({
        tenantId: TENANT,
        candidateId: CAND,
        jobScores: [
          { jobId: JOB, score: 85 }, // clears 70 → schedule
          { jobId: JOB2, score: 85 }, // below 90 → skip
        ],
      });
      expect(prisma.voiceCall.create).toHaveBeenCalledTimes(1);
      expect(prisma.voiceCall.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ jobId: JOB, idempotencyKey: `auto:${CAND}:${JOB}:1` }),
        }),
      );
    });

    it('places ONE call for the best-scoring eligible job — never rings the same person per job', async () => {
      const { svc, prisma } = makeMocks();
      const JOB2 = '44444444-4444-4444-4444-444444444444';
      const JOB3 = '55555555-5555-5555-5555-555555555555';
      prisma.job.findMany.mockResolvedValue([
        { id: JOB, voiceScreeningEnabled: true, voiceMinScore: 70 },
        { id: JOB2, voiceScreeningEnabled: true, voiceMinScore: 70 },
        { id: JOB3, voiceScreeningEnabled: true, voiceMinScore: 70 },
      ]);
      await svc.scheduleAutoCalls({
        tenantId: TENANT,
        candidateId: CAND,
        jobScores: [
          { jobId: JOB, score: 75 },
          { jobId: JOB2, score: 93 },
          { jobId: JOB3, score: 88 },
        ],
      });
      expect(prisma.voiceCall.create).toHaveBeenCalledTimes(1);
      expect(prisma.voiceCall.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ jobId: JOB2 }) }),
      );
    });

    it('schedules nothing when the candidate already has an active call for ANY job', async () => {
      const { svc, prisma } = makeMocks();
      prisma.job.findMany.mockResolvedValue([{ id: JOB, voiceScreeningEnabled: true, voiceMinScore: 70 }]);
      prisma.voiceCall.findFirst.mockResolvedValue({ id: 'already-calling' });
      await svc.scheduleAutoCalls({ tenantId: TENANT, candidateId: CAND, jobScores: [{ jobId: JOB, score: 99 }] });
      expect(prisma.voiceCall.create).not.toHaveBeenCalled();
    });
  });

  describe('triggerManualCall', () => {
    it('403 for viewers', async () => {
      const { svc } = makeMocks();
      await expect(svc.triggerManualCall(CAND, JOB, session('viewer'))).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('422 NO_PHONE when the candidate has no phone', async () => {
      const { svc, prisma } = makeMocks();
      prisma.candidate.findFirst.mockResolvedValue({ id: CAND, phone: '  ' });
      await expect(svc.triggerManualCall(CAND, JOB, session())).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('409 VOICE_DISABLED when the tenant switch is off', async () => {
      const { svc, prisma } = makeMocks();
      prisma.organization.findUnique.mockResolvedValue({ voiceCallsEnabled: false });
      await expect(svc.triggerManualCall(CAND, JOB, session())).rejects.toBeInstanceOf(ConflictException);
    });

    it('409 CALL_ACTIVE when a scheduled/calling/in_progress call exists for the pair', async () => {
      const { svc, prisma } = makeMocks();
      prisma.voiceCall.findFirst.mockResolvedValue({ id: 'existing' });
      await expect(svc.triggerManualCall(CAND, JOB, session())).rejects.toBeInstanceOf(ConflictException);
    });

    it('schedules with trigger=manual, no idempotency key, and skips the job toggle/threshold', async () => {
      const { svc, prisma } = makeMocks();
      prisma.voiceCall.create.mockResolvedValue({
        id: 'vc1',
        jobId: JOB,
        status: 'scheduled',
        trigger: 'manual',
        attempt: 1,
        scheduledFor: new Date(),
        startedAt: null,
        durationSecs: null,
        summary: null,
        transcript: null,
        qaResults: null,
        audioKey: null,
        cost: null,
        error: null,
        createdAt: new Date(),
      });
      const result = await svc.triggerManualCall(CAND, JOB, session('member'));
      expect(result.trigger).toBe('manual');
      expect(prisma.voiceCall.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ trigger: 'manual', idempotencyKey: null }) }),
      );
      // Layer 4 (job toggle) is deliberately NOT consulted for manual calls
      expect(prisma.job.findMany).not.toHaveBeenCalled();
    });
  });

  describe('cancelCall', () => {
    it('claims only scheduled rows (count 0 → 409) and removes the delayed queue job best-effort', async () => {
      const { svc, prisma, queue } = makeMocks();
      const removed = jest.fn();
      queue.getJob.mockResolvedValue({ remove: removed });
      await svc.cancelCall(CAND, 'vc1', session());
      expect(prisma.voiceCall.updateMany).toHaveBeenCalledWith({
        where: { id: 'vc1', candidateId: CAND, tenantId: TENANT, status: 'scheduled' },
        data: { status: 'canceled', error: 'canceled_by_user' },
      });
      expect(removed).toHaveBeenCalled();

      prisma.voiceCall.updateMany.mockResolvedValue({ count: 0 });
      await expect(svc.cancelCall(CAND, 'vc1', session())).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('getAudioBytes / getStatus', () => {
    it('404s when the call has no stored audio', async () => {
      const { svc, prisma } = makeMocks();
      prisma.voiceCall.findFirst.mockResolvedValue({ id: 'vc1', audioKey: null });
      await expect(svc.getAudioBytes(CAND, 'vc1', TENANT)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('reports mode/allowlist/configured/scheduled_count', async () => {
      const { svc, prisma } = makeMocks();
      prisma.voiceCall.count.mockResolvedValue(3);
      const status = await svc.getStatus(session('viewer')); // status is readable by any role
      expect(status).toEqual({
        voice_calls_enabled: true,
        mode: 'test',
        allowlist_size: 1,
        configured: true,
        scheduled_count: 3,
      });
    });

    it('setEnabled is owner/admin-only', async () => {
      const { svc } = makeMocks();
      await expect(svc.setEnabled(session('member'), true)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
