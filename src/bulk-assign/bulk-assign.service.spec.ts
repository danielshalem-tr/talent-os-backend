import { BadRequestException, NotFoundException } from '@nestjs/common';
import { BulkAssignService } from './bulk-assign.service';

function makeService(overrides: { prisma?: any; queue?: any } = {}) {
  const prisma = overrides.prisma ?? {
    job: { findFirst: jest.fn().mockResolvedValue({ id: 'job-1', status: 'open' }) },
    jobStage: { findFirst: jest.fn().mockResolvedValue({ id: 'stage-1' }) },
    candidate: { findMany: jest.fn().mockResolvedValue([{ id: 'cand-1' }, { id: 'cand-2' }]) },
  };
  const queue = overrides.queue ?? { add: jest.fn().mockResolvedValue({}) };
  return { service: new BulkAssignService(prisma as any, queue as any), prisma, queue };
}

describe('BulkAssignService.enqueue', () => {
  it('enqueues one job per existing active candidate and returns the count', async () => {
    const { service, queue } = makeService();

    const result = await service.enqueue('tenant-1', { candidate_ids: ['cand-1', 'cand-2'], job_id: 'job-1' });

    expect(result).toEqual({ queued: 2 });
    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(queue.add).toHaveBeenCalledWith(
      'assign',
      { tenantId: 'tenant-1', candidateId: 'cand-1', jobId: 'job-1' },
      expect.objectContaining({ jobId: 'assign-cand-1-job-1' }),
    );
  });

  it('de-duplicates repeated candidate ids before querying', async () => {
    const { service, prisma } = makeService();

    await service.enqueue('tenant-1', { candidate_ids: ['cand-1', 'cand-1'], job_id: 'job-1' });

    expect(prisma.candidate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { in: ['cand-1'] } }) }),
    );
  });

  it('counts only the candidates that actually exist in the tenant', async () => {
    const { service } = makeService({
      prisma: {
        job: { findFirst: jest.fn().mockResolvedValue({ id: 'job-1', status: 'open' }) },
        jobStage: { findFirst: jest.fn().mockResolvedValue({ id: 'stage-1' }) },
        candidate: { findMany: jest.fn().mockResolvedValue([{ id: 'cand-1' }]) },
      },
    });

    await expect(service.enqueue('tenant-1', { candidate_ids: ['cand-1', 'ghost'], job_id: 'job-1' })).resolves.toEqual({
      queued: 1,
    });
  });

  it('404s when the job is not in the tenant', async () => {
    const { service } = makeService({
      prisma: {
        job: { findFirst: jest.fn().mockResolvedValue(null) },
        jobStage: { findFirst: jest.fn() },
        candidate: { findMany: jest.fn() },
      },
    });

    await expect(service.enqueue('tenant-1', { candidate_ids: ['cand-1'], job_id: 'job-x' })).rejects.toThrow(
      NotFoundException,
    );
  });

  it('400s when the job is not open', async () => {
    const { service } = makeService({
      prisma: {
        job: { findFirst: jest.fn().mockResolvedValue({ id: 'job-1', status: 'closed' }) },
        jobStage: { findFirst: jest.fn() },
        candidate: { findMany: jest.fn() },
      },
    });

    await expect(service.enqueue('tenant-1', { candidate_ids: ['cand-1'], job_id: 'job-1' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('400s when the job has no enabled stages', async () => {
    const { service } = makeService({
      prisma: {
        job: { findFirst: jest.fn().mockResolvedValue({ id: 'job-1', status: 'open' }) },
        jobStage: { findFirst: jest.fn().mockResolvedValue(null) },
        candidate: { findMany: jest.fn() },
      },
    });

    await expect(service.enqueue('tenant-1', { candidate_ids: ['cand-1'], job_id: 'job-1' })).rejects.toThrow(
      BadRequestException,
    );
  });
});
