import { Test, TestingModule } from '@nestjs/testing';
import { DedupService } from './dedup.service';
import { PrismaService } from '../prisma/prisma.service';
import { CandidateExtract } from '../ingestion/services/extraction-agent.service';

export function mockCandidateDedupExtract(
  overrides: Partial<CandidateExtract> = {},
): CandidateExtract {
  return {
    fullName: 'Jane Doe',
    email: 'jane.doe@example.com',
    phone: '+1-555-0100',
    currentRole: 'Senior Software Engineer',
    yearsExperience: 7,
    skills: ['TypeScript', 'Node.js'],
    summary: 'Experienced engineer.',
    source: 'direct',
    suspicious: false,
    ...overrides,
  };
}

describe('DedupService', () => {
  let service: DedupService;
  let prisma: {
    candidate: {
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      upsert: jest.Mock;
    };
    duplicateFlag: { upsert: jest.Mock };
    $queryRaw: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      candidate: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'new-candidate-id' }),
        update: jest.fn().mockResolvedValue({}),
        upsert: jest.fn().mockResolvedValue({ id: 'upserted-id' }),
      },
      duplicateFlag: {
        upsert: jest.fn().mockResolvedValue({}),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DedupService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<DedupService>(DedupService);
  });

  afterEach(() => jest.clearAllMocks());

  // DEDUP-01: $queryRaw executes pg_trgm in PostgreSQL — no candidate array loaded into memory
  it('DEDUP-01: executes in PostgreSQL — $queryRaw called for fuzzy, no candidate array returned', async () => {
    const extract = mockCandidateDedupExtract({ email: null }); // null email skips findFirst
    prisma.$queryRaw.mockResolvedValue([]); // no fuzzy match

    const result = await service.check(extract, 'tenant-abc');

    expect(prisma.candidate.findFirst).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
  });

  // DEDUP-02: exact email match returns confidence 1.0
  it('DEDUP-02: exact email match returns confidence 1.0 and fields=[email]', async () => {
    prisma.candidate.findFirst.mockResolvedValue({ id: 'existing-123' });
    const extract = mockCandidateDedupExtract({ email: 'jane.doe@example.com' });

    const result = await service.check(extract, 'tenant-abc');

    expect(result).toEqual({
      match: { id: 'existing-123' },
      confidence: 1.0,
      fields: ['email'],
    });
    // Fuzzy query should NOT run after exact match (D-01: stop at first match)
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  // DEDUP-03: fuzzy name match > 0.7 returns confidence=name_sim and fields=[name]
  it('DEDUP-03: fuzzy match name_sim > 0.7 returns confidence=name_sim and fields=[name]', async () => {
    prisma.candidate.findFirst.mockResolvedValue(null); // no exact email match
    prisma.$queryRaw.mockResolvedValue([
      { id: 'fuzzy-456', full_name: 'Jon Doe', name_sim: 0.85 },
    ]);
    const extract = mockCandidateDedupExtract({ email: 'jon@example.com' });

    const result = await service.check(extract, 'tenant-abc');

    expect(result).toEqual({
      match: { id: 'fuzzy-456' },
      confidence: 0.85,
      fields: ['name'],
    });
  });

  // DEDUP-04: no match (no email match, fuzzy below threshold) returns null
  it('DEDUP-04: no match returns null', async () => {
    prisma.candidate.findFirst.mockResolvedValue(null);
    prisma.$queryRaw.mockResolvedValue([]); // no fuzzy match
    const extract = mockCandidateDedupExtract();

    const result = await service.check(extract, 'tenant-abc');

    expect(result).toBeNull();
  });

  // DEDUP-05: createFlag uses upsert with reviewed=false — never auto-merges (D-12, D-13)
  it('DEDUP-05: createFlag upserts with reviewed=false on duplicate_flags', async () => {
    await service.createFlag('new-id', 'match-id', 0.85, 'tenant-abc');

    expect(prisma.duplicateFlag.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          idx_duplicates_pair: {
            tenantId: 'tenant-abc',
            candidateId: 'new-id',
            matchedCandidateId: 'match-id',
          },
        },
        create: expect.objectContaining({
          reviewed: false,
          matchFields: ['name'],
        }),
        update: {}, // no-op on retry
      }),
    );
  });
});
