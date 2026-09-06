import { parseContactBlocklist } from './contact-blocklist';
import { mergeCandidates, planPhoneMerges } from './merge-candidates';

const T = '11111111-1111-1111-1111-111111111111';
const d = (iso: string) => new Date(iso);

describe('planPhoneMerges', () => {
  const none = parseContactBlocklist('');

  it('groups by normalised digits, oldest row survives, newer rows merge into it', () => {
    const plan = planPhoneMerges(
      [
        { id: 'b', email: null, phone: '050-123-4567', createdAt: d('2026-02-01') },
        { id: 'a', email: null, phone: '+972 50 123 4567', createdAt: d('2026-01-01') },
        { id: 'c', email: null, phone: '0501234567', createdAt: d('2026-03-01') },
      ],
      none,
    );
    // '+972 50…' and '050…' differ in digits (97250… vs 050…) — only b and c share digits.
    expect(plan.merges).toEqual([{ survivorId: 'b', removedId: 'c', digits: '0501234567' }]);
    expect(plan.shared).toEqual([]);
  });

  it('applies the D1 email guard: different non-null emails are two people, reported as shared', () => {
    const plan = planPhoneMerges(
      [
        { id: 'a', email: 'a@x.com', phone: '0501234567', createdAt: d('2026-01-01') },
        { id: 'b', email: 'b@x.com', phone: '0501234567', createdAt: d('2026-02-01') },
        { id: 'c', email: null, phone: '0501234567', createdAt: d('2026-03-01') },
        { id: 'e', email: 'a@x.com', phone: '0501234567', createdAt: d('2026-04-01') },
      ],
      none,
    );
    expect(plan.merges).toEqual([
      { survivorId: 'a', removedId: 'c', digits: '0501234567' },
      { survivorId: 'a', removedId: 'e', digits: '0501234567' },
    ]);
    expect(plan.shared).toEqual([{ survivorId: 'a', otherId: 'b', digits: '0501234567' }]);
  });

  it('tracks the survivor email it will acquire, so a second different email is shared, not merged', () => {
    const plan = planPhoneMerges(
      [
        { id: 'a', email: null, phone: '0501234567', createdAt: d('2026-01-01') },
        { id: 'b', email: 'b@x.com', phone: '0501234567', createdAt: d('2026-02-01') },
        { id: 'c', email: 'c@x.com', phone: '0501234567', createdAt: d('2026-03-01') },
      ],
      none,
    );
    expect(plan.merges).toEqual([{ survivorId: 'a', removedId: 'b', digits: '0501234567' }]);
    expect(plan.shared).toEqual([{ survivorId: 'a', otherId: 'c', digits: '0501234567' }]);
  });

  it('treats emails that differ only in case as one person', () => {
    const plan = planPhoneMerges(
      [
        { id: 'a', email: 'Snir1603@gmail.com', phone: '0508513558', createdAt: d('2026-01-01') },
        { id: 'b', email: 'snir1603@gmail.com', phone: '0508513558', createdAt: d('2026-02-01') },
      ],
      none,
    );
    expect(plan.merges).toEqual([{ survivorId: 'a', removedId: 'b', digits: '0508513558' }]);
    expect(plan.shared).toEqual([]);
  });

  it('ignores blocklisted phones, null phones and junk phones', () => {
    const plan = planPhoneMerges(
      [
        { id: 'a', email: null, phone: '+1 555 010 0000', createdAt: d('2026-01-01') },
        { id: 'b', email: null, phone: '15550100000', createdAt: d('2026-02-01') },
        { id: 'c', email: null, phone: null, createdAt: d('2026-03-01') },
        { id: 'e', email: null, phone: '-', createdAt: d('2026-04-01') },
        { id: 'f', email: null, phone: '-', createdAt: d('2026-05-01') },
      ],
      parseContactBlocklist('+1 555 010 0000'),
    );
    expect(plan.merges).toEqual([]);
    expect(plan.shared).toEqual([]);
  });
});

describe('mergeCandidates', () => {
  const survivorRow = {
    id: 'S',
    tenantId: T,
    email: null,
    phone: '0501234567',
    fullName: 'Old Name',
    jobId: null,
    hiringStageId: null,
    currentRole: null,
    yearsExperience: null,
    location: 'Haifa',
    skills: [],
    cvText: null,
    cvFileUrl: null,
    aiSummary: null,
    aiScore: 60,
    isScoreOverridden: false,
    createdAt: d('2026-01-01'),
  };
  const removedRow = {
    id: 'R',
    tenantId: T,
    email: 'new@x.com',
    phone: '050-123-4567',
    fullName: 'New Name',
    jobId: 'job-1',
    hiringStageId: 'stage-1',
    currentRole: 'Dev',
    yearsExperience: 4,
    location: null,
    skills: ['ts'],
    cvText: 'cv',
    cvFileUrl: 'r2/key',
    aiSummary: 'sum',
    aiScore: 80,
    isScoreOverridden: false,
    createdAt: d('2026-02-01'),
  };

  function makeTx(overrides: Record<string, unknown> = {}) {
    const calls: string[] = [];
    const track = (name: string, value: unknown = {}) =>
      jest.fn(async () => {
        calls.push(name);
        return value;
      });
    const tx = {
      candidate: {
        findFirstOrThrow: jest.fn(async ({ where }: { where: { id: string } }) =>
          where.id === 'S' ? survivorRow : removedRow,
        ),
        delete: track('candidate.delete'),
        update: track('candidate.update'),
      },
      application: {
        findMany: jest.fn(async ({ where }: { where: { candidateId: string } }) =>
          where.candidateId === 'S'
            ? [
                {
                  id: 'appS1',
                  jobId: 'job-1',
                  jobStageId: null,
                  scores: [
                    {
                      id: 'scS1',
                      score: 50,
                      reasoning: 'r',
                      strengths: [],
                      gaps: [],
                      breakdown: null,
                      modelUsed: 'm',
                      matchConfidence: null,
                      scoredAt: new Date('2026-09-01T10:00:00.000Z'),
                    },
                  ],
                },
              ]
            : [
                {
                  id: 'appR1',
                  jobId: 'job-1',
                  jobStageId: 'stage-1',
                  scores: [
                    {
                      id: 'scR1',
                      score: 80,
                      reasoning: 'better',
                      strengths: ['a'],
                      gaps: [],
                      breakdown: { version: 1 },
                      modelUsed: 'm2',
                      matchConfidence: null,
                      scoredAt: new Date('2026-09-05T10:00:00.000Z'),
                    },
                  ],
                },
                { id: 'appR2', jobId: 'job-2', jobStageId: null, scores: [] },
              ],
        ),
        update: track('application.update'),
        delete: track('application.delete'),
      },
      candidateJobScore: { update: track('score.update') },
      emailIntakeLog: { updateMany: track('intake.updateMany', { count: 2 }) },
      voiceCall: { updateMany: track('voice.updateMany', { count: 1 }) },
      candidateStageSummary: {
        findMany: jest.fn(async ({ where }: { where: { candidateId: string } }) =>
          where.candidateId === 'S'
            ? [{ id: 'sumS', jobStageId: 'stage-1' }]
            : [
                { id: 'sumR1', jobStageId: 'stage-1' },
                { id: 'sumR2', jobStageId: 'stage-9' },
              ],
        ),
        update: track('summary.update'),
        delete: track('summary.delete'),
      },
      duplicateFlag: { deleteMany: track('flags.deleteMany', { count: 0 }) },
      ...overrides,
    };
    return { tx, calls };
  }

  it('re-points every child table, resolves conflicts, deletes flags before the row, then fills the survivor', async () => {
    const { tx, calls } = makeTx();

    const log = await mergeCandidates(tx as never, { tenantId: T, survivorId: 'S', removedId: 'R' });

    // Applications: job-1 conflict → survivor keeps its application, higher score copied onto it, stage filled, loser deleted.
    expect(tx.candidateJobScore.update).toHaveBeenCalledWith({
      where: { id: 'scS1' },
      data: {
        score: 80,
        reasoning: 'better',
        strengths: ['a'],
        gaps: [],
        modelUsed: 'm2',
        matchConfidence: null,
        // The copied score keeps the timestamp it was actually computed at, so scored_at
        // never describes a score the row no longer holds.
        scoredAt: new Date('2026-09-05T10:00:00.000Z'),
        breakdown: { version: 1 },
      },
    });
    expect(tx.application.update).toHaveBeenCalledWith({ where: { id: 'appS1' }, data: { jobStageId: 'stage-1' } });
    expect(tx.application.delete).toHaveBeenCalledWith({ where: { id: 'appR1' } });
    // job-2 no conflict → re-pointed.
    expect(tx.application.update).toHaveBeenCalledWith({ where: { id: 'appR2' }, data: { candidateId: 'S' } });

    expect(tx.emailIntakeLog.updateMany).toHaveBeenCalledWith({
      where: { candidateId: 'R' },
      data: { candidateId: 'S' },
    });
    expect(tx.voiceCall.updateMany).toHaveBeenCalledWith({ where: { candidateId: 'R' }, data: { candidateId: 'S' } });

    // Summaries: stage-1 conflict → loser deleted; stage-9 → re-pointed.
    expect(tx.candidateStageSummary.delete).toHaveBeenCalledWith({ where: { id: 'sumR1' } });
    expect(tx.candidateStageSummary.update).toHaveBeenCalledWith({
      where: { id: 'sumR2' },
      data: { candidateId: 'S' },
    });

    // Flags gone before the candidate row (both FKs are RESTRICT), row deleted before the survivor's email is written.
    expect(tx.duplicateFlag.deleteMany).toHaveBeenCalledWith({
      where: { OR: [{ candidateId: 'R' }, { matchedCandidateId: 'R' }] },
    });
    expect(calls.indexOf('flags.deleteMany')).toBeLessThan(calls.indexOf('candidate.delete'));
    expect(calls.indexOf('candidate.delete')).toBeLessThan(calls.indexOf('candidate.update'));

    // Survivor: contact COALESCE (email filled, phone kept), enrichment newer-wins, pointer from removed since survivor had none, aiScore max.
    expect(tx.candidate.update).toHaveBeenCalledWith({
      where: { id: 'S' },
      data: {
        currentRole: 'Dev',
        yearsExperience: 4,
        location: 'Haifa',
        skills: ['ts'],
        cvText: 'cv',
        cvFileUrl: 'r2/key',
        aiSummary: 'sum',
        jobId: 'job-1',
        hiringStageId: 'stage-1',
        aiScore: 80,
        email: 'new@x.com',
      },
    });

    expect(log).toEqual({
      survivor: 'S',
      removed: 'R',
      fields: expect.arrayContaining([
        'email',
        'currentRole',
        'yearsExperience',
        'skills',
        'cvText',
        'cvFileUrl',
        'aiSummary',
        'jobId',
        'hiringStageId',
        'aiScore',
      ]),
      moved: { applications: 1, intakeLogs: 2, voiceCalls: 1, summaries: 1 },
    });
    expect(log.fields).not.toContain('phone');
    expect(log.fields).not.toContain('location');
  });

  it('keeps the survivor pointer when set, and keeps the survivor score when it is the higher one', async () => {
    const { tx } = makeTx({
      candidate: {
        findFirstOrThrow: jest.fn(async ({ where }: { where: { id: string } }) =>
          where.id === 'S' ? { ...survivorRow, jobId: 'job-7', hiringStageId: 'stage-7' } : removedRow,
        ),
        delete: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
      application: {
        findMany: jest.fn(async ({ where }: { where: { candidateId: string } }) =>
          where.candidateId === 'S'
            ? [
                {
                  id: 'appS1',
                  jobId: 'job-1',
                  jobStageId: 'stage-1',
                  scores: [
                    {
                      id: 'scS1',
                      score: 90,
                      reasoning: 'r',
                      strengths: [],
                      gaps: [],
                      breakdown: null,
                      modelUsed: 'm',
                      matchConfidence: null,
                    },
                  ],
                },
              ]
            : [
                {
                  id: 'appR1',
                  jobId: 'job-1',
                  jobStageId: 'stage-2',
                  scores: [
                    {
                      id: 'scR1',
                      score: 80,
                      reasoning: 'x',
                      strengths: [],
                      gaps: [],
                      breakdown: null,
                      modelUsed: 'm',
                      matchConfidence: null,
                    },
                  ],
                },
              ],
        ),
        update: jest.fn().mockResolvedValue({}),
        delete: jest.fn().mockResolvedValue({}),
      },
    });

    await mergeCandidates(tx as never, { tenantId: T, survivorId: 'S', removedId: 'R' });

    expect(tx.candidateJobScore.update).not.toHaveBeenCalled();
    expect(tx.application.update).not.toHaveBeenCalled(); // survivor already had a stage on job-1
    expect(tx.application.delete).toHaveBeenCalledWith({ where: { id: 'appR1' } });
    expect(tx.candidate.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ jobId: 'job-7', hiringStageId: 'stage-7' }) }),
    );
  });

  it('moves the loser score row onto the survivor application when the survivor has none', async () => {
    const { tx } = makeTx({
      application: {
        findMany: jest.fn(async ({ where }: { where: { candidateId: string } }) =>
          where.candidateId === 'S'
            ? [{ id: 'appS1', jobId: 'job-1', jobStageId: 'stage-1', scores: [] }]
            : [
                {
                  id: 'appR1',
                  jobId: 'job-1',
                  jobStageId: null,
                  scores: [
                    {
                      id: 'scR1',
                      score: 80,
                      reasoning: 'x',
                      strengths: [],
                      gaps: [],
                      breakdown: null,
                      modelUsed: 'm',
                      matchConfidence: null,
                    },
                  ],
                },
              ],
        ),
        update: jest.fn().mockResolvedValue({}),
        delete: jest.fn().mockResolvedValue({}),
      },
    });

    await mergeCandidates(tx as never, { tenantId: T, survivorId: 'S', removedId: 'R' });

    expect(tx.candidateJobScore.update).toHaveBeenCalledWith({
      where: { id: 'scR1' },
      data: { applicationId: 'appS1' },
    });
  });

  it('never writes aiScore while the survivor override is sticky', async () => {
    const { tx } = makeTx({
      candidate: {
        findFirstOrThrow: jest.fn(async ({ where }: { where: { id: string } }) =>
          where.id === 'S' ? { ...survivorRow, isScoreOverridden: true, aiScore: 33 } : removedRow,
        ),
        delete: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
    });

    await mergeCandidates(tx as never, { tenantId: T, survivorId: 'S', removedId: 'R' });

    const data = tx.candidate.update.mock.calls[0][0].data;
    expect(data.aiScore).toBeUndefined();
  });

  it('refuses to merge a row into itself', async () => {
    const { tx } = makeTx();
    await expect(mergeCandidates(tx as never, { tenantId: T, survivorId: 'S', removedId: 'S' })).rejects.toThrow(
      /differ/,
    );
  });
});
