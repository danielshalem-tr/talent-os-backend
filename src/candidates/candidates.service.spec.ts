import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { CandidatesService } from './candidates.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { ScoringAgentService } from '../scoring/scoring.service';
import { CandidateAiService } from './candidate-ai.service';
import { AttachmentExtractorService } from '../ingestion/services/attachment-extractor.service';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

// Helper to build a mock candidate row as Prisma would return it
function mockCandidate(
  overrides: Partial<{
    id: string;
    fullName: string;
    email: string | null;
    phone: string | null;
    currentRole: string | null;
    location: string | null;
    cvFileUrl: string | null;
    source: string;
    sourceAgency: string | null;
    createdAt: Date;
    skills: string[];
    jobId: string | null;
    hiringStageId: string | null;
    hiringStage: { name: string } | null;
    aiScore: number | null;
    applications: { jobId?: string; scores: Record<string, unknown>[] }[];
    duplicateFlags: { id: string }[];
    candidateStageSummaries: { jobStageId: string; summary: string }[];
    status: string;
    aiSummary: string | null;
    cvText: string | null;
    isScoreOverridden: boolean;
  }> = {},
) {
  return {
    id: 'cand-1',
    fullName: 'John Doe',
    email: 'john@example.com',
    phone: null,
    currentRole: 'Software Engineer',
    location: 'Tel Aviv',
    cvFileUrl: 'https://r2.example.com/cv.pdf',
    source: 'linkedin',
    sourceAgency: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    skills: ['TypeScript', 'React'],
    jobId: 'job-uuid',
    hiringStageId: 'stage-uuid',
    hiringStage: { name: 'Application Review' },
    aiScore: null,
    applications: [],
    duplicateFlags: [],
    candidateStageSummaries: [],
    status: 'active',
    aiSummary: null,
    cvText: null,
    isScoreOverridden: false,
    ...overrides,
  };
}

describe('CandidatesService', () => {
  let service: CandidatesService;
  // Broadened so per-test cases can attach findFirst/update/updateMany, job, $transaction, etc.
  let prismaMock: Record<string, any>;
  // Exposed so the assignment tests can assert WHEN scoring runs relative to the transaction.
  let scoringMock: { score: jest.Mock };

  beforeEach(async () => {
    prismaMock = {
      candidate: {
        findMany: jest.fn(),
      },
    };
    const scoreResult = {
      score: 75,
      reasoning: 'Test',
      strengths: [],
      gaps: [],
      modelUsed: 'test',
      breakdown: {
        version: 1,
        must_have_coverage: 1,
        nice_to_have_coverage: null,
        role_relevance: 90,
        relevant_years: 6,
        experience_fit: 'in_range',
        experience_factor: 1,
        raw_score: 96.5,
        adjustments: [],
        caps_applied: [],
        flags: [],
        must_haves: [],
        nice_to_haves: [],
      },
    };
    scoringMock = { score: jest.fn().mockResolvedValue(scoreResult) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CandidatesService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: StorageService, useValue: { uploadFromBuffer: jest.fn().mockResolvedValue('cvs/t/cand-1.pdf') } },
        { provide: ScoringAgentService, useValue: scoringMock },
        { provide: CandidateAiService, useValue: { generateSummary: jest.fn().mockResolvedValue('New summary') } },
        {
          provide: AttachmentExtractorService,
          useValue: { extract: jest.fn().mockResolvedValue('Extracted CV text') },
        },
      ],
    }).compile();

    service = module.get<CandidatesService>(CandidatesService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('cv_readable derivation', () => {
    it('is true when cv_text is non-empty and false for null/whitespace', async () => {
      prismaMock.candidate.findMany.mockResolvedValue([
        mockCandidate({ id: 'c1', cvText: 'Real CV content', isScoreOverridden: false }),
        mockCandidate({ id: 'c2', cvText: '   ', isScoreOverridden: true }),
        mockCandidate({ id: 'c3', cvText: null, isScoreOverridden: false }),
      ]);

      const result = await service.findAll(TENANT_ID);

      expect(result.candidates[0].cv_readable).toBe(true);
      expect(result.candidates[0].is_score_overridden).toBe(false);
      expect(result.candidates[1].cv_readable).toBe(false);
      expect(result.candidates[1].is_score_overridden).toBe(true);
      expect(result.candidates[2].cv_readable).toBe(false);
      // cv_text must never leak into the response
      expect((result.candidates[0] as Record<string, unknown>).cv_text).toBeUndefined();
    });
  });

  describe('findOne score_details', () => {
    it('returns score_details for the assigned job application', async () => {
      prismaMock.candidate.findFirst = jest.fn().mockResolvedValue(
        mockCandidate({
          jobId: 'job-1',
          applications: [
            {
              jobId: 'job-other',
              scores: [
                {
                  score: 10,
                  reasoning: 'old',
                  strengths: [],
                  gaps: [],
                  modelUsed: 'm',
                  scoredAt: new Date('2026-09-01'),
                  breakdown: null,
                },
              ],
            },
            {
              jobId: 'job-1',
              scores: [
                {
                  score: 81,
                  reasoning: 'fit',
                  strengths: ['React'],
                  gaps: [],
                  modelUsed: 'anthropic/claude-sonnet-5',
                  scoredAt: new Date('2026-09-03T10:00:00Z'),
                  breakdown: { version: 1, flags: [] },
                },
              ],
            },
          ],
        }),
      );

      const res = await service.findOne('cand-1', TENANT_ID);

      expect(res.score_details).toEqual({
        score: 81,
        reasoning: 'fit',
        strengths: ['React'],
        gaps: [],
        model_used: 'anthropic/claude-sonnet-5',
        scored_at: '2026-09-03T10:00:00.000Z',
        breakdown: { version: 1, flags: [] },
      });
    });

    it('returns score_details null when the candidate has no job', async () => {
      prismaMock.candidate.findFirst = jest.fn().mockResolvedValue(mockCandidate({ jobId: null, applications: [] }));

      const res = await service.findOne('cand-1', TENANT_ID);

      expect(res.score_details).toBeNull();
    });
  });

  describe('job assignment scoring', () => {
    // Builds the mocks for one updateCandidate() assignment. `order` records when the
    // transaction commits, when the scorer runs, and every candidate read, so tests can pin
    // scoring OUTSIDE the transaction and still BEFORE the response is built.
    // `existingApplicationJobIds` makes the fake application table behave like Postgres does
    // under idx_applications_unique(tenantId, candidateId, jobId).
    function setupAssignment(opts: {
      fromJobId: string | null;
      cvText: string | null;
      overridden?: boolean;
      existingApplicationJobIds?: string[];
    }) {
      const order: string[] = [];
      const existing = new Set(opts.existingApplicationJobIds ?? []);

      const create = jest.fn((args: { data: { jobId: string } }) => {
        if (existing.has(args.data.jobId)) {
          // Shape of the Prisma unique-violation the real client throws.
          const err = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
          return Promise.reject(err);
        }
        existing.add(args.data.jobId);
        return Promise.resolve({ id: 'app-1' });
      });
      const upsert = jest.fn((args: { create: { jobId: string } }) => {
        existing.add(args.create.jobId);
        return Promise.resolve({ id: 'app-1' });
      });
      const tx = {
        application: { create, upsert },
        candidate: { update: jest.fn().mockResolvedValue({}) },
      };

      prismaMock.candidate.findFirst = jest.fn(() => {
        order.push('candidate-read');
        return Promise.resolve(
          mockCandidate({
            jobId: opts.fromJobId,
            hiringStageId: opts.fromJobId ? 'stage-old' : null,
            cvText: opts.cvText,
            isScoreOverridden: opts.overridden ?? false,
          }),
        );
      });
      prismaMock.candidate.updateMany = jest.fn().mockResolvedValue({ count: 1 });
      prismaMock.jobStage = { findFirst: jest.fn().mockResolvedValue({ id: 'stage-1' }) };
      prismaMock.job = {
        findFirst: jest.fn().mockResolvedValue({
          id: 'new-job',
          title: 'Dev',
          description: 'd',
          mustHaveSkills: [],
          roleSummary: null,
          responsibilities: null,
          niceToHaveSkills: [],
          expYearsMin: null,
          expYearsMax: null,
          preferredOrgTypes: [],
          screeningQuestions: [],
        }),
      };
      prismaMock.application = { findFirst: jest.fn().mockResolvedValue({ id: 'app-1' }) };
      prismaMock.candidateJobScore = { upsert: jest.fn().mockResolvedValue({}) };
      prismaMock.$transaction = jest.fn(async (cb: (t: typeof tx) => unknown) => {
        const result = await cb(tx);
        order.push('tx-commit');
        return result;
      });
      scoringMock.score.mockImplementation(() => {
        order.push('score');
        return Promise.resolve({
          score: 75,
          reasoning: 'Test',
          strengths: [],
          gaps: [],
          modelUsed: 'test',
          breakdown: {
            version: 1,
            must_have_coverage: 1,
            nice_to_have_coverage: null,
            role_relevance: 90,
            relevant_years: 6,
            experience_fit: 'in_range',
            experience_factor: 1,
            raw_score: 96.5,
            adjustments: [],
            caps_applied: [],
            flags: [],
            must_haves: [],
            nice_to_haves: [],
          },
        });
      });

      return { tx, order };
    }

    it('scores the candidate when a job is assigned for the first time', async () => {
      setupAssignment({ fromJobId: null, cvText: 'real cv text' });

      await service.updateCandidate('cand-1', { job_id: 'new-job' } as never, TENANT_ID);

      expect(prismaMock.candidateJobScore.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            applicationId: 'app-1',
            score: 75,
            breakdown: expect.objectContaining({ version: 1 }),
          }),
        }),
      );
      expect(prismaMock.candidate.updateMany).toHaveBeenCalledWith({
        where: { id: 'cand-1', isScoreOverridden: false },
        data: { aiScore: 75 },
      });
    });

    it('stamps a fresh scoredAt on both upsert branches so a re-assign refreshes the timestamp', async () => {
      setupAssignment({ fromJobId: 'old-job', cvText: 'real cv text' });
      const before = Date.now();

      await service.updateCandidate('cand-1', { job_id: 'new-job' } as never, TENANT_ID);

      const args = prismaMock.candidateJobScore.upsert.mock.calls[0][0];
      expect(args.update.scoredAt).toBeInstanceOf(Date);
      expect(args.update.scoredAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(args.create.scoredAt).toBeInstanceOf(Date);
    });

    it('runs the scorer only after the assignment transaction has committed', async () => {
      // The scorer is a network call to an LLM. Prisma interactive transactions time out at 5s
      // by default, so scoring inside one rolls the assignment back and holds a row lock plus a
      // pool connection for the whole call.
      const { order } = setupAssignment({ fromJobId: null, cvText: 'real cv text' });

      await service.updateCandidate('cand-1', { job_id: 'new-job' } as never, TENANT_ID);

      expect(order.filter((step) => step !== 'candidate-read')).toEqual(['tx-commit', 'score']);
    });

    it('runs the scorer outside the transaction on reassignment too', async () => {
      const { order } = setupAssignment({ fromJobId: 'old-job', cvText: 'real cv text' });

      await service.updateCandidate('cand-1', { job_id: 'new-job' } as never, TENANT_ID);

      expect(order.filter((step) => step !== 'candidate-read')).toEqual(['tx-commit', 'score']);
    });

    it('reassigns to a job the candidate already has an application for', async () => {
      // Ingestion upserts an Application for EVERY matched job while candidate.jobId points at
      // only the primary one, so this row already exists. `create` here trips
      // idx_applications_unique -> P2002 -> 500 and the assignment is lost.
      setupAssignment({
        fromJobId: 'old-job',
        cvText: 'real cv text',
        existingApplicationJobIds: ['old-job', 'new-job'],
      });

      await expect(service.updateCandidate('cand-1', { job_id: 'new-job' } as never, TENANT_ID)).resolves.toBeDefined();
    });

    it('attaches the score to the application for THIS job, not any application', async () => {
      setupAssignment({ fromJobId: null, cvText: 'real cv text' });

      await service.updateCandidate('cand-1', { job_id: 'new-job' } as never, TENANT_ID);

      // A candidate can hold applications on several jobs; the lookup must be pinned to the
      // job just assigned or the score lands on an arbitrary one.
      expect(prismaMock.application.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { candidateId: 'cand-1', jobId: 'new-job', tenantId: TENANT_ID } }),
      );
    });

    it('finishes scoring before building the response', async () => {
      // Guards against fire-and-forget: `void scoreNewAssignment(...)` would still satisfy the
      // ordering test above while returning ai_score: null to the UI.
      const { order } = setupAssignment({ fromJobId: null, cvText: 'real cv text' });

      await service.updateCandidate('cand-1', { job_id: 'new-job' } as never, TENANT_ID);

      expect(order).toEqual(['candidate-read', 'tx-commit', 'score', 'candidate-read']);
    });

    it('assigns without scoring when the candidate has no CV text', async () => {
      // Matches assignCandidateToJob: no CV means nothing to score against, and a fabricated
      // score is worse than none. The assignment itself must still stand.
      const { tx } = setupAssignment({ fromJobId: null, cvText: '   ' });

      await service.updateCandidate('cand-1', { job_id: 'new-job' } as never, TENANT_ID);

      expect(scoringMock.score).not.toHaveBeenCalled();
      expect(prismaMock.candidateJobScore.upsert).not.toHaveBeenCalled();
      expect(tx.candidate.update).toHaveBeenCalled();
    });

    it('guards the denormalized aiScore write with isScoreOverridden: false', async () => {
      setupAssignment({ fromJobId: 'old-job', cvText: 'real cv text', overridden: true });

      await service.updateCandidate('cand-1', { job_id: 'new-job' } as never, TENANT_ID);

      // The where-clause is the guard: it makes the skip atomic, so assert the clause itself
      // rather than the (mocked) row count.
      expect(prismaMock.candidate.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ isScoreOverridden: false }) }),
      );
    });
  });

  describe('manual ai_score override', () => {
    it('sets aiScore and isScoreOverridden when ai_score is provided', async () => {
      const update = jest.fn().mockResolvedValue({});
      prismaMock.candidate.findFirst = jest.fn().mockResolvedValue(mockCandidate({ jobId: 'job-1' }));
      prismaMock.candidate.update = update;
      prismaMock.candidate.findMany = jest
        .fn()
        .mockResolvedValue([mockCandidate({ aiScore: 42, isScoreOverridden: true })]);

      await service.updateCandidate('cand-1', { ai_score: 42 } as never, TENANT_ID);

      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'cand-1' },
          data: expect.objectContaining({ aiScore: 42, isScoreOverridden: true }),
        }),
      );
    });
  });

  describe('salary expectation update', () => {
    it('writes salaryExpectationMin/Max to updateData', async () => {
      const update = jest.fn().mockResolvedValue({});
      prismaMock.candidate.findFirst = jest.fn().mockResolvedValue(mockCandidate({ jobId: 'job-1' }));
      prismaMock.candidate.update = update;
      prismaMock.candidate.findMany = jest.fn().mockResolvedValue([mockCandidate()]);

      await service.updateCandidate(
        'cand-1',
        { salary_expectation_min: 10000, salary_expectation_max: 15000 } as never,
        TENANT_ID,
      );

      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'cand-1' },
          data: expect.objectContaining({ salaryExpectationMin: 10000, salaryExpectationMax: 15000 }),
        }),
      );
    });

    it('clears a bound when null is passed', async () => {
      const update = jest.fn().mockResolvedValue({});
      prismaMock.candidate.findFirst = jest.fn().mockResolvedValue(mockCandidate({ jobId: 'job-1' }));
      prismaMock.candidate.update = update;
      prismaMock.candidate.findMany = jest.fn().mockResolvedValue([mockCandidate()]);

      await service.updateCandidate('cand-1', { salary_expectation_min: null } as never, TENANT_ID);

      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ salaryExpectationMin: null }) }),
      );
    });
  });

  describe('revertScore', () => {
    it('clears the flag and nulls aiScore when there is no assigned job', async () => {
      const update = jest.fn().mockResolvedValue({});
      prismaMock.candidate.findFirst = jest
        .fn()
        .mockResolvedValue(mockCandidate({ jobId: null, cvText: 'cv', isScoreOverridden: true }));
      prismaMock.candidate.update = update;
      prismaMock.candidate.findMany = jest.fn().mockResolvedValue([mockCandidate({ aiScore: null })]);

      await service.revertScore('cand-1', TENANT_ID);

      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ isScoreOverridden: false, aiScore: null }) }),
      );
    });

    it('clears the flag and re-scores when a job and CV text exist', async () => {
      prismaMock.candidate.findFirst = jest
        .fn()
        .mockResolvedValue(mockCandidate({ jobId: 'job-1', cvText: 'real cv', isScoreOverridden: true }));
      prismaMock.candidate.update = jest.fn().mockResolvedValue({});
      prismaMock.job = {
        findFirst: jest.fn().mockResolvedValue({
          id: 'job-1',
          title: 'Dev',
          description: 'd',
          mustHaveSkills: [],
          roleSummary: null,
          responsibilities: null,
          niceToHaveSkills: [],
          expYearsMin: null,
          expYearsMax: null,
          preferredOrgTypes: [],
          screeningQuestions: [],
        }),
      };
      prismaMock.application = { findFirst: jest.fn().mockResolvedValue({ id: 'app-1' }) };
      prismaMock.candidateJobScore = { upsert: jest.fn().mockResolvedValue({}) };
      prismaMock.candidate.updateMany = jest.fn().mockResolvedValue({ count: 1 });
      prismaMock.candidate.findMany = jest.fn().mockResolvedValue([mockCandidate({ aiScore: 75 })]);

      await service.revertScore('cand-1', TENANT_ID);

      // scoringAgent.score() mock returns { score: 75, ... } from module setup
      expect(prismaMock.candidateJobScore.upsert).toHaveBeenCalled();
      expect(prismaMock.candidate.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ isScoreOverridden: false }),
          data: expect.objectContaining({ aiScore: 75 }),
        }),
      );
    });
  });

  describe('rescoreCandidate', () => {
    it('rescores the assigned job and returns the score result', async () => {
      prismaMock.candidate.findFirst = jest.fn().mockResolvedValue(
        mockCandidate({
          id: 'c1',
          jobId: 'j1',
          cvText: 'Real CV',
          currentRole: 'Dev',
          yearsExperience: 5,
          skills: ['ts'],
        }),
      );
      prismaMock.job = {
        findFirst: jest.fn().mockResolvedValue({
          id: 'j1',
          title: 'Eng',
          description: 'd',
          mustHaveSkills: ['ts'],
          roleSummary: null,
          responsibilities: null,
          niceToHaveSkills: [],
          expYearsMin: null,
          expYearsMax: null,
          preferredOrgTypes: [],
          screeningQuestions: [],
        }),
      };
      prismaMock.application = { findFirst: jest.fn().mockResolvedValue({ id: 'app1' }) };
      prismaMock.candidateJobScore = { upsert: jest.fn().mockResolvedValue({}) };
      prismaMock.candidate.update = jest.fn().mockResolvedValue({});
      prismaMock.candidate.updateMany = jest.fn().mockResolvedValue({ count: 1 });

      const result = await service.rescoreCandidate('c1', TENANT_ID);

      expect(result).toEqual(
        expect.objectContaining({
          score: 75,
          reasoning: 'Test',
          strengths: [],
          gaps: [],
          modelUsed: 'test',
          breakdown: expect.objectContaining({ version: 1 }),
        }),
      );
      expect(prismaMock.candidate.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ isScoreOverridden: false }),
          data: { aiScore: 75 },
        }),
      );
    });

    it('stamps a fresh scoredAt on the update branch so the rescore timestamp is not the ingestion time', async () => {
      prismaMock.candidate.findFirst = jest.fn().mockResolvedValue(
        mockCandidate({
          id: 'c1',
          jobId: 'j1',
          cvText: 'Real CV',
          currentRole: 'Dev',
          yearsExperience: 5,
          skills: ['ts'],
        }),
      );
      prismaMock.job = {
        findFirst: jest.fn().mockResolvedValue({
          id: 'j1',
          title: 'Eng',
          description: 'd',
          mustHaveSkills: ['ts'],
          roleSummary: null,
          responsibilities: null,
          niceToHaveSkills: [],
          expYearsMin: null,
          expYearsMax: null,
          preferredOrgTypes: [],
          screeningQuestions: [],
        }),
      };
      prismaMock.application = { findFirst: jest.fn().mockResolvedValue({ id: 'app1' }) };
      prismaMock.candidateJobScore = { upsert: jest.fn().mockResolvedValue({}) };
      prismaMock.candidate.update = jest.fn().mockResolvedValue({});
      prismaMock.candidate.updateMany = jest.fn().mockResolvedValue({ count: 1 });
      const before = Date.now();

      await service.rescoreCandidate('c1', TENANT_ID);

      const args = prismaMock.candidateJobScore.upsert.mock.calls[0][0];
      expect(args.update.scoredAt).toBeInstanceOf(Date);
      expect(args.update.scoredAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(args.update.modelUsed).toBe('test');
    });

    it('returns null when the candidate has no assigned job', async () => {
      prismaMock.candidate.findFirst = jest
        .fn()
        .mockResolvedValue(mockCandidate({ id: 'c1', jobId: null, cvText: 'Real CV' }));
      const result = await service.rescoreCandidate('c1', TENANT_ID);
      expect(result).toBeNull();
    });
  });

  describe('uploadCv', () => {
    const file = {
      originalname: 'cv.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('pdf-bytes'),
      size: 1234,
    } as Express.Multer.File;

    it('uploads, writes cv_text + summary, and re-scores when a job is assigned and not overridden', async () => {
      prismaMock.candidate.findFirst = jest.fn().mockResolvedValue(
        mockCandidate({
          id: 'cand-1',
          jobId: 'job-1',
          isScoreOverridden: false,
          currentRole: 'Dev',
          yearsExperience: 3,
          skills: ['ts'],
        }),
      );
      const update = jest.fn().mockResolvedValue({});
      prismaMock.candidate.update = update;
      prismaMock.candidate.updateMany = jest.fn().mockResolvedValue({ count: 1 });
      prismaMock.job = {
        findFirst: jest.fn().mockResolvedValue({
          id: 'job-1',
          title: 'Dev',
          description: 'd',
          mustHaveSkills: [],
          roleSummary: null,
          responsibilities: null,
          niceToHaveSkills: [],
          expYearsMin: null,
          expYearsMax: null,
          preferredOrgTypes: [],
          screeningQuestions: [],
        }),
      };
      prismaMock.application = { findFirst: jest.fn().mockResolvedValue({ id: 'app-1' }) };
      prismaMock.candidateJobScore = { upsert: jest.fn().mockResolvedValue({}) };
      prismaMock.candidate.findMany = jest
        .fn()
        .mockResolvedValue([mockCandidate({ cvText: 'Extracted CV text', aiScore: 75 })]);

      await service.uploadCv('cand-1', file, TENANT_ID);

      // cv_text + ai_summary written
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'cand-1' },
          data: expect.objectContaining({ cvText: 'Extracted CV text', aiSummary: 'New summary' }),
        }),
      );
      // re-scored (via rescoreAssignedJob → candidateJobScore.upsert)
      expect(prismaMock.candidateJobScore.upsert).toHaveBeenCalled();
    });

    it('skips scoring when the candidate has no job', async () => {
      prismaMock.candidate.findFirst = jest
        .fn()
        .mockResolvedValue(mockCandidate({ id: 'cand-1', jobId: null, isScoreOverridden: false }));
      prismaMock.candidate.update = jest.fn().mockResolvedValue({});
      prismaMock.candidateJobScore = { upsert: jest.fn() };
      prismaMock.candidate.findMany = jest.fn().mockResolvedValue([mockCandidate({ cvText: 'Extracted CV text' })]);

      await service.uploadCv('cand-1', file, TENANT_ID);

      expect(prismaMock.candidateJobScore.upsert).not.toHaveBeenCalled();
    });

    it('skips the score write when the candidate is overridden', async () => {
      prismaMock.candidate.findFirst = jest
        .fn()
        .mockResolvedValue(mockCandidate({ id: 'cand-1', jobId: 'job-1', isScoreOverridden: true }));
      prismaMock.candidate.update = jest.fn().mockResolvedValue({});
      prismaMock.job = { findFirst: jest.fn().mockResolvedValue({ title: 'Dev' }) };
      prismaMock.candidateJobScore = { upsert: jest.fn() };
      prismaMock.candidate.findMany = jest.fn().mockResolvedValue([mockCandidate({ isScoreOverridden: true })]);

      await service.uploadCv('cand-1', file, TENANT_ID);

      expect(prismaMock.candidateJobScore.upsert).not.toHaveBeenCalled();
    });
  });

  // Test 1: no params → returns all candidates with ai_score from denormalized field
  it('returns all candidates scoped to tenantId with ai_score computed', async () => {
    prismaMock.candidate.findMany.mockResolvedValue([
      mockCandidate({
        aiScore: 80, // C-5: aiScore is now denormalized from database field (not computed from applications)
        duplicateFlags: [],
      }),
    ]);

    const result = await service.findAll(TENANT_ID);

    expect(prismaMock.candidate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: TENANT_ID }),
      }),
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.candidates[0].ai_score).toBe(80);
    expect(result.candidates[0].full_name).toBe('John Doe');
    expect(result.candidates[0].is_duplicate).toBe(false);
  });

  // Test 2: q='jane' → WHERE contains jane in fullName/email/currentRole
  it('filters by q param using ILIKE on fullName, email, currentRole', async () => {
    prismaMock.candidate.findMany.mockResolvedValue([]);

    await service.findAll(TENANT_ID, 'jane');

    expect(prismaMock.candidate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: TENANT_ID,
          OR: [
            { fullName: { contains: 'jane', mode: 'insensitive' } },
            { email: { contains: 'jane', mode: 'insensitive' } },
            { currentRole: { contains: 'jane', mode: 'insensitive' } },
          ],
        }),
      }),
    );
  });

  // Test 3: filter='high-score' is no longer supported → throws BadRequestException
  it('filter=high-score throws INVALID_FILTER error', async () => {
    await expect(service.findAll(TENANT_ID, undefined, 'high-score' as any)).rejects.toThrow(
      expect.objectContaining({
        getResponse: expect.any(Function),
      }),
    );
  });

  // Test 4: filter='available' is no longer supported → throws BadRequestException
  it('filter=available throws INVALID_FILTER error', async () => {
    await expect(service.findAll(TENANT_ID, undefined, 'available' as any)).rejects.toThrow(
      expect.objectContaining({
        getResponse: expect.any(Function),
      }),
    );
  });

  // Test 5: filter='referred' is no longer supported → throws BadRequestException
  it('filter=referred throws INVALID_FILTER error', async () => {
    await expect(service.findAll(TENANT_ID, undefined, 'referred' as any)).rejects.toThrow(
      expect.objectContaining({
        getResponse: expect.any(Function),
      }),
    );
  });

  // Test 6: filter='duplicates' is gone with the duplicate-flag pipeline
  it('filter=duplicates is no longer supported → INVALID_FILTER', async () => {
    await expect(service.findAll(TENANT_ID, undefined, 'duplicates' as never)).rejects.toThrow(BadRequestException);
    expect(prismaMock.candidate.findMany).not.toHaveBeenCalled();
  });

  // Test 7: no scores → ai_score is null
  it('returns ai_score=null when candidate has no application scores', async () => {
    prismaMock.candidate.findMany.mockResolvedValue([mockCandidate({ applications: [] })]);

    const result = await service.findAll(TENANT_ID);

    expect(result.candidates[0].ai_score).toBeNull();
  });

  // Test 8: no unreviewed flags → is_duplicate is false
  it('returns is_duplicate=false when all duplicate_flags are reviewed', async () => {
    prismaMock.candidate.findMany.mockResolvedValue([
      mockCandidate({ duplicateFlags: [] }), // reviewed=false flags filtered in select — empty means none unreviewed
    ]);

    const result = await service.findAll(TENANT_ID);

    expect(result.candidates[0].is_duplicate).toBe(false);
  });

  it('never joins duplicate_flags any more', async () => {
    prismaMock.candidate.findMany.mockResolvedValue([mockCandidate()]);

    await service.findAll(TENANT_ID);

    const select = prismaMock.candidate.findMany.mock.calls[0][0].select;
    expect(select.duplicateFlags).toBeUndefined();
  });

  // Test 9: created_within_days → WHERE createdAt.gte is N days ago
  it('filters by created_within_days', async () => {
    prismaMock.candidate.findMany.mockResolvedValue([]);

    await service.findAll(TENANT_ID, undefined, undefined, undefined, false, '7');

    const where = prismaMock.candidate.findMany.mock.calls[0][0].where;
    expect(where.createdAt.gte).toBeInstanceOf(Date);
    const ageMs = Date.now() - where.createdAt.gte.getTime();
    expect(ageMs).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000);
    expect(ageMs).toBeLessThan(7.1 * 24 * 60 * 60 * 1000);
  });

  it('ignores an absent or blank created_within_days', async () => {
    prismaMock.candidate.findMany.mockResolvedValue([]);

    await service.findAll(TENANT_ID, undefined, undefined, undefined, false, '');

    expect(prismaMock.candidate.findMany.mock.calls[0][0].where.createdAt).toBeUndefined();
  });

  it.each(['0', '-3', 'abc', '2.5', '99999'])('rejects created_within_days=%s', async (value) => {
    await expect(service.findAll(TENANT_ID, undefined, undefined, undefined, false, value)).rejects.toThrow(
      BadRequestException,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CandidatesService.createCandidate() unit tests
// ─────────────────────────────────────────────────────────────────────────────

const BASE_DTO = {
  full_name: 'Jane Doe',
  email: 'jane@example.com',
  job_id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', // valid RFC 4122 v4 UUID
  source: 'linkedin' as const,
  skills: [],
};

function makePdfFile(): Express.Multer.File {
  return {
    buffer: Buffer.from('pdf-content'),
    mimetype: 'application/pdf',
    originalname: 'cv.pdf',
    fieldname: 'cv_file',
    encoding: '7bit',
    size: 11,
    stream: null as any,
    destination: '',
    filename: '',
    path: '',
  };
}

describe('CandidatesService.createCandidate()', () => {
  let service: CandidatesService;
  let mockStorageService: { uploadFromBuffer: jest.Mock };
  let mockPrisma: {
    job: { findFirst: jest.Mock };
    jobStage: { findFirst: jest.Mock };
    candidate: { findFirst: jest.Mock; findMany: jest.Mock };
    application: { create: jest.Mock };
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
  };

  beforeEach(async () => {
    mockStorageService = { uploadFromBuffer: jest.fn().mockResolvedValue('cvs/tenant-123/cand-id.pdf') };

    mockPrisma = {
      job: { findFirst: jest.fn().mockResolvedValue({ id: BASE_DTO.job_id }) },
      jobStage: { findFirst: jest.fn().mockResolvedValue({ id: 'stage-uuid' }) },
      candidate: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
      application: { create: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $transaction: jest.fn().mockImplementation(async (fn: any) => {
        return fn({
          candidate: {
            create: jest.fn().mockResolvedValue({
              id: 'cand-uuid',
              tenantId: 'tenant-123',
              jobId: BASE_DTO.job_id,
              hiringStageId: 'stage-uuid',
              fullName: BASE_DTO.full_name,
              email: BASE_DTO.email,
              phone: null,
              currentRole: null,
              location: null,
              yearsExperience: null,
              skills: [],
              cvText: null,
              cvFileUrl: null,
              source: BASE_DTO.source,
              sourceAgency: null,
              sourceEmail: null,
              aiSummary: null,
              metadata: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            }),
          },
          application: {
            create: jest.fn().mockResolvedValue({ id: 'app-uuid' }),
          },
        });
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CandidatesService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: StorageService, useValue: mockStorageService },
        {
          provide: ScoringAgentService,
          useValue: {
            score: jest
              .fn()
              .mockResolvedValue({ score: 75, reasoning: 'Test', strengths: [], gaps: [], modelUsed: 'test' }),
          },
        },
        { provide: CandidateAiService, useValue: { generateSummary: jest.fn().mockResolvedValue('Test summary') } },
        {
          provide: AttachmentExtractorService,
          useValue: { extract: jest.fn().mockResolvedValue('Extracted CV text') },
        },
      ],
    }).compile();

    service = module.get<CandidatesService>(CandidatesService);
    jest.clearAllMocks();
    mockPrisma.job.findFirst.mockResolvedValue({ id: BASE_DTO.job_id });
    mockPrisma.candidate.findFirst.mockResolvedValue(null);
    mockStorageService.uploadFromBuffer.mockResolvedValue('cvs/tenant-123/cand-uuid.pdf');
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn({
        candidate: {
          create: jest.fn().mockResolvedValue({
            id: 'cand-uuid',
            tenantId: 'tenant-123',
            fullName: BASE_DTO.full_name,
            email: BASE_DTO.email,
            phone: null,
            currentRole: null,
            location: null,
            yearsExperience: null,
            skills: [],
            cvText: null,
            cvFileUrl: 'cvs/tenant-123/cand-uuid.pdf',
            source: BASE_DTO.source,
            sourceAgency: null,
            sourceEmail: null,
            aiSummary: null,
            metadata: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        },
        application: {
          create: jest.fn().mockResolvedValue({ id: 'app-uuid' }),
        },
      });
    });
  });

  // File Validation Tests

  it('should accept PDF file and call uploadFromBuffer', async () => {
    const file = makePdfFile();
    const result = await service.createCandidate(BASE_DTO, file, TENANT_ID);
    expect(mockStorageService.uploadFromBuffer).toHaveBeenCalledWith(
      file.buffer,
      'application/pdf',
      TENANT_ID,
      expect.any(String),
    );
    expect(result).toBeDefined();
  });

  it('should accept DOCX file', async () => {
    const file: Express.Multer.File = {
      ...makePdfFile(),
      mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      originalname: 'cv.docx',
    };
    await service.createCandidate(BASE_DTO, file, TENANT_ID);
    expect(mockStorageService.uploadFromBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      TENANT_ID,
      expect.any(String),
    );
  });

  it('should propagate BadRequestException for invalid file type', async () => {
    const file: Express.Multer.File = { ...makePdfFile(), mimetype: 'application/x-msdownload' };
    mockStorageService.uploadFromBuffer.mockRejectedValue(
      new BadRequestException({ error: { code: 'INVALID_FILE_TYPE', message: 'Invalid file type' } }),
    );
    await expect(service.createCandidate(BASE_DTO, file, TENANT_ID)).rejects.toThrow(BadRequestException);
  });

  // Email Uniqueness Tests

  it('should accept candidate with new email', async () => {
    mockPrisma.candidate.findFirst.mockResolvedValue(null);
    const result = await service.createCandidate(BASE_DTO, undefined, TENANT_ID);
    expect(result).toHaveProperty('application_id');
  });

  it('should reject duplicate email with ConflictException', async () => {
    mockPrisma.candidate.findFirst.mockResolvedValue({ id: 'existing-cand' });
    await expect(service.createCandidate(BASE_DTO, undefined, TENANT_ID)).rejects.toThrow(ConflictException);
  });

  it('rejects an existing phone with 409 PHONE_EXISTS (same check intake uses)', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([{ id: 'other-cand', email: null }]);

    await expect(
      service.createCandidate({ ...BASE_DTO, email: null, phone: '+972 50-123-4567' }, undefined, TENANT_ID),
    ).rejects.toThrow(ConflictException);
    const [, ...values] = mockPrisma.$queryRaw.mock.calls[0];
    expect(values).toContain('972501234567');
  });

  it('skips the phone check for a phone under the digit floor', async () => {
    await service.createCandidate({ ...BASE_DTO, email: null, phone: '-' }, undefined, TENANT_ID);
    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
  });

  // Transaction Atomicity Tests

  it('should create Candidate and Application atomically', async () => {
    const result = await service.createCandidate(BASE_DTO, undefined, TENANT_ID);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(result).toHaveProperty('id');
    expect(result).toHaveProperty('application_id', 'app-uuid');
  });

  it('should propagate error if Application create fails inside transaction', async () => {
    mockPrisma.$transaction.mockRejectedValue(new Error('DB error'));
    await expect(service.createCandidate(BASE_DTO, undefined, TENANT_ID)).rejects.toThrow('DB error');
  });

  it('persists salary expectation on create and returns it', async () => {
    // Echo the create data so the response reflects what was written (mirrors DB round-trip).
    mockPrisma.$transaction.mockImplementation(async (fn: any) =>
      fn({
        candidate: {
          create: jest.fn().mockImplementation(async ({ data }: any) => ({
            ...data,
            createdAt: new Date(),
            updatedAt: new Date(),
          })),
        },
        application: { create: jest.fn().mockResolvedValue({ id: 'app-uuid' }) },
      }),
    );

    const res = await service.createCandidate(
      { ...BASE_DTO, salary_expectation_min: 10000, salary_expectation_max: 15000 } as any,
      undefined,
      TENANT_ID,
    );

    expect(res.salary_expectation_min).toBe(10000);
    expect(res.salary_expectation_max).toBe(15000);
  });

  // Tenant Isolation Test

  it('should validate job exists in tenant', async () => {
    await service.createCandidate(BASE_DTO, undefined, TENANT_ID);
    expect(mockPrisma.job.findFirst).toHaveBeenCalledWith({
      where: { id: BASE_DTO.job_id, tenantId: TENANT_ID },
    });
  });

  it('should throw NotFoundException if job does not exist', async () => {
    mockPrisma.job.findFirst.mockResolvedValue(null);
    await expect(service.createCandidate(BASE_DTO, undefined, TENANT_ID)).rejects.toThrow(NotFoundException);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CandidatesService.deleteCandidate() unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe('CandidatesService.deleteCandidate()', () => {
  const TENANT_ID = '11111111-1111-1111-1111-111111111111';
  const CAND_ID = 'cand-uuid';

  let service: CandidatesService;
  let mockPrisma: {
    candidate: { findFirst: jest.Mock };
    $transaction: jest.Mock;
  };

  let txDuplicateFlag: { deleteMany: jest.Mock };
  let txEmailIntakeLog: { updateMany: jest.Mock };
  let txCandidate: { delete: jest.Mock };

  beforeEach(async () => {
    txDuplicateFlag = { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) };
    txEmailIntakeLog = { updateMany: jest.fn().mockResolvedValue({ count: 0 }) };
    txCandidate = { delete: jest.fn().mockResolvedValue({ id: CAND_ID }) };

    mockPrisma = {
      candidate: { findFirst: jest.fn().mockResolvedValue({ id: CAND_ID }) },
      $transaction: jest.fn().mockImplementation(async (fn: any) =>
        fn({
          duplicateFlag: txDuplicateFlag,
          emailIntakeLog: txEmailIntakeLog,
          candidate: txCandidate,
        }),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CandidatesService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: StorageService, useValue: { uploadFromBuffer: jest.fn() } },
        { provide: ScoringAgentService, useValue: { score: jest.fn() } },
        { provide: CandidateAiService, useValue: { generateSummary: jest.fn() } },
        { provide: AttachmentExtractorService, useValue: { extract: jest.fn() } },
      ],
    }).compile();

    service = module.get<CandidatesService>(CandidatesService);
  });

  afterEach(() => jest.clearAllMocks());

  it('throws NotFoundException when candidate does not exist', async () => {
    mockPrisma.candidate.findFirst.mockResolvedValue(null);
    await expect(service.deleteCandidate('no-such-id', TENANT_ID)).rejects.toThrow(NotFoundException);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('scopes findFirst lookup to tenant', async () => {
    await service.deleteCandidate(CAND_ID, TENANT_ID);
    expect(mockPrisma.candidate.findFirst).toHaveBeenCalledWith({
      where: { id: CAND_ID, tenantId: TENANT_ID },
      select: { id: true },
    });
  });

  it('runs inside a transaction', async () => {
    await service.deleteCandidate(CAND_ID, TENANT_ID);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('deletes DuplicateFlags on both candidateId and matchedCandidateId sides', async () => {
    await service.deleteCandidate(CAND_ID, TENANT_ID);
    expect(txDuplicateFlag.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [{ candidateId: CAND_ID }, { matchedCandidateId: CAND_ID }],
      },
    });
  });

  it('nullifies EmailIntakeLog.candidateId before deleting candidate', async () => {
    await service.deleteCandidate(CAND_ID, TENANT_ID);
    expect(txEmailIntakeLog.updateMany).toHaveBeenCalledWith({
      where: { candidateId: CAND_ID },
      data: { candidateId: null },
    });
  });

  it('deletes the candidate record inside the transaction', async () => {
    await service.deleteCandidate(CAND_ID, TENANT_ID);
    expect(txCandidate.delete).toHaveBeenCalledWith({ where: { id: CAND_ID } });
  });

  it('executes steps in order: DuplicateFlag → EmailIntakeLog → Candidate', async () => {
    const order: string[] = [];
    txDuplicateFlag.deleteMany.mockImplementation(async () => {
      order.push('duplicateFlag');
      return { count: 0 };
    });
    txEmailIntakeLog.updateMany.mockImplementation(async () => {
      order.push('emailIntakeLog');
      return { count: 0 };
    });
    txCandidate.delete.mockImplementation(async () => {
      order.push('candidate');
      return { id: CAND_ID };
    });

    await service.deleteCandidate(CAND_ID, TENANT_ID);

    expect(order).toEqual(['duplicateFlag', 'emailIntakeLog', 'candidate']);
  });

  it('propagates unexpected errors from the transaction', async () => {
    mockPrisma.$transaction.mockRejectedValue(new Error('DB failure'));
    await expect(service.deleteCandidate(CAND_ID, TENANT_ID)).rejects.toThrow('DB failure');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CandidatesService.updateCandidate() - Reassignment Error Validation Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('CandidatesService.updateCandidate() - Error Handling', () => {
  let service: CandidatesService;
  let mockPrisma: any;

  const TENANT_ID = '11111111-1111-1111-1111-111111111111';
  const CAND_ID = 'cand-uuid';
  const JOB_ID = 'job-uuid';

  beforeEach(async () => {
    mockPrisma = {
      candidate: { findFirst: jest.fn(), update: jest.fn() },
      job: { findFirst: jest.fn() },
      jobStage: { findFirst: jest.fn() },
      application: { create: jest.fn(), findFirst: jest.fn() },
      candidateJobScore: { create: jest.fn() },
      $transaction: jest.fn().mockImplementation(async (fn: any) => fn(mockPrisma)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CandidatesService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: StorageService, useValue: {} },
        { provide: ScoringAgentService, useValue: { score: jest.fn() } },
        { provide: CandidateAiService, useValue: { generateSummary: jest.fn() } },
        { provide: AttachmentExtractorService, useValue: { extract: jest.fn() } },
      ],
    }).compile();

    service = module.get<CandidatesService>(CandidatesService);
  });

  afterEach(() => jest.clearAllMocks());

  it('throws NotFoundException when candidate not found', async () => {
    mockPrisma.candidate.findFirst.mockResolvedValue(null);

    await expect(service.updateCandidate(CAND_ID, { job_id: JOB_ID }, TENANT_ID)).rejects.toThrow(NotFoundException);
  });

  it('throws NotFoundException when job not found during reassignment', async () => {
    // Reassignment scenario: jobId=X → jobId=Y
    mockPrisma.candidate.findFirst.mockResolvedValue({
      id: CAND_ID,
      jobId: 'old-job-id', // Already assigned to a job
      fullName: 'Test',
      cvText: '',
      skills: [],
      currentRole: null,
      yearsExperience: null,
    });
    mockPrisma.jobStage.findFirst.mockResolvedValue({ id: 'stage-id' });
    mockPrisma.job.findFirst.mockResolvedValue(null); // Job not found

    await expect(service.updateCandidate(CAND_ID, { job_id: JOB_ID }, TENANT_ID)).rejects.toThrow(NotFoundException);
  });

  it('throws BadRequestException when job has no enabled stages', async () => {
    mockPrisma.candidate.findFirst.mockResolvedValue({
      id: CAND_ID,
      jobId: null,
      fullName: 'Test',
      cvText: '',
      skills: [],
      currentRole: null,
      yearsExperience: null,
    });
    mockPrisma.jobStage.findFirst.mockResolvedValue(null);

    await expect(service.updateCandidate(CAND_ID, { job_id: JOB_ID }, TENANT_ID)).rejects.toThrow(BadRequestException);
  });

  it('throws BadRequestException with code NO_STAGES when no enabled stages exist', async () => {
    mockPrisma.candidate.findFirst.mockResolvedValue({
      id: CAND_ID,
      jobId: null,
      fullName: 'Test',
      cvText: '',
      skills: [],
      currentRole: null,
      yearsExperience: null,
    });
    mockPrisma.jobStage.findFirst.mockResolvedValue(null);

    try {
      await service.updateCandidate(CAND_ID, { job_id: JOB_ID }, TENANT_ID);
      fail('Should have thrown BadRequestException');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({
        error: { code: 'NO_STAGES' },
      });
    }
  });

  it('scopes candidate lookup to tenantId', async () => {
    mockPrisma.candidate.findFirst.mockResolvedValue(null);

    try {
      await service.updateCandidate(CAND_ID, { job_id: JOB_ID }, TENANT_ID);
    } catch (e) {
      // Expected
    }

    expect(mockPrisma.candidate.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: CAND_ID, tenantId: TENANT_ID }),
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CandidatesService.findAll() - Unassigned Filter Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('CandidatesService.findAll() - Unassigned Filter', () => {
  let service: CandidatesService;
  let mockPrisma: { candidate: { findMany: jest.Mock } };

  const TENANT_ID = '11111111-1111-1111-1111-111111111111';

  beforeEach(async () => {
    mockPrisma = {
      candidate: { findMany: jest.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CandidatesService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: StorageService, useValue: {} },
        { provide: ScoringAgentService, useValue: {} },
        { provide: CandidateAiService, useValue: {} },
        { provide: AttachmentExtractorService, useValue: {} },
      ],
    }).compile();

    service = module.get<CandidatesService>(CandidatesService);
  });

  afterEach(() => jest.clearAllMocks());

  it('returns only jobId=null candidates when unassigned=true', async () => {
    mockPrisma.candidate.findMany.mockResolvedValue([
      {
        id: 'cand-1',
        jobId: null,
        fullName: 'Unassigned One',
        email: 'uno@example.com',
        applications: [],
        duplicateFlags: [],
        candidateStageSummaries: [],
      },
    ]);

    const result = await service.findAll(TENANT_ID, undefined, undefined, undefined, true);

    expect(mockPrisma.candidate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: TENANT_ID,
          jobId: null,
        }),
      }),
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].job_id).toBeNull();
  });

  it('returns all candidates when unassigned=false', async () => {
    mockPrisma.candidate.findMany.mockResolvedValue([
      {
        id: 'cand-1',
        jobId: null,
        fullName: 'Unassigned',
        applications: [],
        duplicateFlags: [],
        candidateStageSummaries: [],
      },
      {
        id: 'cand-2',
        jobId: 'job-uuid',
        fullName: 'Assigned',
        applications: [],
        duplicateFlags: [],
        candidateStageSummaries: [],
      },
    ]);

    const result = await service.findAll(TENANT_ID, undefined, undefined, undefined, false);

    expect(result.candidates).toHaveLength(2);
  });

  it('combines unassigned filter with search query', async () => {
    mockPrisma.candidate.findMany.mockResolvedValue([
      {
        id: 'cand-1',
        jobId: null,
        fullName: 'John',
        applications: [],
        duplicateFlags: [],
        candidateStageSummaries: [],
      },
    ]);

    await service.findAll(TENANT_ID, 'john', undefined, undefined, true);

    expect(mockPrisma.candidate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          jobId: null,
          OR: expect.any(Array),
        }),
      }),
    );
  });

  it('takes precedence over jobId param when both provided', async () => {
    mockPrisma.candidate.findMany.mockResolvedValue([]);

    await service.findAll(TENANT_ID, undefined, undefined, 'some-job-id', true);

    // unassigned=true should override jobId filter
    expect(mockPrisma.candidate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          jobId: null,
        }),
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Response Format Compliance Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('CandidatesService - Response Format Compliance', () => {
  let service: CandidatesService;
  let mockPrisma: { candidate: { findMany: jest.Mock; findFirst: jest.Mock } };

  const TENANT_ID = '11111111-1111-1111-1111-111111111111';

  beforeEach(async () => {
    mockPrisma = {
      candidate: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CandidatesService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: StorageService, useValue: {} },
        { provide: ScoringAgentService, useValue: {} },
        { provide: CandidateAiService, useValue: {} },
        { provide: AttachmentExtractorService, useValue: {} },
      ],
    }).compile();

    service = module.get<CandidatesService>(CandidatesService);
  });

  afterEach(() => jest.clearAllMocks());

  it('returns flattened response with no applications array', async () => {
    mockPrisma.candidate.findMany.mockResolvedValue([
      {
        id: 'cand-1',
        fullName: 'Test',
        email: 'test@example.com',
        applications: [{ scores: [] }],
        jobId: 'job-1',
        hiringStageId: 'stage-1',
        hiringStage: { name: 'New' },
        duplicateFlags: [],
        candidateStageSummaries: [],
        source: 'linkedin',
        sourceAgency: 'LinkedIn',
        createdAt: new Date(),
        skills: [],
        status: 'active',
        aiSummary: null,
      },
    ]);

    const result = await service.findAll(TENANT_ID);

    // Verify response has sourceAgency field
    expect(result.candidates[0].source_agency).toBe('LinkedIn');

    // Verify NO applications array in response
    expect(result.candidates[0]).not.toHaveProperty('applications');
  });

  it('returns ai_score from denormalized field', async () => {
    mockPrisma.candidate.findMany.mockResolvedValue([
      {
        id: 'cand-1',
        aiScore: 80, // C-5: aiScore is now denormalized (was computed from applications)
        applications: [],
        duplicateFlags: [],
        candidateStageSummaries: [],
      },
    ]);

    const result = await service.findAll(TENANT_ID);

    expect(result.candidates[0].ai_score).toBe(80);
  });

  it('includes sourceAgency in response', async () => {
    mockPrisma.candidate.findMany.mockResolvedValue([
      {
        id: 'cand-1',
        fullName: 'Test',
        sourceAgency: 'LinkedIn',
        applications: [],
        duplicateFlags: [],
        candidateStageSummaries: [],
      },
    ]);

    const result = await service.findAll(TENANT_ID);

    expect(result.candidates[0].source_agency).toBe('LinkedIn');
  });
});

describe('CandidatesService.getCvBytes()', () => {
  let service: CandidatesService;
  let mockStorageService: { getObject: jest.Mock };
  let mockPrisma: { candidate: { findFirst: jest.Mock } };

  beforeEach(async () => {
    mockStorageService = {
      getObject: jest.fn().mockResolvedValue({ body: Buffer.from('PDF'), contentType: 'application/pdf' }),
    };
    mockPrisma = { candidate: { findFirst: jest.fn() } };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CandidatesService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: StorageService, useValue: mockStorageService },
        { provide: ScoringAgentService, useValue: { score: jest.fn() } },
        { provide: CandidateAiService, useValue: { generateSummary: jest.fn() } },
        { provide: AttachmentExtractorService, useValue: { extract: jest.fn() } },
      ],
    }).compile();

    service = module.get<CandidatesService>(CandidatesService);
  });

  afterEach(() => jest.clearAllMocks());

  it('returns the CV bytes, content type, and derived filename (tenant-scoped lookup)', async () => {
    mockPrisma.candidate.findFirst.mockResolvedValue({ cvFileUrl: 'cvs/tenant-1/msg-1.pdf', fullName: 'Jane Doe' });

    const result = await service.getCvBytes('cand-1', TENANT_ID);

    expect(result.body).toEqual(Buffer.from('PDF'));
    expect(result.contentType).toBe('application/pdf');
    expect(result.filename).toBe('Jane_Doe.pdf');
    // Lookup must be scoped by BOTH id and tenantId (no cross-tenant CV reads).
    expect(mockPrisma.candidate.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'cand-1', tenantId: TENANT_ID } }),
    );
    expect(mockStorageService.getObject).toHaveBeenCalledWith('cvs/tenant-1/msg-1.pdf');
  });

  it('sanitizes non-ASCII/unsafe names into an ASCII-safe filename', async () => {
    mockPrisma.candidate.findFirst.mockResolvedValue({
      cvFileUrl: 'cvs/tenant-1/msg-1.docx',
      fullName: 'שרה כהן / "hacker"\r\nInjected',
    });

    const result = await service.getCvBytes('cand-1', TENANT_ID);

    // No CR/LF, slashes, or quotes leak into the Content-Disposition value.
    expect(result.filename).toMatch(/^[\w.-]+\.docx$/);
    expect(result.filename).not.toMatch(/[\r\n"/]/);
  });

  it('falls back to a .bin extension when the object key has no extension', async () => {
    mockPrisma.candidate.findFirst.mockResolvedValue({ cvFileUrl: 'cvs/tenant-1/no-ext', fullName: 'Jane' });

    const result = await service.getCvBytes('cand-1', TENANT_ID);

    // Must not spill the whole slash-containing key into the filename.
    expect(result.filename).toBe('Jane.bin');
  });

  it('throws 404 NOT_FOUND when the candidate does not exist', async () => {
    mockPrisma.candidate.findFirst.mockResolvedValue(null);

    await expect(service.getCvBytes('missing', TENANT_ID)).rejects.toMatchObject({
      response: { error: { code: 'NOT_FOUND' } },
    });
    expect(mockStorageService.getObject).not.toHaveBeenCalled();
  });

  it('throws 404 NO_CV when the candidate has no CV on file', async () => {
    mockPrisma.candidate.findFirst.mockResolvedValue({ cvFileUrl: null, fullName: 'Jane' });

    await expect(service.getCvBytes('cand-1', TENANT_ID)).rejects.toMatchObject({
      response: { error: { code: 'NO_CV' } },
    });
    expect(mockStorageService.getObject).not.toHaveBeenCalled();
  });

  it('maps a stale/deleted R2 key (NoSuchKey) to 404 NO_CV instead of a 500', async () => {
    mockPrisma.candidate.findFirst.mockResolvedValue({ cvFileUrl: 'cvs/tenant-1/gone.pdf', fullName: 'Jane' });
    const noSuchKey = new Error('The specified key does not exist.');
    noSuchKey.name = 'NoSuchKey';
    mockStorageService.getObject.mockRejectedValue(noSuchKey);

    await expect(service.getCvBytes('cand-1', TENANT_ID)).rejects.toMatchObject({
      response: { error: { code: 'NO_CV' } },
    });
  });

  it('propagates unexpected storage errors (not swallowed as NO_CV)', async () => {
    mockPrisma.candidate.findFirst.mockResolvedValue({ cvFileUrl: 'cvs/tenant-1/msg-1.pdf', fullName: 'Jane' });
    mockStorageService.getObject.mockRejectedValue(new Error('R2 network timeout'));

    await expect(service.getCvBytes('cand-1', TENANT_ID)).rejects.toThrow('R2 network timeout');
  });
});
