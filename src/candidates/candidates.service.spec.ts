import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { CandidatesService } from './candidates.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

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
  createdAt: Date;
  skills: string[];
  applications: { scores: { score: number }[] }[];
  duplicateFlags: { id: string }[];
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
    createdAt: new Date('2026-01-01T00:00:00Z'),
    skills: ['TypeScript', 'React'],
    applications: [],
    duplicateFlags: [],
    ...overrides,
  };
}

describe('CandidatesService', () => {
  let service: CandidatesService;
  let prismaMock: { candidate: { findMany: jest.Mock } };
  let configMock: { get: jest.Mock };

  beforeEach(async () => {
    prismaMock = {
      candidate: {
        findMany: jest.fn(),
      },
    };
    configMock = {
      get: jest.fn().mockReturnValue(TENANT_ID),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CandidatesService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: ConfigService, useValue: configMock },
        { provide: StorageService, useValue: { uploadFromBuffer: jest.fn() } },
      ],
    }).compile();

    service = module.get<CandidatesService>(CandidatesService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // Test 1: no params → returns all candidates with ai_score computed from nested scores
  it('returns all candidates scoped to tenantId with ai_score computed', async () => {
    prismaMock.candidate.findMany.mockResolvedValue([
      mockCandidate({
        applications: [{ scores: [{ score: 80 }, { score: 65 }] }],
        duplicateFlags: [],
      }),
    ]);

    const result = await service.findAll();

    expect(prismaMock.candidate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: TENANT_ID }),
      }),
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.candidates[0].ai_score).toBe(80); // MAX of [80, 65]
    expect(result.candidates[0].full_name).toBe('John Doe');
    expect(result.candidates[0].is_duplicate).toBe(false);
  });

  // Test 2: q='jane' → WHERE contains jane in fullName/email/currentRole
  it('filters by q param using ILIKE on fullName, email, currentRole', async () => {
    prismaMock.candidate.findMany.mockResolvedValue([]);

    await service.findAll('jane');

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

  // Test 3: filter='high-score' → only candidates with ai_score >= 70
  it('filter=high-score returns only candidates with ai_score >= 70', async () => {
    prismaMock.candidate.findMany.mockResolvedValue([
      mockCandidate({ id: 'cand-1', applications: [{ scores: [{ score: 85 }] }] }),
      mockCandidate({ id: 'cand-2', applications: [{ scores: [{ score: 50 }] }] }),
      mockCandidate({ id: 'cand-3', applications: [] }), // no scores → null
    ]);

    const result = await service.findAll(undefined, 'high-score');

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].id).toBe('cand-1');
    expect(result.candidates[0].ai_score).toBe(85);
    expect(result.total).toBe(1);
  });

  // Test 4: filter='available' → WHERE applications.none in hired/rejected
  it('filter=available adds applications.none condition to where clause', async () => {
    prismaMock.candidate.findMany.mockResolvedValue([]);

    await service.findAll(undefined, 'available');

    expect(prismaMock.candidate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: TENANT_ID,
          applications: { none: { stage: { in: ['hired', 'rejected'] } } },
        }),
      }),
    );
  });

  // Test 5: filter='referred' → WHERE source='referral'
  it('filter=referred adds source=referral condition to where clause', async () => {
    prismaMock.candidate.findMany.mockResolvedValue([]);

    await service.findAll(undefined, 'referred');

    expect(prismaMock.candidate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: TENANT_ID,
          source: 'referral',
        }),
      }),
    );
  });

  // Test 6: filter='duplicates' → WHERE duplicateFlags.some reviewed=false
  it('filter=duplicates adds duplicateFlags.some condition to where clause', async () => {
    prismaMock.candidate.findMany.mockResolvedValue([]);

    await service.findAll(undefined, 'duplicates');

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

    const result = await service.findAll();

    expect(result.candidates[0].ai_score).toBeNull();
  });

  // Test 8: no unreviewed flags → is_duplicate is false
  it('returns is_duplicate=false when all duplicate_flags are reviewed', async () => {
    prismaMock.candidate.findMany.mockResolvedValue([
      mockCandidate({ duplicateFlags: [] }), // reviewed=false flags filtered in select — empty means none unreviewed
    ]);

    const result = await service.findAll();

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
    job: { findUnique: jest.Mock };
    candidate: { findFirst: jest.Mock; findMany: jest.Mock };
    application: { create: jest.Mock };
    $transaction: jest.Mock;
  };
  let mockConfig: { get: jest.Mock };

  beforeEach(async () => {
    mockStorageService = { uploadFromBuffer: jest.fn().mockResolvedValue('cvs/tenant-123/cand-id.pdf') };

    mockPrisma = {
      job: { findUnique: jest.fn().mockResolvedValue({ id: BASE_DTO.job_id }) },
      candidate: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
      application: { create: jest.fn() },
      $transaction: jest.fn().mockImplementation(async (fn: any) => {
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
    mockConfig = { get: jest.fn().mockReturnValue('tenant-123') };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CandidatesService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfig },
        { provide: StorageService, useValue: mockStorageService },
      ],
    }).compile();

    service = module.get<CandidatesService>(CandidatesService);
    jest.clearAllMocks();
    mockConfig.get.mockReturnValue('tenant-123');
    mockPrisma.job.findUnique.mockResolvedValue({ id: BASE_DTO.job_id });
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
    const result = await service.createCandidate(BASE_DTO, file);
    expect(mockStorageService.uploadFromBuffer).toHaveBeenCalledWith(
      file.buffer,
      'application/pdf',
      'tenant-123',
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
    await service.createCandidate(BASE_DTO, file);
    expect(mockStorageService.uploadFromBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'tenant-123',
      expect.any(String),
    );
  });

  it('should propagate BadRequestException for invalid file type', async () => {
    const file: Express.Multer.File = { ...makePdfFile(), mimetype: 'application/x-msdownload' };
    mockStorageService.uploadFromBuffer.mockRejectedValue(
      new BadRequestException({ error: { code: 'INVALID_FILE_TYPE', message: 'Invalid file type' } }),
    );
    await expect(service.createCandidate(BASE_DTO, file)).rejects.toThrow(BadRequestException);
  });

  // Email Uniqueness Tests

  it('should accept candidate with new email', async () => {
    mockPrisma.candidate.findFirst.mockResolvedValue(null);
    const result = await service.createCandidate(BASE_DTO, undefined);
    expect(result).toHaveProperty('application_id');
  });

  it('should reject duplicate email with ConflictException', async () => {
    mockPrisma.candidate.findFirst.mockResolvedValue({ id: 'existing-cand' });
    await expect(service.createCandidate(BASE_DTO, undefined)).rejects.toThrow(ConflictException);
  });

  // Transaction Atomicity Tests

  it('should create Candidate and Application atomically', async () => {
    const result = await service.createCandidate(BASE_DTO, undefined);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(result).toHaveProperty('id');
    expect(result).toHaveProperty('application_id', 'app-uuid');
  });

  it('should propagate error if Application create fails inside transaction', async () => {
    mockPrisma.$transaction.mockRejectedValue(new Error('DB error'));
    await expect(service.createCandidate(BASE_DTO, undefined)).rejects.toThrow('DB error');
  });

  // Tenant Isolation Test

  it('should validate job using tenantId composite key', async () => {
    await service.createCandidate(BASE_DTO, undefined);
    expect(mockPrisma.job.findUnique).toHaveBeenCalledWith({
      where: { id_tenantId: { id: BASE_DTO.job_id, tenantId: 'tenant-123' } },
    });
  });

  it('should throw NotFoundException if job does not exist', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(null);
    await expect(service.createCandidate(BASE_DTO, undefined)).rejects.toThrow(NotFoundException);
  });
});
