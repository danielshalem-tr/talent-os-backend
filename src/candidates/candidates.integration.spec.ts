// Phase 12 Integration Tests: POST /candidates + GET /jobs/list
// Tests controller → service behavior using mocked Prisma and StorageService (no live DB needed)
// Covers: success flows, error responses (400, 404, 409), file upload, GET /jobs/list

import {
  BadRequestException,
  ConflictException,
  INestApplication,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CandidatesController } from './candidates.controller';
import { CandidatesService } from './candidates.service';
import { JobsController } from '../jobs/jobs.controller';
import { JobsService } from '../jobs/jobs.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { StorageService } from '../storage/storage.service';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
// Valid RFC 4122 v4 UUID (Zod v4 enforces RFC 4122 format)
const JOB_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

function makeMockCandidate(overrides: Record<string, any> = {}) {
  return {
    id: 'cand-uuid',
    tenantId: TENANT_ID,
    fullName: 'Jane Doe',
    email: 'jane@example.com',
    phone: null,
    currentRole: null,
    location: null,
    yearsExperience: null,
    skills: [],
    cvText: null,
    cvFileUrl: null,
    source: 'linkedin',
    sourceAgency: null,
    sourceEmail: null,
    aiSummary: null,
    metadata: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function makeMockApplication(overrides: Record<string, any> = {}) {
  return {
    id: 'app-uuid',
    tenantId: TENANT_ID,
    candidateId: 'cand-uuid',
    jobId: JOB_ID,
    stage: 'new',
    appliedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function makeTransactionMock(candidateOverrides: Record<string, any> = {}) {
  return jest.fn().mockImplementation(async (fn: any) =>
    fn({
      candidate: {
        create: jest.fn().mockResolvedValue(makeMockCandidate(candidateOverrides)),
      },
      application: {
        create: jest.fn().mockResolvedValue(makeMockApplication()),
      },
    }),
  );
}

function makeBasePrisma(overrides: Record<string, any> = {}) {
  return {
    job: {
      findFirst: jest.fn().mockResolvedValue({ id: JOB_ID }),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn(),
      findUnique: jest.fn(),
      findFirstOrThrow: jest.fn(),
    },
    candidate: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    $transaction: makeTransactionMock(),
    ...overrides,
  };
}

function makeCandidatesController(
  mockPrisma: any,
  mockStorageService: any = { uploadFromBuffer: jest.fn() },
) {
  const mockConfig = { get: jest.fn().mockReturnValue(TENANT_ID) };
  const service = new CandidatesService(
    mockPrisma as any,
    mockConfig as any,
    mockStorageService as any,
  );
  return new CandidatesController(service);
}

function makeJobsController(mockPrisma: any) {
  const mockConfig = { get: jest.fn().mockReturnValue(TENANT_ID) };
  const service = new JobsService(mockPrisma as any, mockConfig as any);
  return new JobsController(service);
}

// ─── POST /candidates ──────────────────────────────────────────────────────────

describe('POST /candidates', () => {
  // Test 1: Success flow without file
  it('201 — creates candidate without CV file and returns snake_case response', async () => {
    const mockPrisma = makeBasePrisma();
    const controller = makeCandidatesController(mockPrisma);

    const result = await controller.create(undefined, {
      full_name: 'Jane Doe',
      email: 'jane@example.com',
      job_id: JOB_ID,
      source: 'linkedin',
      skills: [],
    });

    expect(result).toHaveProperty('id', 'cand-uuid');
    expect(result).toHaveProperty('cv_file_url', null);
    expect(result).toHaveProperty('cv_text', null);
    expect(result).toHaveProperty('application_id', 'app-uuid');
    expect(result).toHaveProperty('full_name', 'Jane Doe');
    expect(result).toHaveProperty('source', 'linkedin');
  });

  // Test 2: Success flow with CV file
  it('201 — creates candidate with CV file uploaded to R2', async () => {
    const cvFileUrl = `cvs/${TENANT_ID}/cand-uuid.pdf`;
    const mockStorageService = {
      uploadFromBuffer: jest.fn().mockResolvedValue(cvFileUrl),
    };
    const mockPrisma = makeBasePrisma({
      $transaction: makeTransactionMock({ cvFileUrl }),
    });
    const controller = makeCandidatesController(mockPrisma, mockStorageService);

    const file: Express.Multer.File = {
      buffer: Buffer.from('PDF content'),
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

    const result = await controller.create(file, {
      full_name: 'Jane Doe',
      email: 'jane@example.com',
      job_id: JOB_ID,
      source: 'linkedin',
      skills: [],
    });

    expect(result).toHaveProperty('cv_file_url', cvFileUrl);
    expect(mockStorageService.uploadFromBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      'application/pdf',
      TENANT_ID,
      expect.any(String),
    );
  });

  // Test 3: Validation error — invalid email
  it('400 — throws BadRequestException for invalid email format', async () => {
    const mockPrisma = makeBasePrisma();
    const controller = makeCandidatesController(mockPrisma);

    await expect(
      controller.create(undefined, {
        full_name: 'Jane Doe',
        email: 'not-an-email',
        job_id: JOB_ID,
        source: 'linkedin',
        skills: [],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  // Test 4: Validation error — invalid file type (propagated from StorageService)
  it('400 — throws BadRequestException for invalid file type', async () => {
    const mockStorageService = {
      uploadFromBuffer: jest.fn().mockRejectedValue(
        new BadRequestException({
          error: { code: 'INVALID_FILE_TYPE', message: 'Invalid file type' },
        }),
      ),
    };
    const mockPrisma = makeBasePrisma();
    const controller = makeCandidatesController(mockPrisma, mockStorageService);

    const file: Express.Multer.File = {
      buffer: Buffer.from('EXE content'),
      mimetype: 'application/x-msdownload',
      originalname: 'malware.exe',
      fieldname: 'cv_file',
      encoding: '7bit',
      size: 11,
      stream: null as any,
      destination: '',
      filename: '',
      path: '',
    };

    await expect(
      controller.create(file, {
        full_name: 'Jane Doe',
        email: 'jane@example.com',
        job_id: JOB_ID,
        source: 'linkedin',
        skills: [],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  // Test 5: 404 — job not found
  it('404 — throws NotFoundException when job_id does not exist', async () => {
    const mockPrisma = makeBasePrisma({
      job: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        update: jest.fn(),
        findUnique: jest.fn(),
        findFirstOrThrow: jest.fn(),
      },
    });
    const controller = makeCandidatesController(mockPrisma);

    await expect(
      controller.create(undefined, {
        full_name: 'Nobody',
        email: 'nobody@example.com',
        job_id: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a99',
        source: 'website',
        skills: [],
      }),
    ).rejects.toThrow(NotFoundException);
  });

  // Test 6: 409 — duplicate email
  it('409 — throws ConflictException for duplicate email', async () => {
    const mockPrisma = makeBasePrisma({
      candidate: {
        findFirst: jest.fn().mockResolvedValue({ id: 'existing-cand' }),
        findMany: jest.fn().mockResolvedValue([]),
      },
    });
    const controller = makeCandidatesController(mockPrisma);

    await expect(
      controller.create(undefined, {
        full_name: 'Duplicate',
        email: 'existing@example.com',
        job_id: JOB_ID,
        source: 'linkedin',
        skills: [],
      }),
    ).rejects.toThrow(ConflictException);
  });
});

// ─── GET /jobs/list ────────────────────────────────────────────────────────────

describe('GET /jobs/list', () => {
  // Test 7: Returns only open jobs with minimal fields
  it('200 — returns open jobs with {id, title, department} fields only', async () => {
    const openJob = { id: JOB_ID, title: 'Senior Engineer', department: 'Engineering' };
    const mockPrisma = makeBasePrisma({
      job: {
        findMany: jest.fn().mockResolvedValue([openJob]),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        findUnique: jest.fn(),
        findFirstOrThrow: jest.fn(),
      },
    });
    const controller = makeJobsController(mockPrisma);

    const result = await controller.getOpenJobs();

    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toEqual({ id: JOB_ID, title: 'Senior Engineer', department: 'Engineering' });
    expect(result.jobs[0]).not.toHaveProperty('hiring_flow');
    expect(result.jobs[0]).not.toHaveProperty('screening_questions');
    expect(result.jobs[0]).not.toHaveProperty('status');
  });

  // Test 8: Returns empty array when no open jobs
  it('200 — returns empty jobs array when no open jobs exist', async () => {
    const mockPrisma = makeBasePrisma({
      job: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        findUnique: jest.fn(),
        findFirstOrThrow: jest.fn(),
      },
    });
    const controller = makeJobsController(mockPrisma);

    const result = await controller.getOpenJobs();

    expect(result.jobs).toHaveLength(0);
  });

  // Test 9: Filters by status='open' only
  it('filters by tenantId and status=open in prisma query', async () => {
    const mockFindMany = jest.fn().mockResolvedValue([]);
    const mockPrisma = makeBasePrisma({
      job: {
        findMany: mockFindMany,
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        findUnique: jest.fn(),
        findFirstOrThrow: jest.fn(),
      },
    });
    const controller = makeJobsController(mockPrisma);

    await controller.getOpenJobs();

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: TENANT_ID, status: 'open' }),
      }),
    );
  });
});
