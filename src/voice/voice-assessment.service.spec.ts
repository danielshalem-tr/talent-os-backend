jest.mock('ai', () => ({ generateText: jest.fn(), Output: { object: jest.fn((spec: unknown) => spec) } }));
import { generateText } from 'ai';
import { ConfigService } from '@nestjs/config';
import { renderAssessment, VoiceAssessmentService } from './voice-assessment.service';

const mockGenerateText = generateText as jest.MockedFunction<typeof generateText>;

function makeConfig(): ConfigService {
  const values: Record<string, string> = { OPENROUTER_API_KEY: 'test-key' };
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

const ASSESSMENT = {
  answers: [
    { question: 'Are you legally allowed to work in Israel?', answer: 'Yes.', flags: [] },
    { question: 'How many years of React?', answer: '—', flags: ['not_answered'] },
  ],
  recommendation: 'Review — the React-experience question was never answered.',
};

describe('renderAssessment', () => {
  it('renders the header, every question (flagged ones included) and the recommendation', () => {
    const text = renderAssessment(ASSESSMENT as never, { attempt: 1, durationSecs: 241 });
    expect(text).toBe(
      '[AI screening-call assessment — attempt 1, 4 min]\n' +
        '\n' +
        '1. Are you legally allowed to work in Israel?\n' +
        '   Answer: Yes.\n' +
        '2. How many years of React?\n' +
        '   Answer: —\n' +
        '   Flags: not actually answered\n' +
        '\n' +
        'Recommendation: Review — the React-experience question was never answered.',
    );
  });

  it('omits the duration when unknown', () => {
    const text = renderAssessment(ASSESSMENT as never, { attempt: 2, durationSecs: null });
    expect(text.startsWith('[AI screening-call assessment — attempt 2]\n')).toBe(true);
  });
});

describe('VoiceAssessmentService.generateAssessment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGenerateText.mockResolvedValue({ output: ASSESSMENT } as never);
  });

  it('sends numbered questions + labeled transcript turns at temperature 0, returns rendered text', async () => {
    const svc = new VoiceAssessmentService({} as never, makeConfig());
    const text = await svc.generateAssessment({
      transcript: [
        { role: 'agent', message: 'שלום, יש כמה רגעים?' },
        { role: 'user', message: 'כן, בטח' },
      ],
      questions: [{ text: 'X' }, { text: 'Y' }],
      attempt: 1,
      durationSecs: 241,
    });
    const call = mockGenerateText.mock.calls[0][0] as Record<string, unknown>;
    expect(call.prompt).toContain('1. X\n2. Y');
    expect(call.prompt).toContain('Interviewer: שלום, יש כמה רגעים?');
    expect(call.prompt).toContain('Candidate: כן, בטח');
    expect(call.temperature).toBe(0);
    expect(text).toContain('[AI screening-call assessment — attempt 1, 4 min]');
    expect(text).toContain('How many years of React?');
  });

  it('propagates LLM/schema failures — nothing is swallowed here', async () => {
    mockGenerateText.mockRejectedValue(new Error('response did not match schema'));
    const svc = new VoiceAssessmentService({} as never, makeConfig());
    await expect(
      svc.generateAssessment({ transcript: [], questions: [], attempt: 1, durationSecs: null }),
    ).rejects.toThrow('response did not match schema');
  });
});

describe('VoiceAssessmentService.assessCall', () => {
  const TENANT = '11111111-1111-1111-1111-111111111111';
  const ROW = {
    id: 'vc1',
    tenantId: TENANT,
    candidateId: 'cand1',
    jobId: 'job1',
    status: 'completed',
    attempt: 1,
    durationSecs: 241,
    transcript: [
      { role: 'agent', message: 'שלום', time_in_call_secs: 0 },
      { role: 'user', message: 'היי', time_in_call_secs: 2 },
      { role: 'agent', message: 'מותר לך לעבוד בישראל?', time_in_call_secs: 5 },
      { role: 'user', message: 'כן', time_in_call_secs: 9 },
    ],
    candidate: { hiringStageId: 'stage1' },
    job: { screeningQuestions: [{ text: 'X' }, { text: 'Y' }] },
  };

  function makeMocks(rowOverrides: Record<string, unknown> = {}) {
    const row = { ...ROW, ...rowOverrides };
    const tx = {
      candidate: { update: jest.fn().mockResolvedValue({}) },
      application: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const prisma = {
      voiceCall: { findUniqueOrThrow: jest.fn().mockResolvedValue(row) },
      application: { findUnique: jest.fn().mockResolvedValue(null) },
      jobStage: {
        // findMany feeds the advance (enabled stages by order). findFirst serves three
        // callers: the "does this stage belong to the call's job" scoping check, the
        // first-enabled-stage fallback, and moveCandidateToStage's target validation —
        // so it echoes back a queried id and falls back to the first stage otherwise.
        findMany: jest.fn().mockResolvedValue([{ id: 'stage1' }, { id: 'stage2' }, { id: 'stage3' }]),
        findFirst: jest.fn(({ where }: { where: { id?: string } }) =>
          Promise.resolve(where.id ? { id: where.id } : { id: 'stage1' }),
        ),
      },
      candidateStageSummary: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
      },
      candidate: { findFirst: jest.fn().mockResolvedValue({ id: 'cand1', jobId: 'job1' }) },
      $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<void>) => fn(tx)),
    };
    const svc = new VoiceAssessmentService(prisma as never, makeConfig());
    return { prisma, tx, svc };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockGenerateText.mockResolvedValue({ output: ASSESSMENT } as never);
  });

  it('writes the assessment to candidate.hiringStageId and advances to the next enabled stage', async () => {
    const { svc, prisma, tx } = makeMocks();
    await svc.assessCall('vc1');
    expect(prisma.candidateStageSummary.create).toHaveBeenCalledWith({
      data: {
        tenantId: TENANT,
        candidateId: 'cand1',
        jobStageId: 'stage1',
        summary: expect.stringContaining('[AI screening-call assessment — attempt 1, 4 min]'),
      },
    });
    expect(tx.candidate.update).toHaveBeenCalledWith({
      where: { id: 'cand1' },
      data: { hiringStageId: 'stage2' },
    });
  });

  it('falls back to application.jobStageId when the candidate has no hiringStageId', async () => {
    const { svc, prisma } = makeMocks({ candidate: { hiringStageId: null } });
    prisma.application.findUnique.mockResolvedValue({ jobStageId: 'stage2' });
    await svc.assessCall('vc1');
    expect(prisma.application.findUnique).toHaveBeenCalledWith({
      where: { idx_applications_unique: { tenantId: TENANT, candidateId: 'cand1', jobId: 'job1' } },
      select: { jobStageId: true },
    });
    expect(prisma.candidateStageSummary.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ jobStageId: 'stage2' }),
    });
  });

  it("falls back to the job's first enabled stage by order when candidate and application are both unset", async () => {
    const { svc, prisma } = makeMocks({ candidate: { hiringStageId: null } });
    await svc.assessCall('vc1');
    expect(prisma.jobStage.findFirst).toHaveBeenCalledWith({
      where: { jobId: 'job1', tenantId: TENANT, isEnabled: true },
      orderBy: { order: 'asc' },
      select: { id: true },
    });
    expect(prisma.candidateStageSummary.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ jobStageId: 'stage1' }),
    });
  });

  it('no stage resolvable → logs and skips: no LLM call, no write, no advance', async () => {
    const { svc, prisma } = makeMocks({ candidate: { hiringStageId: null } });
    prisma.jobStage.findFirst.mockResolvedValue(null);
    await expect(svc.assessCall('vc1')).resolves.toBeUndefined();
    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(prisma.candidateStageSummary.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('existing summary → no LLM call, no write, and NO advance (redelivery/watchdog race safe)', async () => {
    const { svc, prisma } = makeMocks();
    prisma.candidateStageSummary.findUnique.mockResolvedValue({ id: 'existing' });
    await svc.assessCall('vc1');
    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(prisma.candidateStageSummary.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('P2002 race on create → treated as existing: no advance', async () => {
    const { svc, prisma } = makeMocks();
    prisma.candidateStageSummary.create.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
    await expect(svc.assessCall('vc1')).resolves.toBeUndefined();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('last enabled stage → summary written, candidate not moved', async () => {
    const { svc, prisma } = makeMocks({ candidate: { hiringStageId: 'stage3' } });
    await svc.assessCall('vc1');
    expect(prisma.candidateStageSummary.create).toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('malformed LLM output → rejects, nothing written (BullMQ will retry per VOICE_JOB_OPTS)', async () => {
    mockGenerateText.mockRejectedValue(new Error('response did not match schema'));
    const { svc, prisma } = makeMocks();
    await expect(svc.assessCall('vc1')).rejects.toThrow('response did not match schema');
    expect(prisma.candidateStageSummary.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('defense-in-depth: a non-completed row is never assessed', async () => {
    const { svc } = makeMocks({ status: 'failed' });
    await svc.assessCall('vc1');
    expect(mockGenerateText).not.toHaveBeenCalled();
  });
});

describe('VoiceAssessmentService.assessCall — substance gate + job scoping (review fixes)', () => {
  const TENANT = '11111111-1111-1111-1111-111111111111';

  function makeMocks(rowOverrides: Record<string, unknown> = {}) {
    const tx = {
      candidate: { update: jest.fn().mockResolvedValue({}) },
      application: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const row = {
      id: 'vc1',
      tenantId: TENANT,
      candidateId: 'cand1',
      jobId: 'job1',
      status: 'completed',
      attempt: 1,
      durationSecs: 241,
      transcript: [
        { role: 'agent', message: 'שלום', time_in_call_secs: 0 },
        { role: 'user', message: 'היי', time_in_call_secs: 2 },
        { role: 'agent', message: 'מותר לך לעבוד בישראל?', time_in_call_secs: 5 },
        { role: 'user', message: 'כן', time_in_call_secs: 9 },
      ],
      candidate: { hiringStageId: 'stage1' },
      job: { screeningQuestions: [{ text: 'X' }] },
      ...rowOverrides,
    };
    const prisma = {
      voiceCall: { findUniqueOrThrow: jest.fn().mockResolvedValue(row) },
      application: { findUnique: jest.fn().mockResolvedValue(null) },
      jobStage: {
        findMany: jest.fn().mockResolvedValue([{ id: 'stage1' }, { id: 'stage2' }]),
        findFirst: jest.fn(({ where }: { where: { id?: string } }) =>
          Promise.resolve(where.id ? { id: where.id } : { id: 'stage1' }),
        ),
      },
      candidateStageSummary: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
      },
      candidate: { findFirst: jest.fn().mockResolvedValue({ id: 'cand1', jobId: 'job1' }) },
      $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<void>) => fn(tx)),
    };
    const svc = new VoiceAssessmentService(prisma as never, makeConfig());
    return { prisma, tx, svc };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockGenerateText.mockResolvedValue({ output: ASSESSMENT } as never);
  });

  it('an instant hang-up (agent greeting only) is never assessed and never advances', async () => {
    const { svc, prisma } = makeMocks({
      durationSecs: 4,
      transcript: [{ role: 'agent', message: 'היי, קוראים לי נועה', time_in_call_secs: 0 }],
    });
    await svc.assessCall('vc1');
    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(prisma.candidateStageSummary.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('a thin call is assessed and recorded, but the candidate is NOT advanced', async () => {
    const { svc, prisma } = makeMocks({
      durationSecs: 11,
      transcript: [
        { role: 'agent', message: 'היי, יש כמה רגעים?', time_in_call_secs: 0 },
        { role: 'user', message: 'לא עכשיו', time_in_call_secs: 3 },
      ],
    });
    await svc.assessCall('vc1');
    expect(prisma.candidateStageSummary.create).toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('a real conversation of unknown duration still advances', async () => {
    const { svc, prisma } = makeMocks({ durationSecs: null });
    await svc.assessCall('vc1');
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('turns with a null message are dropped — the LLM never sees the string "null"', async () => {
    const { svc } = makeMocks({
      transcript: [
        { role: 'agent', message: 'שלום', time_in_call_secs: 0 },
        { role: 'agent', message: null, time_in_call_secs: 1 },
        { role: 'user', message: 'היי', time_in_call_secs: 2 },
        { role: 'user', message: '   ', time_in_call_secs: 3 },
        { role: 'user', message: 'כן בטח', time_in_call_secs: 4 },
      ],
    });
    await svc.assessCall('vc1');
    const call = mockGenerateText.mock.calls[0][0] as Record<string, unknown>;
    expect(call.prompt).not.toContain('null');
    expect(call.prompt).toContain('Candidate: היי');
  });

  it('null-message turns do not count toward the substance gate', async () => {
    const { svc, prisma } = makeMocks({
      durationSecs: 240,
      transcript: [
        { role: 'agent', message: 'שלום', time_in_call_secs: 0 },
        { role: 'user', message: 'היי', time_in_call_secs: 2 },
        { role: 'user', message: null, time_in_call_secs: 3 },
      ],
    });
    await svc.assessCall('vc1');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("ignores candidate.hiringStageId when it belongs to a different job than the call's", async () => {
    const { svc, prisma } = makeMocks();
    // stage1 is not a stage of job1 → the scoping check finds nothing
    prisma.jobStage.findFirst.mockResolvedValueOnce(null).mockResolvedValue({ id: 'stage9' });
    prisma.application.findUnique.mockResolvedValue({ jobStageId: 'stage2' });
    await svc.assessCall('vc1');
    expect(prisma.jobStage.findFirst).toHaveBeenCalledWith({
      where: { id: 'stage1', jobId: 'job1', tenantId: TENANT },
      select: { id: true },
    });
    expect(prisma.candidateStageSummary.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ jobStageId: 'stage2' }),
    });
  });

  it('logs instead of silently dropping when a recruiter note already occupies the stage', async () => {
    const { svc, prisma } = makeMocks();
    const warn = jest.spyOn((svc as never as { logger: { warn: (m: string) => void } }).logger, 'warn');
    prisma.candidateStageSummary.findUnique.mockResolvedValue({ id: 'existing' });
    await svc.assessCall('vc1');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('already has a stage summary'));
  });
});
