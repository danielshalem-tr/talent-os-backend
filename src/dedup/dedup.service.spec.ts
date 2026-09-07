import { Test, TestingModule } from '@nestjs/testing';
import { DedupService } from './dedup.service';
import { PrismaService } from '../prisma/prisma.service';
import { CandidateExtract } from '../ingestion/services/extraction-agent.service';

export function mockCandidateDedupExtract(overrides: Partial<CandidateExtract> = {}): CandidateExtract {
  return {
    full_name: 'Jane Doe',
    email: 'jane.doe@example.com',
    phone: '+1-555-0100',
    current_role: 'Software Engineer',
    years_experience: 5,
    location: 'Tel Aviv, Israel',
    skills: ['TypeScript', 'Node.js'],
    ai_summary: 'Experienced engineer.',
    source_hint: null,
    source_agency: null,
    ...overrides,
  };
}

describe('DedupService', () => {
  let service: DedupService;
  let prisma: {
    candidate: { create: jest.Mock; update: jest.Mock; findFirst: jest.Mock; findUniqueOrThrow: jest.Mock };
    $queryRaw: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      candidate: {
        create: jest.fn().mockResolvedValue({ id: 'new-candidate-id' }),
        update: jest.fn().mockResolvedValue({}),
        findFirst: jest.fn().mockResolvedValue(null),
        findUniqueOrThrow: jest.fn(),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [DedupService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<DedupService>(DedupService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('check()', () => {
    it('email match wins and skips the phone query', async () => {
      prisma.candidate.findFirst.mockResolvedValue({ id: 'existing-by-email' });

      const result = await service.check(mockCandidateDedupExtract(), 'tenant-abc');

      expect(result).toEqual({ outcome: 'match', candidateId: 'existing-by-email', field: 'email' });
      expect(prisma.candidate.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId: 'tenant-abc', email: { equals: 'jane.doe@example.com', mode: 'insensitive' } },
          orderBy: { createdAt: 'asc' },
        }),
      );
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('null email skips the email lookup and falls through to phone', async () => {
      prisma.$queryRaw.mockResolvedValue([{ id: 'phone-match-id', email: null }]);

      const result = await service.check(mockCandidateDedupExtract({ email: null }), 'tenant-abc');

      expect(prisma.candidate.findFirst).not.toHaveBeenCalled();
      expect(result).toEqual({ outcome: 'match', candidateId: 'phone-match-id', field: 'phone' });
    });

    it('no phone → new candidate, no phone query, no sentinel', async () => {
      const result = await service.check(mockCandidateDedupExtract({ email: null, phone: null }), 'tenant-abc');

      expect(result).toEqual({ outcome: 'new', sharedPhoneWith: null });
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('a phone with fewer than 7 digits is treated as no phone', async () => {
      const result = await service.check(mockCandidateDedupExtract({ email: null, phone: '-' }), 'tenant-abc');

      expect(result).toEqual({ outcome: 'new', sharedPhoneWith: null });
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('phone match with no DB hit → new candidate', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      const result = await service.check(mockCandidateDedupExtract({ phone: '+1-555-9999' }), 'tenant-abc');

      expect(result).toEqual({ outcome: 'new', sharedPhoneWith: null });
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('phone match with a compatible email (existing null) → match on phone', async () => {
      prisma.$queryRaw.mockResolvedValue([{ id: 'existing-123', email: null }]);

      const result = await service.check(mockCandidateDedupExtract(), 'tenant-abc');

      expect(result).toEqual({ outcome: 'match', candidateId: 'existing-123', field: 'phone' });
    });

    it('phone match with a compatible email (equal) → match on phone', async () => {
      // Only reachable when the email lookup missed (e.g. case difference would have missed too) —
      // guard must still treat equal strings as compatible.
      prisma.$queryRaw.mockResolvedValue([{ id: 'existing-123', email: 'jane.doe@example.com' }]);

      const result = await service.check(mockCandidateDedupExtract(), 'tenant-abc');

      expect(result).toEqual({ outcome: 'match', candidateId: 'existing-123', field: 'phone' });
    });

    it('phone match whose emails differ only in case → same person, match on phone', async () => {
      // Production had "Snir1603@" and "snir1603@" on one phone as two rows.
      prisma.candidate.findFirst.mockResolvedValue(null); // exact-case email lookup misses
      prisma.$queryRaw.mockResolvedValue([{ id: 'existing-123', email: 'JANE.DOE@example.com' }]);

      const result = await service.check(mockCandidateDedupExtract(), 'tenant-abc');

      expect(result).toEqual({ outcome: 'match', candidateId: 'existing-123', field: 'phone' });
    });

    it('phone match with two different non-null emails → new candidate that shares a phone (D1)', async () => {
      prisma.$queryRaw.mockResolvedValue([{ id: 'existing-123', email: 'other.person@example.com' }]);

      const result = await service.check(mockCandidateDedupExtract(), 'tenant-abc');

      expect(result).toEqual({ outcome: 'new', sharedPhoneWith: 'existing-123' });
    });

    it('chooses the first phone row whose email is compatible, not blindly the oldest', async () => {
      prisma.candidate.findFirst.mockResolvedValue(null);
      prisma.$queryRaw.mockResolvedValue([
        { id: 'oldest-other-person', email: 'someone.else@example.com' },
        { id: 'same-person', email: 'JANE.DOE@example.com' },
      ]);

      const result = await service.check(mockCandidateDedupExtract({ email: 'jane.doe@example.com' }), 'tenant-1');

      expect(result).toEqual({ outcome: 'match', candidateId: 'same-person', field: 'phone' });
    });

    it('is "new" when every phone row has a different email', async () => {
      prisma.candidate.findFirst.mockResolvedValue(null);
      prisma.$queryRaw.mockResolvedValue([
        { id: 'p1', email: 'a@example.com' },
        { id: 'p2', email: 'b@example.com' },
      ]);

      const result = await service.check(mockCandidateDedupExtract({ email: 'jane@example.com' }), 'tenant-1');

      expect(result).toEqual({ outcome: 'new', sharedPhoneWith: 'p1' });
    });

    it('with no incoming email, a phone shared by two distinct people is ambiguous → new', async () => {
      prisma.$queryRaw.mockResolvedValue([
        { id: 'p1', email: 'a@example.com' },
        { id: 'p2', email: 'b@example.com' },
      ]);

      const result = await service.check(mockCandidateDedupExtract({ email: null }), 'tenant-1');

      expect(result).toEqual({ outcome: 'new', sharedPhoneWith: 'p1' });
    });

    it('with no incoming email and a single phone row, merges onto it (unchanged behaviour)', async () => {
      prisma.$queryRaw.mockResolvedValue([{ id: 'p1', email: 'a@example.com' }]);

      const result = await service.check(mockCandidateDedupExtract({ email: null }), 'tenant-1');

      expect(result).toEqual({ outcome: 'match', candidateId: 'p1', field: 'phone' });
    });

    it('passes the digit-only phone into the raw query', async () => {
      await service.check(mockCandidateDedupExtract({ email: null, phone: '+1 (555) 010-0100' }), 'tenant-abc');

      // Tagged-template call: values are in the second argument onwards.
      const [, ...values] = prisma.$queryRaw.mock.calls[0];
      expect(values).toContain('15550100100');
    });
  });

  describe('insertCandidate()', () => {
    it('writes enrichment fields on insert so no bare shell is ever visible', async () => {
      await service.insertCandidate(mockCandidateDedupExtract(), 'tenant-1', 'from@example.com', undefined, 'direct', {
        currentRole: 'Dev',
        yearsExperience: 5,
        location: 'Tel Aviv, Israel',
        skills: ['ts'],
        cvText: 'CV',
        cvFileUrl: 'cvs/t/m.pdf',
        aiSummary: 'sum',
      });

      expect(prisma.candidate.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            currentRole: 'Dev',
            yearsExperience: 5,
            location: 'Tel Aviv, Israel',
            skills: ['ts'],
            cvText: 'CV',
            cvFileUrl: 'cvs/t/m.pdf',
            aiSummary: 'sum',
          }),
        }),
      );
    });

    it('stores blank CV text as null', async () => {
      await service.insertCandidate(mockCandidateDedupExtract(), 'tenant-1', 'from@example.com', undefined, 'direct', {
        currentRole: null,
        yearsExperience: null,
        location: null,
        skills: [],
        cvText: '   ',
        cvFileUrl: null,
        aiSummary: null,
      });

      expect(prisma.candidate.create.mock.calls[0][0].data.cvText).toBeNull();
    });
  });

  describe('fillContactFields()', () => {
    it('fills only null fields', async () => {
      prisma.candidate.findUniqueOrThrow.mockResolvedValue({ email: null, phone: null, fullName: '' });
      prisma.candidate.findFirst.mockResolvedValue(null); // email not held by anyone else

      const filled = await service.fillContactFields('cand-1', mockCandidateDedupExtract(), 'tenant-abc');

      expect(filled).toEqual(['email', 'phone', 'fullName']);
      expect(prisma.candidate.update).toHaveBeenCalledWith({
        where: { id: 'cand-1' },
        data: { email: 'jane.doe@example.com', phone: '+1-555-0100', fullName: 'Jane Doe' },
      });
    });

    it('never overwrites an existing value', async () => {
      prisma.candidate.findUniqueOrThrow.mockResolvedValue({
        email: 'kept@example.com',
        phone: '+972-50-000-0000',
        fullName: 'Kept Name',
      });

      const filled = await service.fillContactFields('cand-1', mockCandidateDedupExtract(), 'tenant-abc');

      expect(filled).toEqual([]);
      expect(prisma.candidate.update).not.toHaveBeenCalled();
    });

    it('does not fill an email another row already holds (idx_candidates_tenant_email_ci_unique)', async () => {
      prisma.candidate.findUniqueOrThrow.mockResolvedValue({ email: null, phone: '+1', fullName: 'X' });
      prisma.candidate.findFirst.mockResolvedValue({ id: 'someone-else' });

      const filled = await service.fillContactFields('cand-1', mockCandidateDedupExtract({ phone: null }), 'tenant-abc');

      expect(filled).toEqual([]);
      expect(prisma.candidate.findFirst).toHaveBeenCalledWith({
        where: {
          tenantId: 'tenant-abc',
          email: { equals: 'jane.doe@example.com', mode: 'insensitive' },
          NOT: { id: 'cand-1' },
        },
        select: { id: true },
      });
      expect(prisma.candidate.update).not.toHaveBeenCalled();
    });

    it('does not fill a junk phone (under the digit floor)', async () => {
      prisma.candidate.findUniqueOrThrow.mockResolvedValue({ email: 'a@b.c', phone: null, fullName: 'X' });

      const filled = await service.fillContactFields('cand-1', mockCandidateDedupExtract({ phone: '-' }), 'tenant-abc');

      expect(filled).toEqual([]);
      expect(prisma.candidate.update).not.toHaveBeenCalled();
    });

    it('uses the transaction client when one is passed', async () => {
      const tx = {
        candidate: {
          findUniqueOrThrow: jest.fn().mockResolvedValue({ email: 'a@b.c', phone: null, fullName: 'X' }),
          findFirst: jest.fn(),
          update: jest.fn().mockResolvedValue({}),
        },
      };

      await service.fillContactFields('cand-1', mockCandidateDedupExtract(), 'tenant-abc', tx as never);

      expect(tx.candidate.update).toHaveBeenCalledWith({ where: { id: 'cand-1' }, data: { phone: '+1-555-0100' } });
      expect(prisma.candidate.update).not.toHaveBeenCalled();
    });
  });

  it('insertCandidate writes the shell row and returns its id', async () => {
    const id = await service.insertCandidate(mockCandidateDedupExtract(), 'tenant-abc', 'from@example.com', undefined, 'agency');

    expect(id).toBe('new-candidate-id');
    expect(prisma.candidate.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tenantId: 'tenant-abc', fullName: 'Jane Doe', source: 'agency', sourceEmail: 'from@example.com' }),
      }),
    );
  });
});
