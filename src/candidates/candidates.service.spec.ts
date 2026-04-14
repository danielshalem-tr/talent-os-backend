import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { CandidatesService } from './candidates.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { ScoringAgentService } from '../scoring/scoring.service';
import { CandidateAiService } from './candidate-ai.service';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

// Helper to build a mock candidate row as Prisma would return it
function mockCandidate(overrides: Partial<{
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
  applications: { scores: { score: number }[] }[];
  duplicateFlags: { id: string }[];
  candidateStageSummaries: { jobStageId: string; summary: string }[];
  status: string;
  aiSummary: string | null;
}> = {}) {
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
    ...overrides,
  };
}

describe('CandidatesService', () => {
  let service: CandidatesService;
  let prismaMock: { candidate: { findMany: jest.Mock } };

  beforeEach(async () => {
    prismaMock = {
      candidate: {
        findMany: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CandidatesService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: StorageService, useValue: { uploadFromBuffer: jest.fn() } },
        { provide: ScoringAgentService, useValue: { score: jest.fn().mockResolvedValue({ score: 75, reasoning: 'Test', strengths: [], gaps: [], modelUsed: 'test' }) } },
        { provide: CandidateAiService, useValue: { generateSummary: jest.fn().mockResolvedValue('Test summary') } },
      ],
    }).compile();

    service = module.get<CandidatesService>(CandidatesService);
  });

  afterEach(() => {
    jest.clearAllMocks();
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

  // Test 6: filter='duplicates' → WHERE duplicateFlags.some reviewed=false
  it('filter=duplicates adds duplicateFlags.some condition to where clause', async () => {
    prismaMock.candidate.findMany.mockResolvedValue([]);

    await service.findAll(TENANT_ID, undefined, 'duplicates');

    expect(prismaMock.candidate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: TENANT_ID,
          duplicateFlags: { some: { reviewed: false } },
        }),
      }),
    );
  });

  // Test 7: no scores → ai_score is null
  it('returns ai_score=null when candidate has no application scores', async () => {
    prismaMock.candidate.findMany.mockResolvedValue([
      mockCandidate({ applications: [] }),
    ]);

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
  };

  beforeEach(async () => {
    mockStorageService = { uploadFromBuffer: jest.fn().mockResolvedValue('cvs/tenant-123/cand-id.pdf') };

    mockPrisma = {
      job: { findFirst: jest.fn().mockResolvedValue({ id: BASE_DTO.job_id }) },
      jobStage: { findFirst: jest.fn().mockResolvedValue({ id: 'stage-uuid' }) },
      candidate: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
      application: { create: jest.fn() },
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
        { provide: ScoringAgentService, useValue: { score: jest.fn().mockResolvedValue({ score: 75, reasoning: 'Test', strengths: [], gaps: [], modelUsed: 'test' }) } },
        { provide: CandidateAiService, useValue: { generateSummary: jest.fn().mockResolvedValue('Test summary') } },
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
    txDuplicateFlag.deleteMany.mockImplementation(async () => { order.push('duplicateFlag'); return { count: 0 }; });
    txEmailIntakeLog.updateMany.mockImplementation(async () => { order.push('emailIntakeLog'); return { count: 0 }; });
    txCandidate.delete.mockImplementation(async () => { order.push('candidate'); return { id: CAND_ID }; });

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
      { id: 'cand-1', jobId: null, fullName: 'Unassigned', applications: [], duplicateFlags: [], candidateStageSummaries: [] },
      { id: 'cand-2', jobId: 'job-uuid', fullName: 'Assigned', applications: [], duplicateFlags: [], candidateStageSummaries: [] },
    ]);

    const result = await service.findAll(TENANT_ID, undefined, undefined, undefined, false);

    expect(result.candidates).toHaveLength(2);
  });

  it('combines unassigned filter with search query', async () => {
    mockPrisma.candidate.findMany.mockResolvedValue([
      { id: 'cand-1', jobId: null, fullName: 'John', applications: [], duplicateFlags: [], candidateStageSummaries: [] },
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

  it('combines unassigned filter with duplicates filter', async () => {
    mockPrisma.candidate.findMany.mockResolvedValue([
      { id: 'cand-1', jobId: null, duplicateFlags: [{ id: 'dup-1', reviewed: false }], applications: [], candidateStageSummaries: [] },
    ]);

    await service.findAll(TENANT_ID, undefined, 'duplicates', undefined, true);

    expect(mockPrisma.candidate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          jobId: null,
          duplicateFlags: { some: { reviewed: false } },
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
