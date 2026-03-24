import { Test, TestingModule } from '@nestjs/testing';
import { JobsService } from './jobs.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

const mockPrismaService = {
  job: {
    findMany: jest.fn(),
    create: jest.fn(),
  },
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
      hiringStages: [
        { id: 's1', name: 'Application Review', order: 1, isCustom: false, tenantId: TENANT_ID },
        { id: 's2', name: 'Screening', order: 2, isCustom: false, tenantId: TENANT_ID },
        { id: 's3', name: 'Interview', order: 3, isCustom: false, tenantId: TENANT_ID },
        { id: 's4', name: 'Offer', order: 4, isCustom: false, tenantId: TENANT_ID },
      ],
      screeningQuestions: [],
    };

    beforeEach(() => {
      mockPrismaService.job.create.mockResolvedValue(mockCreatedJob);
    });

    it('D-04: auto-seeds 4 default stages when hiringStages is omitted', async () => {
      await service.createJob({ title: 'Eng', requirements: [], mustHaveSkills: [], niceToHaveSkills: [], preferredOrgTypes: [], jobType: 'full_time', status: 'draft' });

      const callArgs = mockPrismaService.job.create.mock.calls[0][0];
      expect(callArgs.data.hiringStages.create).toHaveLength(4);
    });

    it('D-04: default stages are Application Review, Screening, Interview, Offer in order', async () => {
      await service.createJob({ title: 'Eng', requirements: [], mustHaveSkills: [], niceToHaveSkills: [], preferredOrgTypes: [], jobType: 'full_time', status: 'draft' });

      const callArgs = mockPrismaService.job.create.mock.calls[0][0];
      const stages = callArgs.data.hiringStages.create;
      expect(stages[0]).toMatchObject({ name: 'Application Review', order: 1 });
      expect(stages[1]).toMatchObject({ name: 'Screening', order: 2 });
      expect(stages[2]).toMatchObject({ name: 'Interview', order: 3 });
      expect(stages[3]).toMatchObject({ name: 'Offer', order: 4 });
    });

    it('D-05: auto-seeded stages have isCustom=false', async () => {
      await service.createJob({ title: 'Eng', requirements: [], mustHaveSkills: [], niceToHaveSkills: [], preferredOrgTypes: [], jobType: 'full_time', status: 'draft' });

      const callArgs = mockPrismaService.job.create.mock.calls[0][0];
      const stages = callArgs.data.hiringStages.create;
      stages.forEach((stage: { isCustom: boolean }) => {
        expect(stage.isCustom).toBe(false);
      });
    });

    it('D-07: uses provided hiringStages when supplied in dto', async () => {
      await service.createJob({
        title: 'Eng',
        requirements: [],
        mustHaveSkills: [],
        niceToHaveSkills: [],
        preferredOrgTypes: [],
        jobType: 'full_time',
        status: 'draft',
        hiringStages: [{ name: 'Custom', order: 1, isCustom: true }],
      });

      const callArgs = mockPrismaService.job.create.mock.calls[0][0];
      expect(callArgs.data.hiringStages.create).toHaveLength(1);
      expect(callArgs.data.hiringStages.create[0].name).toBe('Custom');
    });

    it('D-06: creates screeningQuestions from dto.screeningQuestions', async () => {
      await service.createJob({
        title: 'Eng',
        requirements: [],
        mustHaveSkills: [],
        niceToHaveSkills: [],
        preferredOrgTypes: [],
        jobType: 'full_time',
        status: 'draft',
        screeningQuestions: [{ text: 'Q?', answerType: 'yes_no', required: false, knockout: false }],
      });

      const callArgs = mockPrismaService.job.create.mock.calls[0][0];
      expect(callArgs.data.screeningQuestions.create).toHaveLength(1);
      expect(callArgs.data.screeningQuestions.create[0].text).toBe('Q?');
    });

    it('D-06: assigns tenantId from ConfigService to all nested creates', async () => {
      await service.createJob({ title: 'Eng', requirements: [], mustHaveSkills: [], niceToHaveSkills: [], preferredOrgTypes: [], jobType: 'full_time', status: 'draft' });

      const callArgs = mockPrismaService.job.create.mock.calls[0][0];
      const stages = callArgs.data.hiringStages.create;
      stages.forEach((stage: { tenantId: string }) => {
        expect(stage.tenantId).toBe(TENANT_ID);
      });
      expect(callArgs.data.tenantId).toBe(TENANT_ID);
    });

    it('D-09: responsibleUserId on JobStage is free text string, not UUID-validated', async () => {
      await expect(
        service.createJob({
          title: 'Eng',
          requirements: [],
          mustHaveSkills: [],
          niceToHaveSkills: [],
          preferredOrgTypes: [],
          jobType: 'full_time',
          status: 'draft',
          hiringStages: [{ name: 'Review', order: 1, responsibleUserId: 'John Smith (not a UUID)', isCustom: false }],
        }),
      ).resolves.not.toThrow();
    });
  });

  describe('findAll', () => {
    it('Test 1: returns { jobs[], total } shape with mapped snake_case fields', async () => {
      mockPrismaService.job.findMany.mockResolvedValue([
        {
          id: 'job-1',
          tenantId: TENANT_ID,
          title: 'Senior Frontend Developer',
          department: 'Engineering',
          location: 'Remote',
          jobType: 'full_time',
          status: 'active',
          hiringManager: 'Jane Smith',
          createdAt: new Date('2026-01-01T00:00:00Z'),
          _count: { applications: 5 },
        },
      ]);

      const result = await service.findAll();

      expect(result).toHaveProperty('jobs');
      expect(result).toHaveProperty('total');
      expect(Array.isArray(result.jobs)).toBe(true);
      expect(result.total).toBe(1);

      const job = result.jobs[0];
      expect(job.id).toBe('job-1');
      expect(job.title).toBe('Senior Frontend Developer');
      expect(job.department).toBe('Engineering');
      expect(job.location).toBe('Remote');
    });

    it('Test 2: candidate_count = _count.applications from Prisma', async () => {
      mockPrismaService.job.findMany.mockResolvedValue([
        {
          id: 'job-1',
          tenantId: TENANT_ID,
          title: 'Backend Engineer',
          department: null,
          location: null,
          jobType: 'full_time',
          status: 'active',
          hiringManager: null,
          createdAt: new Date('2026-01-01T00:00:00Z'),
          _count: { applications: 12 },
        },
      ]);

      const result = await service.findAll();

      expect(result.jobs[0].candidate_count).toBe(12);
    });

    it('Test 3: total = jobs.length', async () => {
      mockPrismaService.job.findMany.mockResolvedValue([
        {
          id: 'job-1',
          tenantId: TENANT_ID,
          title: 'Job 1',
          department: null,
          location: null,
          jobType: 'full_time',
          status: 'active',
          hiringManager: null,
          createdAt: new Date(),
          _count: { applications: 0 },
        },
        {
          id: 'job-2',
          tenantId: TENANT_ID,
          title: 'Job 2',
          department: null,
          location: null,
          jobType: 'part_time',
          status: 'draft',
          hiringManager: null,
          createdAt: new Date(),
          _count: { applications: 3 },
        },
      ]);

      const result = await service.findAll();

      expect(result.total).toBe(2);
      expect(result.jobs).toHaveLength(2);
    });

    it('Test 4: returns jobs regardless of status (no status filter applied)', async () => {
      const allStatuses = ['active', 'draft', 'paused', 'closed'];
      mockPrismaService.job.findMany.mockResolvedValue(
        allStatuses.map((status, i) => ({
          id: `job-${i}`,
          tenantId: TENANT_ID,
          title: `Job ${i}`,
          department: null,
          location: null,
          jobType: 'full_time',
          status,
          hiringManager: null,
          createdAt: new Date(),
          _count: { applications: 0 },
        })),
      );

      const result = await service.findAll();

      // Verify no status filter was passed to findMany
      const findManyCall = mockPrismaService.job.findMany.mock.calls[0][0];
      expect(findManyCall.where).not.toHaveProperty('status');
      expect(result.total).toBe(4);
    });

    it('Test 5: snake_case fields (job_type, hiring_manager, created_at, candidate_count) are present', async () => {
      mockPrismaService.job.findMany.mockResolvedValue([
        {
          id: 'job-1',
          tenantId: TENANT_ID,
          title: 'Full Stack Dev',
          department: 'Engineering',
          location: 'Tel Aviv',
          jobType: 'contract',
          status: 'active',
          hiringManager: 'Bob Builder',
          createdAt: new Date('2026-01-15T00:00:00Z'),
          _count: { applications: 7 },
        },
      ]);

      const result = await service.findAll();
      const job = result.jobs[0];

      expect(job).toHaveProperty('job_type', 'contract');
      expect(job).toHaveProperty('hiring_manager', 'Bob Builder');
      expect(job).toHaveProperty('created_at');
      expect(job).toHaveProperty('candidate_count', 7);

      // camelCase fields should NOT be present
      expect(job).not.toHaveProperty('jobType');
      expect(job).not.toHaveProperty('hiringManager');
      expect(job).not.toHaveProperty('createdAt');
    });

    it('Test 6: WHERE clause includes tenantId from ConfigService', async () => {
      mockPrismaService.job.findMany.mockResolvedValue([]);

      await service.findAll();

      expect(mockConfigService.get).toHaveBeenCalledWith('TENANT_ID');
      const findManyCall = mockPrismaService.job.findMany.mock.calls[0][0];
      expect(findManyCall.where).toEqual({ tenantId: TENANT_ID });
    });
  });
});
