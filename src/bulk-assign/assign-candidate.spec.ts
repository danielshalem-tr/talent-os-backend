import { NotFoundException, BadRequestException } from '@nestjs/common';
import { assignCandidateToJob } from './assign-candidate';
import { moveCandidateToStage } from '../candidates/stage-move';

jest.mock('../candidates/stage-move', () => ({ moveCandidateToStage: jest.fn().mockResolvedValue(undefined) }));

const moveMock = moveCandidateToStage as jest.Mock;

function makePrisma(overrides: Record<string, any> = {}) {
  return {
    candidate: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'cand-1',
        status: 'active',
        cvText: 'a real cv',
        currentRole: 'Backend Developer',
        yearsExperience: 6,
        skills: ['node.js'],
      }),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    job: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'job-1',
        title: 'Full Stack Developer',
        description: 'desc',
        mustHaveSkills: ['node.js'],
        status: 'open',
      }),
    },
    application: {
      upsert: jest.fn().mockResolvedValue({ id: 'app-1', jobStageId: null }),
    },
    jobStage: {
      findFirst: jest.fn().mockResolvedValue({ id: 'stage-1' }),
    },
    candidateJobScore: { upsert: jest.fn().mockResolvedValue({}) },
    ...overrides,
  } as any;
}

const scoringAgent = {
  score: jest.fn().mockResolvedValue({
    score: 84,
    reasoning: 'good fit',
    strengths: ['node.js'],
    gaps: [],
    modelUsed: 'openai/gpt-4o-mini',
  }),
} as any;

const params = { tenantId: 'tenant-1', candidateId: 'cand-1', jobId: 'job-1' };

describe('assignCandidateToJob', () => {
  beforeEach(() => jest.clearAllMocks());

  it('creates the application, sets the job, places the first stage and scores', async () => {
    const prisma = makePrisma();

    const result = await assignCandidateToJob(prisma, scoringAgent, params);

    expect(prisma.application.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { idx_applications_unique: { tenantId: 'tenant-1', candidateId: 'cand-1', jobId: 'job-1' } },
      }),
    );
    expect(prisma.candidate.update).toHaveBeenCalledWith({ where: { id: 'cand-1' }, data: { jobId: 'job-1' } });
    expect(moveMock).toHaveBeenCalledWith(prisma, 'cand-1', 'stage-1', 'tenant-1');
    expect(prisma.candidateJobScore.upsert).toHaveBeenCalled();
    expect(result).toEqual({ outcome: 'scored', score: 84 });
  });

  it('never moves a candidate who already has a stage on this job', async () => {
    const prisma = makePrisma({
      application: { upsert: jest.fn().mockResolvedValue({ id: 'app-1', jobStageId: 'stage-advanced' }) },
    });

    await assignCandidateToJob(prisma, scoringAgent, params);

    expect(moveMock).not.toHaveBeenCalled();
  });

  it('writes the denormalized score only when no override is sticky', async () => {
    const prisma = makePrisma();

    await assignCandidateToJob(prisma, scoringAgent, params);

    expect(prisma.candidate.updateMany).toHaveBeenCalledWith({
      where: { id: 'cand-1', isScoreOverridden: false },
      data: { aiScore: 84 },
    });
  });

  it('assigns without scoring when the candidate has no CV text', async () => {
    const prisma = makePrisma({
      candidate: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'cand-1',
          status: 'active',
          cvText: '   ',
          currentRole: null,
          yearsExperience: null,
          skills: [],
        }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    });

    const result = await assignCandidateToJob(prisma, scoringAgent, params);

    expect(scoringAgent.score).not.toHaveBeenCalled();
    expect(result).toEqual({ outcome: 'assigned_not_scored', score: null });
  });

  it('skips a rejected candidate without touching anything', async () => {
    const prisma = makePrisma({
      candidate: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'cand-1',
          status: 'rejected',
          cvText: 'cv',
          currentRole: null,
          yearsExperience: null,
          skills: [],
        }),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
    });

    const result = await assignCandidateToJob(prisma, scoringAgent, params);

    expect(result).toEqual({ outcome: 'skipped_inactive', score: null });
    expect(prisma.application.upsert).not.toHaveBeenCalled();
  });

  it('throws NOT_FOUND for a candidate outside the tenant', async () => {
    const prisma = makePrisma({ candidate: { findFirst: jest.fn().mockResolvedValue(null) } });
    await expect(assignCandidateToJob(prisma, scoringAgent, params)).rejects.toThrow(NotFoundException);
  });

  it('throws JOB_NOT_OPEN for a closed job', async () => {
    const prisma = makePrisma({
      job: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'job-1', title: 't', description: null, mustHaveSkills: [], status: 'closed' }),
      },
    });
    await expect(assignCandidateToJob(prisma, scoringAgent, params)).rejects.toThrow(BadRequestException);
  });
});
