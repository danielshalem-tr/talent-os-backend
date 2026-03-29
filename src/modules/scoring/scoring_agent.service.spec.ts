import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ScoringAgentService } from './scoring_agent.service';
import { JobTitleMatcherService } from './job-title-matcher.service';
import { PrismaService } from '../../prisma/prisma.service';

jest.mock('ai', () => ({
  generateObject: jest.fn(),
}));

jest.mock('@ai-sdk/anthropic', () => ({
  anthropic: jest.fn(() => ({})),
}));

import { generateObject } from 'ai';

describe('ScoringAgentService', () => {
  let service: ScoringAgentService;
  let prisma: PrismaService;
  let jobTitleMatcher: JobTitleMatcherService;
  let config: ConfigService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScoringAgentService,
        {
          provide: PrismaService,
          useValue: {
            candidate: {
              findUnique: jest.fn(),
            },
            job: {
              findMany: jest.fn(),
            },
            application: {
              findUnique: jest.fn(),
              create: jest.fn(),
            },
            candidateJobScore: {
              create: jest.fn(),
            },
          },
        },
        {
          provide: JobTitleMatcherService,
          useValue: {
            matchJobTitles: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<ScoringAgentService>(ScoringAgentService);
    prisma = module.get<PrismaService>(PrismaService);
    jobTitleMatcher = module.get<JobTitleMatcherService>(JobTitleMatcherService);
    config = module.get<ConfigService>(ConfigService);

    jest.clearAllMocks();
  });

  describe('scoreCandidate', () => {
    it('should skip jobs on semantic title mismatch', async () => {
      const candidateId = 'cand-1';
      const tenantId = 'tenant-1';

      const mockCandidate = {
        id: candidateId,
        tenantId,
        currentRole: 'Data Analyst',
        yearsExperience: 5,
        skills: ['Python', 'SQL'],
        cvText: 'Test CV',
      };

      const mockJob = {
        id: 'job-1',
        tenantId,
        title: 'Software Engineer',
        status: 'active',
      };

      (prisma.candidate.findUnique as jest.Mock).mockResolvedValueOnce(mockCandidate);
      (prisma.job.findMany as jest.Mock).mockResolvedValueOnce([mockJob]);
      (jobTitleMatcher.matchJobTitles as jest.Mock).mockResolvedValueOnce({
        matched: false,
        confidence: 0.15,
      });

      await service.scoreCandidate(candidateId, tenantId);

      // Verify no scoring call was made
      expect(generateObject).not.toHaveBeenCalled();
      expect(prisma.candidateJobScore.create).not.toHaveBeenCalled();
    });

    it('should save match_confidence when job matches', async () => {
      const candidateId = 'cand-1';
      const tenantId = 'tenant-1';

      const mockCandidate = {
        id: candidateId,
        tenantId,
        currentRole: 'Software Developer',
        yearsExperience: 5,
        skills: ['TypeScript', 'Node.js'],
        cvText: 'Test CV',
      };

      const mockJob = {
        id: 'job-1',
        tenantId,
        title: 'Senior Software Engineer',
        description: 'Looking for a senior engineer',
        requirements: ['TypeScript', 'Node.js'],
        status: 'active',
      };

      const mockApplication = {
        id: 'app-1',
        tenantId,
        candidateId,
        jobId: 'job-1',
      };

      (prisma.candidate.findUnique as jest.Mock).mockResolvedValueOnce(mockCandidate);
      (prisma.job.findMany as jest.Mock).mockResolvedValueOnce([mockJob]);
      (jobTitleMatcher.matchJobTitles as jest.Mock).mockResolvedValueOnce({
        matched: true,
        confidence: 0.92,
        reasoning: 'Both are software engineering roles',
      });
      (prisma.application.findUnique as jest.Mock).mockResolvedValueOnce(null);
      (prisma.application.create as jest.Mock).mockResolvedValueOnce(mockApplication);
      (generateObject as jest.Mock).mockResolvedValueOnce({
        object: {
          score: 82,
          reasoning: 'Strong match',
          strengths: ['TypeScript', 'Node.js'],
          gaps: ['System design'],
        },
      });

      await service.scoreCandidate(candidateId, tenantId);

      expect(prisma.candidateJobScore.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tenantId,
          applicationId: 'app-1',
          score: 82,
          matchConfidence: 0.92,
        }),
      });
    });

    it('should handle missing candidate gracefully', async () => {
      const candidateId = 'nonexistent';
      const tenantId = 'tenant-1';

      (prisma.candidate.findUnique as jest.Mock).mockResolvedValueOnce(null);

      await service.scoreCandidate(candidateId, tenantId);

      expect(prisma.job.findMany).not.toHaveBeenCalled();
    });

    it('should handle no open jobs', async () => {
      const candidateId = 'cand-1';
      const tenantId = 'tenant-1';

      const mockCandidate = {
        id: candidateId,
        tenantId,
        currentRole: 'Software Developer',
      };

      (prisma.candidate.findUnique as jest.Mock).mockResolvedValueOnce(mockCandidate);
      (prisma.job.findMany as jest.Mock).mockResolvedValueOnce([]);

      await service.scoreCandidate(candidateId, tenantId);

      expect(jobTitleMatcher.matchJobTitles).not.toHaveBeenCalled();
    });
  });
});
