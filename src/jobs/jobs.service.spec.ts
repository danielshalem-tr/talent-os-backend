import { Test, TestingModule } from '@nestjs/testing';
import { JobsService } from './jobs.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { NotFoundException } from '@nestjs/common';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

const mockPrismaService = {
  job: {
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    findFirst: jest.fn(),
    findFirstOrThrow: jest.fn(),
  },
  $transaction: jest.fn(),
};

const mockConfigService = {
  get: jest.fn().mockReturnValue(TENANT_ID),
};

describe('JobsService', () => {
  let service: JobsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JobsService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<JobsService>(JobsService);
    jest.clearAllMocks();
    mockConfigService.get.mockReturnValue(TENANT_ID);
  });

  describe('createJob()', () => {
    const mockCreatedJob = {
      id: 'job-uuid',
      tenantId: TENANT_ID,
      title: 'Software Engineer',
      department: null,
      location: null,
      jobType: 'full_time',
      status: 'draft',
      hiringManager: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      description: null,
      responsibilities: null,
      whatWeOffer: null,
      salaryRange: null,
      mustHaveSkills: [],
      niceToHaveSkills: [],
      expYearsMin: null,
      expYearsMax: null,
      preferredOrgTypes: [],
      hiringStages: [
        { id: 's1', name: 'Application Review', order: 1, isCustom: false, isEnabled: true, color: 'bg-zinc-400', interviewer: null, tenantId: TENANT_ID },
        { id: 's2', name: 'Screening', order: 2, isCustom: false, isEnabled: true, color: 'bg-blue-500', interviewer: null, tenantId: TENANT_ID },
        { id: 's3', name: 'Interview', order: 3, isCustom: false, isEnabled: true, color: 'bg-indigo-400', interviewer: null, tenantId: TENANT_ID },
        { id: 's4', name: 'Offer', order: 4, isCustom: false, isEnabled: true, color: 'bg-emerald-500', interviewer: null, tenantId: TENANT_ID },
      ],
      screeningQuestions: [],
      _count: { candidates: 0 },
    };

    beforeEach(() => {
      // $transaction mock: call the callback with the mock tx
      mockPrismaService.$transaction.mockImplementation((cb: (tx: any) => any) => cb(mockPrismaService));
      mockPrismaService.job.create.mockResolvedValue(mockCreatedJob);
    });

    it('D-04: auto-seeds 8 default stages when hiring_flow is omitted', async () => {
      await service.createJob({
        title: 'Eng',
        job_type: 'full_time',
        status: 'draft',
        must_have_skills: [],
        nice_to_have_skills: [],
        selected_org_types: [],
      });

      const callArgs = mockPrismaService.job.create.mock.calls[0][0];
      expect(callArgs.data.hiringStages.create).toHaveLength(8);
    });

    it('D-04: default stages are Application Review, Screening, Interview, Offer in order', async () => {
      await service.createJob({
        title: 'Eng',
        job_type: 'full_time',
        status: 'draft',
        must_have_skills: [],
        nice_to_have_skills: [],
        selected_org_types: [],
      });

      const callArgs = mockPrismaService.job.create.mock.calls[0][0];
      const stages = callArgs.data.hiringStages.create;
      expect(stages[0]).toMatchObject({ name: 'Application Review', order: 1 });
      expect(stages[1]).toMatchObject({ name: 'Screening', order: 2 });
      expect(stages[2]).toMatchObject({ name: 'Interview', order: 3 });
      expect(stages[3]).toMatchObject({ name: 'Offer', order: 4 });
    });

    it('D-05: auto-seeded stages have isCustom=false', async () => {
      await service.createJob({
        title: 'Eng',
        job_type: 'full_time',
        status: 'draft',
        must_have_skills: [],
        nice_to_have_skills: [],
        selected_org_types: [],
      });

      const callArgs = mockPrismaService.job.create.mock.calls[0][0];
      const stages = callArgs.data.hiringStages.create;
      stages.forEach((stage: { isCustom: boolean }) => {
        expect(stage.isCustom).toBe(false);
      });
    });

    it('D-07: uses provided hiring_flow when supplied in dto', async () => {
      await service.createJob({
        title: 'Eng',
        job_type: 'full_time',
        status: 'draft',
        must_have_skills: [],
        nice_to_have_skills: [],
        selected_org_types: [],
        hiring_flow: [{ name: 'Custom', order: 1, color: 'bg-blue-500', is_enabled: true, is_custom: true }],
      });

      const callArgs = mockPrismaService.job.create.mock.calls[0][0];
      expect(callArgs.data.hiringStages.create).toHaveLength(1);
      expect(callArgs.data.hiringStages.create[0].name).toBe('Custom');
    });

    it('D-06: creates screeningQuestions from dto.screening_questions', async () => {
      await service.createJob({
        title: 'Eng',
        job_type: 'full_time',
        status: 'draft',
        must_have_skills: [],
        nice_to_have_skills: [],
        selected_org_types: [],
        screening_questions: [{ text: 'Q?', type: 'yes_no' }],
      });

      const callArgs = mockPrismaService.job.create.mock.calls[0][0];
      expect(callArgs.data.screeningQuestions.create).toHaveLength(1);
      expect(callArgs.data.screeningQuestions.create[0].text).toBe('Q?');
    });

    it('D-06: assigns tenantId from ConfigService to all nested creates', async () => {
      await service.createJob({
        title: 'Eng',
        job_type: 'full_time',
        status: 'draft',
        must_have_skills: [],
        nice_to_have_skills: [],
        selected_org_types: [],
      });

      const callArgs = mockPrismaService.job.create.mock.calls[0][0];
      const stages = callArgs.data.hiringStages.create;
      stages.forEach((stage: { tenantId: string }) => {
        expect(stage.tenantId).toBe(TENANT_ID);
      });
      expect(callArgs.data.tenantId).toBe(TENANT_ID);
    });

    it('D-09: interviewer on JobStage is free text string, not UUID-validated', async () => {
      await expect(
        service.createJob({
          title: 'Eng',
          job_type: 'full_time',
          status: 'draft',
          must_have_skills: [],
          nice_to_have_skills: [],
          selected_org_types: [],
          hiring_flow: [{ name: 'Review', order: 1, color: 'bg-zinc-400', is_enabled: true, is_custom: false, interviewer: 'John Smith (not a UUID)' }],
        }),
      ).resolves.not.toThrow();
    });

    it('response uses snake_case field names', async () => {
      const result = await service.createJob({
        title: 'Eng',
        job_type: 'full_time',
        status: 'draft',
        must_have_skills: [],
        nice_to_have_skills: [],
        selected_org_types: [],
      });

      expect(result).toHaveProperty('job_type');
      expect(result).toHaveProperty('hiring_flow');
      expect(result).toHaveProperty('screening_questions');
      expect(result).not.toHaveProperty('jobType');
      expect(result).not.toHaveProperty('hiringStages');
    });
  });

  describe('findAll()', () => {
    const mockJob = {
      id: 'job-1',
      tenantId: TENANT_ID,
      title: 'Senior Frontend Developer',
      department: 'Engineering',
      location: 'Remote',
      jobType: 'full_time',
      status: 'open',
      hiringManager: 'Jane Smith',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      description: null,
      responsibilities: null,
      whatWeOffer: null,
      salaryRange: null,
      mustHaveSkills: [],
      niceToHaveSkills: [],
      expYearsMin: null,
      expYearsMax: null,
      preferredOrgTypes: [],
      hiringStages: [
        { id: 's1', name: 'Interview', order: 1, isCustom: false, isEnabled: true, color: 'bg-indigo-400', interviewer: null },
      ],
      screeningQuestions: [
        { id: 'q1', text: 'React exp?', answerType: 'yes_no', expectedAnswer: 'yes' },
      ],
      _count: { candidates: 5 },
    };

    beforeEach(() => {
      mockPrismaService.job.findMany.mockResolvedValue([mockJob]);
    });

    it('returns { jobs[], total } shape with mapped snake_case fields', async () => {
      const result = await service.findAll();

      expect(result).toHaveProperty('jobs');
      expect(result).toHaveProperty('total');
      expect(Array.isArray(result.jobs)).toBe(true);
      expect(result.total).toBe(1);

      const job = result.jobs[0];
      expect(job.id).toBe('job-1');
      expect(job.title).toBe('Senior Frontend Developer');
      expect(job).toHaveProperty('job_type', 'full_time');
      expect(job).toHaveProperty('hiring_manager', 'Jane Smith');
    });

    it('candidate_count = _count.applications from Prisma', async () => {
      const result = await service.findAll();
      expect(result.jobs[0].candidate_count).toBe(5);
    });

    it('total = jobs.length', async () => {
      const result = await service.findAll();
      expect(result.total).toBe(1);
    });

    it('returns nested hiring_flow with correct fields', async () => {
      const result = await service.findAll();
      const stage = result.jobs[0].hiring_flow[0];
      expect(stage).toHaveProperty('is_enabled', true);
      expect(stage).toHaveProperty('color', 'bg-indigo-400');
      expect(stage).toHaveProperty('is_custom', false);
      expect(stage).not.toHaveProperty('isEnabled');
    });

    it('returns screening_questions with type field (not answerType)', async () => {
      const result = await service.findAll();
      const q = result.jobs[0].screening_questions[0];
      expect(q).toHaveProperty('type', 'yes_no');
      expect(q).toHaveProperty('expected_answer', 'yes');
      expect(q).not.toHaveProperty('answerType');
      expect(q).not.toHaveProperty('expectedAnswer');
    });

    it('snake_case fields (job_type, hiring_manager, created_at, candidate_count) are present', async () => {
      const result = await service.findAll();
      const job = result.jobs[0];
      expect(job).toHaveProperty('job_type', 'full_time');
      expect(job).toHaveProperty('hiring_manager', 'Jane Smith');
      expect(job).toHaveProperty('created_at');
      expect(job).toHaveProperty('candidate_count', 5);
      expect(job).not.toHaveProperty('jobType');
      expect(job).not.toHaveProperty('hiringManager');
      expect(job).not.toHaveProperty('createdAt');
    });

    it('WHERE clause includes tenantId from ConfigService', async () => {
      mockPrismaService.job.findMany.mockResolvedValue([]);

      await service.findAll();

      expect(mockConfigService.get).toHaveBeenCalledWith('TENANT_ID');
      const findManyCall = mockPrismaService.job.findMany.mock.calls[0][0];
      expect(findManyCall.where).toEqual({ tenantId: TENANT_ID });
    });

    it('passes status filter to Prisma when provided', async () => {
      mockPrismaService.job.findMany.mockResolvedValue([]);

      await service.findAll('open');

      const findManyCall = mockPrismaService.job.findMany.mock.calls[0][0];
      expect(findManyCall.where).toEqual({ tenantId: TENANT_ID, status: 'open' });
    });

    it('omits status filter when not provided', async () => {
      mockPrismaService.job.findMany.mockResolvedValue([]);

      await service.findAll();

      const findManyCall = mockPrismaService.job.findMany.mock.calls[0][0];
      expect(findManyCall.where).toEqual({ tenantId: TENANT_ID });
      expect(findManyCall.where).not.toHaveProperty('status');
    });
  });

  describe('deleteJob()', () => {
    it('soft-deletes by setting status=closed', async () => {
      mockPrismaService.job.findFirst.mockResolvedValue({ id: 'job-1', tenantId: TENANT_ID, status: 'open' });
      mockPrismaService.job.update.mockResolvedValue({ id: 'job-1', status: 'closed' });

      await service.deleteJob('job-1');

      expect(mockPrismaService.job.update).toHaveBeenCalledWith({
        where: { id: 'job-1' },
        data: { status: 'closed' },
      });
    });

    it('throws NotFoundException if job not found', async () => {
      mockPrismaService.job.findFirst.mockResolvedValue(null);

      await expect(service.deleteJob('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('hardDeleteJob()', () => {
    beforeEach(() => {
      // Add job.delete to the mock (not present in the original top-level mock)
      (mockPrismaService.job as any).delete = jest.fn().mockResolvedValue({ id: 'job-1' });
    });

    it('throws NotFoundException when job does not exist', async () => {
      mockPrismaService.job.findFirst.mockResolvedValue(null);
      await expect(service.hardDeleteJob('nonexistent')).rejects.toThrow(NotFoundException);
    });

    it('scopes existence check to tenant', async () => {
      mockPrismaService.job.findFirst.mockResolvedValue({ id: 'job-1' });
      await service.hardDeleteJob('job-1');
      expect(mockPrismaService.job.findFirst).toHaveBeenCalledWith({
        where: { id: 'job-1', tenantId: TENANT_ID },
      });
    });

    it('calls prisma.job.delete (hard delete, not update)', async () => {
      mockPrismaService.job.findFirst.mockResolvedValue({ id: 'job-1' });
      await service.hardDeleteJob('job-1');
      expect((mockPrismaService.job as any).delete).toHaveBeenCalledWith({ where: { id: 'job-1' } });
      expect(mockPrismaService.job.update).not.toHaveBeenCalled();
    });

    it('does not call findFirst if job does not exist (throws before delete)', async () => {
      mockPrismaService.job.findFirst.mockResolvedValue(null);
      await expect(service.hardDeleteJob('job-1')).rejects.toThrow(NotFoundException);
      expect((mockPrismaService.job as any).delete).not.toHaveBeenCalled();
    });

    it('propagates unexpected errors from prisma.job.delete', async () => {
      mockPrismaService.job.findFirst.mockResolvedValue({ id: 'job-1' });
      (mockPrismaService.job as any).delete.mockRejectedValue(new Error('DB error'));
      await expect(service.hardDeleteJob('job-1')).rejects.toThrow('DB error');
    });
  });
});
