// Phase 11 Integration Tests: Jobs + Config endpoints
// Tests controller → service behavior using mocked Prisma (no live DB needed)
// Covers: GET /config, GET /jobs, POST /jobs, PUT /jobs/:id, DELETE /jobs/:id
// Covers: validation, error formats, tenant isolation, response format, happy paths

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { AppConfigController } from '../config/app-config/app-config.controller';
import { AppConfigService } from '../config/app-config/app-config.service';
import * as fs from 'fs';
import * as path from 'path';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_TENANT_ID = '22222222-2222-2222-2222-222222222222';

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeMockJob(overrides: Record<string, any> = {}) {
  return {
    id: 'job-uuid-1',
    tenantId: TENANT_ID,
    title: 'Senior Engineer',
    department: 'Engineering',
    location: 'Remote',
    jobType: 'full_time',
    status: 'open',
    hiringManager: 'Jane Smith',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    description: 'We build great things.',
    responsibilities: null,
    whatWeOffer: null,
    salaryRange: '80k-100k',
    mustHaveSkills: ['TypeScript', 'Node.js'],
    niceToHaveSkills: ['GraphQL'],
    expYearsMin: 3,
    expYearsMax: 7,
    preferredOrgTypes: ['startup'],
    hiringStages: [
      { id: 's1', name: 'Application Review', order: 1, isCustom: false, isEnabled: true, color: 'bg-zinc-400', interviewer: null },
      { id: 's2', name: 'Screening', order: 2, isCustom: false, isEnabled: true, color: 'bg-blue-500', interviewer: 'John' },
    ],
    screeningQuestions: [
      { id: 'q1', text: 'React experience?', answerType: 'yes_no', expectedAnswer: 'yes' },
    ],
    _count: { applications: 5 },
    ...overrides,
  };
}

function makeJobsServiceWithMocks(mockPrisma: any, tenantId = TENANT_ID) {
  const mockConfig = { get: jest.fn().mockReturnValue(tenantId) };
  return { service: new JobsService(mockPrisma as any, mockConfig as any), mockConfig };
}

function makeJobsController(mockPrisma: any) {
  const { service } = makeJobsServiceWithMocks(mockPrisma);
  return new JobsController(service);
}

// ─── GET /config ───────────────────────────────────────────────────────────────

describe('GET /config', () => {
  const configService = new AppConfigService();
  const configController = new AppConfigController(configService);

  it('returns 200 with all 6 fields', () => {
    const result = configController.getConfig();
    expect(result).toHaveProperty('departments');
    expect(result).toHaveProperty('hiring_managers');
    expect(result).toHaveProperty('job_types');
    expect(result).toHaveProperty('organization_types');
    expect(result).toHaveProperty('screening_question_types');
    expect(result).toHaveProperty('hiring_stages_template');
  });

  it('hiring_stages_template has exactly 8 elements', () => {
    const result = configController.getConfig();
    expect(result.hiring_stages_template).toHaveLength(8);
  });

  it('hiring_stages_template first element is Application Review with bg-zinc-400', () => {
    const result = configController.getConfig();
    expect(result.hiring_stages_template[0]).toMatchObject({
      name: 'Application Review',
      is_enabled: true,
      color: 'bg-zinc-400',
      is_custom: false,
      order: 1,
    });
  });

  it('hiring_stages_template has correct colors for all 8 stages', () => {
    const result = configController.getConfig();
    const colors = result.hiring_stages_template.map((s: any) => s.color);
    expect(colors).toEqual([
      'bg-zinc-400',
      'bg-blue-500',
      'bg-indigo-400',
      'bg-emerald-500',
      'bg-green-600',
      'bg-red-500',
      'bg-yellow-400',
      'bg-gray-500',
    ]);
  });

  it('job_types has full_time, part_time, contract', () => {
    const result = configController.getConfig();
    const ids = result.job_types.map((t: any) => t.id);
    expect(ids).toContain('full_time');
    expect(ids).toContain('part_time');
    expect(ids).toContain('contract');
  });

  it('response is identical on every call (hardcoded, no state)', () => {
    const r1 = configController.getConfig();
    const r2 = configController.getConfig();
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });
});

// ─── GET /jobs ─────────────────────────────────────────────────────────────────

describe('GET /jobs', () => {
  it('returns { jobs[], total } with nested hiring_flow and screening_questions', async () => {
    const mockJob = makeMockJob();
    const mockPrisma = { job: { findMany: jest.fn().mockResolvedValue([mockJob]) } };
    const controller = makeJobsController(mockPrisma);

    const result = await controller.findAll();

    expect(result).toHaveProperty('jobs');
    expect(result).toHaveProperty('total', 1);
    expect(result.jobs[0]).toHaveProperty('hiring_flow');
    expect(result.jobs[0]).toHaveProperty('screening_questions');
    expect(result.jobs[0].hiring_flow).toHaveLength(2);
    expect(result.jobs[0].screening_questions).toHaveLength(1);
  });

  it('candidate_count reflects applications count', async () => {
    const mockJob = makeMockJob({ _count: { applications: 12 } });
    const mockPrisma = { job: { findMany: jest.fn().mockResolvedValue([mockJob]) } };
    const controller = makeJobsController(mockPrisma);

    const result = await controller.findAll();
    expect(result.jobs[0].candidate_count).toBe(12);
  });

  it('uses snake_case field names in response', async () => {
    const mockJob = makeMockJob();
    const mockPrisma = { job: { findMany: jest.fn().mockResolvedValue([mockJob]) } };
    const controller = makeJobsController(mockPrisma);

    const result = await controller.findAll();
    const job = result.jobs[0];

    expect(job).toHaveProperty('job_type');
    expect(job).toHaveProperty('hiring_manager');
    expect(job).toHaveProperty('created_at');
    expect(job).toHaveProperty('must_have_skills');
    expect(job).toHaveProperty('nice_to_have_skills');
    expect(job).toHaveProperty('selected_org_types');
    expect(job).not.toHaveProperty('jobType');
    expect(job).not.toHaveProperty('hiringManager');
    expect(job).not.toHaveProperty('createdAt');
  });

  it('screening_questions have type field (not answerType)', async () => {
    const mockJob = makeMockJob();
    const mockPrisma = { job: { findMany: jest.fn().mockResolvedValue([mockJob]) } };
    const controller = makeJobsController(mockPrisma);

    const result = await controller.findAll();
    const q = result.jobs[0].screening_questions[0];
    expect(q).toHaveProperty('type', 'yes_no');
    expect(q).toHaveProperty('expected_answer', 'yes');
    expect(q).not.toHaveProperty('answerType');
    expect(q).not.toHaveProperty('expectedAnswer');
  });

  it('hiring_flow stages have color field', async () => {
    const mockJob = makeMockJob();
    const mockPrisma = { job: { findMany: jest.fn().mockResolvedValue([mockJob]) } };
    const controller = makeJobsController(mockPrisma);

    const result = await controller.findAll();
    const stage = result.jobs[0].hiring_flow[0];
    expect(stage).toHaveProperty('color');
    expect(stage.color).toMatch(/^bg-/);
  });

  it('hiring_flow stages have is_enabled field (not isEnabled)', async () => {
    const mockJob = makeMockJob();
    const mockPrisma = { job: { findMany: jest.fn().mockResolvedValue([mockJob]) } };
    const controller = makeJobsController(mockPrisma);

    const result = await controller.findAll();
    const stage = result.jobs[0].hiring_flow[0];
    expect(stage).toHaveProperty('is_enabled');
    expect(stage).not.toHaveProperty('isEnabled');
  });

  it('only returns jobs for the tenant (WHERE clause includes tenantId)', async () => {
    const mockPrisma = { job: { findMany: jest.fn().mockResolvedValue([]) } };
    const { service } = makeJobsServiceWithMocks(mockPrisma);

    await service.findAll();

    const findManyCall = mockPrisma.job.findMany.mock.calls[0][0];
    expect(findManyCall.where).toEqual({ tenantId: TENANT_ID });
  });

  it('returns empty jobs array when no jobs exist', async () => {
    const mockPrisma = { job: { findMany: jest.fn().mockResolvedValue([]) } };
    const controller = makeJobsController(mockPrisma);

    const result = await controller.findAll();
    expect(result.jobs).toHaveLength(0);
    expect(result.total).toBe(0);
  });
});

// ─── POST /jobs ────────────────────────────────────────────────────────────────

describe('POST /jobs', () => {
  function makePostPrisma(jobOverrides: Record<string, any> = {}) {
    const mockJob = makeMockJob(jobOverrides);
    const mockTx = { job: { create: jest.fn().mockResolvedValue(mockJob) } };
    return {
      mockTx,
      prisma: {
        $transaction: jest.fn().mockImplementation((cb: (tx: any) => any) => cb(mockTx)),
      },
    };
  }

  it('creates job with custom stages (no default seeding)', async () => {
    const { prisma, mockTx } = makePostPrisma({
      hiringStages: [{ id: 's1', name: 'Custom Stage', order: 1, isCustom: true, isEnabled: true, color: 'bg-blue-500', interviewer: null }],
    });
    const controller = makeJobsController(prisma);

    const payload = {
      title: 'Custom Job',
      job_type: 'full_time',
      status: 'draft',
      hiring_flow: [{ name: 'Custom Stage', order: 1, color: 'bg-blue-500', is_enabled: true, is_custom: true }],
    };

    const result = await controller.create(payload);
    expect(result).toHaveProperty('hiring_flow');

    const createCall = mockTx.job.create.mock.calls[0][0];
    expect(createCall.data.hiringStages.create).toHaveLength(1);
    expect(createCall.data.hiringStages.create[0].name).toBe('Custom Stage');
  });

  it('seeds 8 default stages if hiring_flow omitted', async () => {
    const { prisma, mockTx } = makePostPrisma();
    const controller = makeJobsController(prisma);

    await controller.create({ title: 'Default Job', job_type: 'full_time', status: 'draft' });

    const createCall = mockTx.job.create.mock.calls[0][0];
    expect(createCall.data.hiringStages.create).toHaveLength(8);
    expect(createCall.data.hiringStages.create[0].name).toBe('Application Review');
    expect(createCall.data.hiringStages.create[3].name).toBe('Offer');
  });

  it('creates screening_questions with type mapped to answerType in DB', async () => {
    const { prisma, mockTx } = makePostPrisma();
    const controller = makeJobsController(prisma);

    await controller.create({
      title: 'Job',
      job_type: 'full_time',
      status: 'draft',
      screening_questions: [{ text: 'React exp?', type: 'yes_no', expected_answer: 'yes' }],
    });

    const createCall = mockTx.job.create.mock.calls[0][0];
    expect(createCall.data.screeningQuestions.create).toHaveLength(1);
    expect(createCall.data.screeningQuestions.create[0].answerType).toBe('yes_no');
    expect(createCall.data.screeningQuestions.create[0].expectedAnswer).toBe('yes');
  });

  it('returns 400 VALIDATION_ERROR if title is missing', async () => {
    const { prisma } = makePostPrisma();
    const controller = makeJobsController(prisma);

    try {
      await controller.create({ job_type: 'full_time', status: 'draft' });
      fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      const response = (err as BadRequestException).getResponse() as any;
      expect(response.error.code).toBe('VALIDATION_ERROR');
      expect(response.error.details).toHaveProperty('title');
    }
  });

  it('returns 400 if job_type is invalid', async () => {
    const { prisma } = makePostPrisma();
    const controller = makeJobsController(prisma);

    try {
      await controller.create({ title: 'Job', job_type: 'invalid_type', status: 'draft' });
      fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      const response = (err as BadRequestException).getResponse() as any;
      expect(response.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('returns 400 if all hiring stages are disabled', async () => {
    const { prisma } = makePostPrisma();
    const controller = makeJobsController(prisma);

    try {
      await controller.create({
        title: 'Job',
        job_type: 'full_time',
        status: 'draft',
        hiring_flow: [{ name: 'S1', order: 1, color: 'bg-zinc-400', is_enabled: false, is_custom: false }],
      });
      fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      const response = (err as BadRequestException).getResponse() as any;
      expect(response.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('returns 400 if screening question type is invalid', async () => {
    const { prisma } = makePostPrisma();
    const controller = makeJobsController(prisma);

    await expect(
      controller.create({
        title: 'Job',
        job_type: 'full_time',
        status: 'draft',
        screening_questions: [{ text: 'Q?', type: 'invalid_type' }],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('error response includes standard format { error: { code, message, details } }', async () => {
    const { prisma } = makePostPrisma();
    const controller = makeJobsController(prisma);

    try {
      await controller.create({});
      fail('should have thrown');
    } catch (err) {
      const response = (err as BadRequestException).getResponse() as any;
      expect(response).toHaveProperty('error');
      expect(response.error).toHaveProperty('code');
      expect(response.error).toHaveProperty('message');
      expect(response.error).toHaveProperty('details');
    }
  });

  it('creates job with interviewer field stored on hiring stage', async () => {
    const { prisma, mockTx } = makePostPrisma();
    const controller = makeJobsController(prisma);

    await controller.create({
      title: 'Job',
      job_type: 'full_time',
      status: 'draft',
      hiring_flow: [{ name: 'Interview', order: 1, color: 'bg-indigo-400', is_enabled: true, is_custom: false, interviewer: 'John Doe' }],
    });

    const createCall = mockTx.job.create.mock.calls[0][0];
    expect(createCall.data.hiringStages.create[0].interviewer).toBe('John Doe');
  });
});

// ─── PUT /jobs/:id ─────────────────────────────────────────────────────────────

describe('PUT /jobs/:id', () => {
  function makePutPrisma(jobOverrides: Record<string, any> = {}) {
    const mockJob = makeMockJob(jobOverrides);
    const mockTx = { job: { update: jest.fn().mockResolvedValue(mockJob) } };
    return {
      mockTx,
      prisma: {
        job: { findFirstOrThrow: jest.fn().mockResolvedValue(mockJob) },
        $transaction: jest.fn().mockImplementation((cb: (tx: any) => any) => cb(mockTx)),
      },
    };
  }

  it('calls updateJob with id and validated dto', async () => {
    const { prisma } = makePutPrisma();
    const controller = makeJobsController(prisma);

    const payload = { title: 'Updated', job_type: 'full_time', status: 'open' };
    await controller.update('job-uuid-1', payload);

    expect(prisma.job.findFirstOrThrow).toHaveBeenCalledWith({
      where: { id: 'job-uuid-1', tenantId: TENANT_ID },
    });
  });

  it('returns updated job with snake_case fields', async () => {
    const { prisma } = makePutPrisma({ title: 'Updated Title' });
    const controller = makeJobsController(prisma);

    const result = await controller.update('job-uuid-1', { title: 'Updated Title', job_type: 'full_time', status: 'open' });
    expect(result).toHaveProperty('job_type');
    expect(result).toHaveProperty('hiring_flow');
    expect(result).toHaveProperty('screening_questions');
  });

  it('delete-and-recreate pattern: omitted stages are removed', async () => {
    const { prisma, mockTx } = makePutPrisma();
    const controller = makeJobsController(prisma);

    await controller.update('job-uuid-1', {
      title: 'Test',
      job_type: 'full_time',
      status: 'draft',
      hiring_flow: [{ name: 'Only Stage', order: 1, color: 'bg-zinc-400', is_enabled: true, is_custom: false }],
    });

    const updateCall = mockTx.job.update.mock.calls[0][0];
    expect(updateCall.data.hiringStages.deleteMany).toEqual({});
    expect(updateCall.data.hiringStages.create).toHaveLength(1);
    expect(updateCall.data.hiringStages.create[0].name).toBe('Only Stage');
  });

  it('returns 400 VALIDATION_ERROR when validation fails', async () => {
    const { prisma } = makePutPrisma();
    const controller = makeJobsController(prisma);

    try {
      await controller.update('job-uuid-1', {});
      fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      const response = (err as BadRequestException).getResponse() as any;
      expect(response.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('returns 404 NOT_FOUND when job does not exist', async () => {
    const { prisma } = makePutPrisma();
    prisma.job.findFirstOrThrow.mockRejectedValue({ code: 'P2025' });
    const controller = makeJobsController(prisma);

    try {
      await controller.update('nonexistent', { title: 'T', job_type: 'full_time', status: 'draft' });
      fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundException);
      const response = (err as NotFoundException).getResponse() as any;
      expect(response.error.code).toBe('NOT_FOUND');
    }
  });

  it('returns 404 for job from different tenant (tenant isolation)', async () => {
    const mockJob = makeMockJob({ tenantId: OTHER_TENANT_ID });
    const mockTx = { job: { update: jest.fn().mockResolvedValue(mockJob) } };
    const otherTenantPrisma = {
      job: { findFirstOrThrow: jest.fn().mockRejectedValue({ code: 'P2025' }) },
      $transaction: jest.fn().mockImplementation((cb: (tx: any) => any) => cb(mockTx)),
    };
    const controller = makeJobsController(otherTenantPrisma);

    await expect(
      controller.update('job-from-other-tenant', { title: 'T', job_type: 'full_time', status: 'draft' }),
    ).rejects.toThrow(NotFoundException);
  });
});

// ─── DELETE /jobs/:id ──────────────────────────────────────────────────────────

describe('DELETE /jobs/:id', () => {
  it('soft-deletes job by setting status=closed', async () => {
    const mockPrisma = {
      job: {
        findFirst: jest.fn().mockResolvedValue({ id: 'job-1', tenantId: TENANT_ID, status: 'open' }),
        update: jest.fn().mockResolvedValue({ id: 'job-1', status: 'closed' }),
      },
    };
    const controller = makeJobsController(mockPrisma);

    await controller.delete('job-1');

    expect(mockPrisma.job.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: { status: 'closed' },
    });
  });

  it('does NOT hard-delete (update is called, not delete)', async () => {
    const mockPrisma = {
      job: {
        findFirst: jest.fn().mockResolvedValue({ id: 'job-1', tenantId: TENANT_ID }),
        update: jest.fn().mockResolvedValue({ id: 'job-1', status: 'closed' }),
        delete: jest.fn(),
      },
    };
    const controller = makeJobsController(mockPrisma);

    await controller.delete('job-1');

    expect(mockPrisma.job.update).toHaveBeenCalled();
    expect(mockPrisma.job.delete).not.toHaveBeenCalled();
  });

  it('returns 404 NOT_FOUND when job does not exist', async () => {
    const mockPrisma = {
      job: {
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
    };
    const controller = makeJobsController(mockPrisma);

    try {
      await controller.delete('nonexistent');
      fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundException);
      const response = (err as NotFoundException).getResponse() as any;
      expect(response.error.code).toBe('NOT_FOUND');
    }
  });

  it('returns 404 for job from different tenant (tenant isolation)', async () => {
    const mockPrisma = {
      job: {
        // findFirst filters by tenantId, returns null for cross-tenant access
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
    };
    const { service } = makeJobsServiceWithMocks(mockPrisma, TENANT_ID);
    const controller = new JobsController(service);

    await expect(controller.delete('job-from-other-tenant')).rejects.toThrow(NotFoundException);
  });
});

// ─── Response Format Tests ────────────────────────────────────────────────────

describe('Response Format', () => {
  it('GET /jobs includes all fields from API_PROTOCOL_MVP.md', async () => {
    const mockJob = makeMockJob();
    const mockPrisma = { job: { findMany: jest.fn().mockResolvedValue([mockJob]) } };
    const controller = makeJobsController(mockPrisma);

    const result = await controller.findAll();
    const job = result.jobs[0];

    // All required API response fields
    expect(job).toHaveProperty('id');
    expect(job).toHaveProperty('title');
    expect(job).toHaveProperty('department');
    expect(job).toHaveProperty('location');
    expect(job).toHaveProperty('job_type');
    expect(job).toHaveProperty('status');
    expect(job).toHaveProperty('hiring_manager');
    expect(job).toHaveProperty('candidate_count');
    expect(job).toHaveProperty('created_at');
    expect(job).toHaveProperty('updated_at');
    expect(job).toHaveProperty('description');
    expect(job).toHaveProperty('responsibilities');
    expect(job).toHaveProperty('what_we_offer');
    expect(job).toHaveProperty('salary_range');
    expect(job).toHaveProperty('must_have_skills');
    expect(job).toHaveProperty('nice_to_have_skills');
    expect(job).toHaveProperty('min_experience');
    expect(job).toHaveProperty('max_experience');
    expect(job).toHaveProperty('selected_org_types');
    expect(job).toHaveProperty('screening_questions');
    expect(job).toHaveProperty('hiring_flow');
  });

  it('hiring_flow stages include: id, name, is_enabled, interviewer, color, is_custom, order', async () => {
    const mockJob = makeMockJob();
    const mockPrisma = { job: { findMany: jest.fn().mockResolvedValue([mockJob]) } };
    const controller = makeJobsController(mockPrisma);

    const result = await controller.findAll();
    const stage = result.jobs[0].hiring_flow[0];

    expect(stage).toHaveProperty('id');
    expect(stage).toHaveProperty('name');
    expect(stage).toHaveProperty('is_enabled');
    expect(stage).toHaveProperty('interviewer');
    expect(stage).toHaveProperty('color');
    expect(stage).toHaveProperty('is_custom');
    expect(stage).toHaveProperty('order');
  });

  it('screening_questions include: id, text, type, expected_answer (not answerType)', async () => {
    const mockJob = makeMockJob();
    const mockPrisma = { job: { findMany: jest.fn().mockResolvedValue([mockJob]) } };
    const controller = makeJobsController(mockPrisma);

    const result = await controller.findAll();
    const q = result.jobs[0].screening_questions[0];

    expect(q).toHaveProperty('id');
    expect(q).toHaveProperty('text');
    expect(q).toHaveProperty('type');
    expect(q).toHaveProperty('expected_answer');
    expect(q).not.toHaveProperty('answerType');
    expect(q).not.toHaveProperty('required');
    expect(q).not.toHaveProperty('knockout');
  });
});

// ─── Backward Compatibility ────────────────────────────────────────────────────

describe('Backward Compatibility', () => {
  it('D-01: Job.description field still exists in JobsService', () => {
    const serviceSource = fs.readFileSync(
      path.join(__dirname, 'jobs.service.ts'),
      'utf8',
    );
    expect(serviceSource).toContain('description');
  });

  it('D-02: ApplicationsService still has stage: a.stage mapping', () => {
    const appServiceSource = fs.readFileSync(
      path.join(__dirname, '../applications/applications.service.ts'),
      'utf8',
    );
    expect(appServiceSource).toContain('stage: a.stage');
  });

  it('D-03: ScoringAgentService is not imported from JobsService', () => {
    const serviceSource = fs.readFileSync(
      path.join(__dirname, 'jobs.service.ts'),
      'utf8',
    );
    expect(serviceSource).not.toContain('ScoringAgentService');
  });
});
