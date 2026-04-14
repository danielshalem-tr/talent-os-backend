import { Test, TestingModule } from '@nestjs/testing';
import { ApplicationsService } from './applications.service';
import { PrismaService } from '../prisma/prisma.service';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

const mockPrismaService = {
  application: {
    findMany: jest.fn(),
  },
};

const makeMockApplication = (overrides: {
  id?: string;
  stage?: string;
  scores?: { score: number }[];
  candidate?: {
    id?: string;
    fullName?: string;
    email?: string | null;
    cvFileUrl?: string | null;
  };
} = {}) => ({
  id: overrides.id ?? 'app-1',
  tenantId: TENANT_ID,
  candidateId: 'cand-1',
  jobId: 'job-1',
  stage: overrides.stage ?? 'new',
  appliedAt: new Date('2026-01-01T00:00:00Z'),
  candidate: {
    id: overrides.candidate?.id ?? 'cand-1',
    fullName: overrides.candidate?.fullName ?? 'John Doe',
    email: overrides.candidate?.email !== undefined ? overrides.candidate.email : 'john@example.com',
    cvFileUrl: overrides.candidate?.cvFileUrl !== undefined ? overrides.candidate.cvFileUrl : 'https://r2.example.com/cv.pdf',
  },
  scores: overrides.scores ?? [],
});

describe('ApplicationsService', () => {
  let service: ApplicationsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApplicationsService,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    service = module.get<ApplicationsService>(ApplicationsService);
    jest.clearAllMocks();
  });

  describe('findAll', () => {
    it('Test 1: returns { applications: [...] } shape — no total field', async () => {
      mockPrismaService.application.findMany.mockResolvedValue([
        makeMockApplication(),
      ]);

      const result = await service.findAll(TENANT_ID);

      expect(result).toHaveProperty('applications');
      expect(Array.isArray(result.applications)).toBe(true);
      expect(result).not.toHaveProperty('total');
    });

    it('Test 2: snake_case fields — candidate_id and job_id on application', async () => {
      mockPrismaService.application.findMany.mockResolvedValue([
        makeMockApplication({ id: 'app-abc' }),
      ]);

      const result = await service.findAll(TENANT_ID);
      const app = result.applications[0];

      expect(app).toHaveProperty('id', 'app-abc');
      expect(app).toHaveProperty('candidate_id', 'cand-1');
      expect(app).toHaveProperty('job_id', 'job-1');
      expect(app).toHaveProperty('stage', 'new');
      expect(app).toHaveProperty('applied_at');

      // camelCase should NOT be present
      expect(app).not.toHaveProperty('candidateId');
      expect(app).not.toHaveProperty('jobId');
      expect(app).not.toHaveProperty('appliedAt');
    });

    it('Test 3: nested candidate object with id, full_name, email, cv_file_url, ai_score', async () => {
      mockPrismaService.application.findMany.mockResolvedValue([
        makeMockApplication({
          scores: [{ score: 85 }],
          candidate: {
            id: 'cand-42',
            fullName: 'Jane Smith',
            email: 'jane@example.com',
            cvFileUrl: 'https://r2.example.com/jane-cv.pdf',
          },
        }),
      ]);

      const result = await service.findAll(TENANT_ID);
      const candidate = result.applications[0].candidate;

      expect(candidate).toHaveProperty('id', 'cand-42');
      expect(candidate).toHaveProperty('full_name', 'Jane Smith');
      expect(candidate).toHaveProperty('email', 'jane@example.com');
      expect(candidate).toHaveProperty('cv_file_url', 'https://r2.example.com/jane-cv.pdf');
      expect(candidate).toHaveProperty('ai_score', 85);

      // camelCase should NOT be present
      expect(candidate).not.toHaveProperty('fullName');
      expect(candidate).not.toHaveProperty('cvFileUrl');
    });

    it('Test 4: ai_score = MAX score when multiple scores exist', async () => {
      mockPrismaService.application.findMany.mockResolvedValue([
        makeMockApplication({
          scores: [{ score: 70 }, { score: 92 }, { score: 55 }],
        }),
      ]);

      const result = await service.findAll(TENANT_ID);

      expect(result.applications[0].candidate.ai_score).toBe(92);
    });

    it('Test 5: ai_score = null when scores array is empty', async () => {
      mockPrismaService.application.findMany.mockResolvedValue([
        makeMockApplication({ scores: [] }),
      ]);

      const result = await service.findAll(TENANT_ID);

      expect(result.applications[0].candidate.ai_score).toBeNull();
    });

    it('Test 6: WHERE includes tenantId param', async () => {
      mockPrismaService.application.findMany.mockResolvedValue([]);

      await service.findAll(TENANT_ID);

      const findManyCall = mockPrismaService.application.findMany.mock.calls[0][0];
      expect(findManyCall.where).toEqual({ tenantId: TENANT_ID });
    });
  });
});
