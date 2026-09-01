import { BadRequestException, NotFoundException } from '@nestjs/common';
import { moveCandidateToStage } from './stage-move';

const TENANT = '11111111-1111-1111-1111-111111111111';

function makePrisma(overrides: Record<string, unknown> = {}) {
  const tx = {
    candidate: { update: jest.fn().mockResolvedValue({}) },
    application: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const prisma = {
    candidate: { findFirst: jest.fn().mockResolvedValue({ id: 'cand1', jobId: 'job1' }) },
    jobStage: { findFirst: jest.fn().mockResolvedValue({ id: 'stage2' }) },
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<void>) => fn(tx)),
    ...overrides,
  };
  return { prisma, tx };
}

describe('moveCandidateToStage', () => {
  it('updates candidate.hiringStageId and application.jobStageId atomically', async () => {
    const { prisma, tx } = makePrisma();
    await moveCandidateToStage(prisma as never, 'cand1', 'stage2', TENANT);
    expect(tx.candidate.update).toHaveBeenCalledWith({
      where: { id: 'cand1' },
      data: { hiringStageId: 'stage2' },
    });
    expect(tx.application.updateMany).toHaveBeenCalledWith({
      where: { candidateId: 'cand1', jobId: 'job1', tenantId: TENANT },
      data: { jobStageId: 'stage2' },
    });
  });

  it('NOT_FOUND when the candidate does not belong to the tenant', async () => {
    const { prisma } = makePrisma({ candidate: { findFirst: jest.fn().mockResolvedValue(null) } });
    await expect(moveCandidateToStage(prisma as never, 'cand1', 'stage2', TENANT)).rejects.toThrow(NotFoundException);
  });

  it('NO_JOB when the candidate is not linked to a job', async () => {
    const { prisma } = makePrisma({
      candidate: { findFirst: jest.fn().mockResolvedValue({ id: 'cand1', jobId: null }) },
    });
    await expect(moveCandidateToStage(prisma as never, 'cand1', 'stage2', TENANT)).rejects.toThrow(BadRequestException);
  });

  it('STAGE_NOT_FOUND when the stage belongs to another job', async () => {
    const { prisma } = makePrisma({ jobStage: { findFirst: jest.fn().mockResolvedValue(null) } });
    await expect(moveCandidateToStage(prisma as never, 'cand1', 'stage2', TENANT)).rejects.toThrow(NotFoundException);
  });
});
