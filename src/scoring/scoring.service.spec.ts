import { ConfigService } from '@nestjs/config';
import { generateText } from 'ai';
import { completeEvaluation, ScoringAgentService, ScoringInput } from './scoring.service';
import { SCORING_SYSTEM_PROMPT } from './scoring-prompt';

jest.mock('ai', () => ({
  generateText: jest.fn(),
  Output: { object: jest.fn((spec: unknown) => spec) },
}));
jest.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: jest.fn().mockReturnValue({ chat: jest.fn().mockReturnValue('mocked-model') }),
}));

const mockGenerateText = generateText as jest.MockedFunction<typeof generateText>;

function makeService(): ScoringAgentService {
  const configService = { get: jest.fn().mockReturnValue('fake-openrouter-key') } as unknown as ConfigService;
  return new ScoringAgentService(configService);
}

const evaluation = {
  must_haves: [
    {
      requirement: 'TypeScript',
      kind: 'skill',
      status: 'met',
      evidence: 'TypeScript at Acme',
      evidence_strength: 'demonstrated',
      exact_match: false,
    },
    {
      requirement: 'PostgreSQL',
      kind: 'skill',
      status: 'missing',
      evidence: 'not found',
      evidence_strength: 'none',
      exact_match: false,
    },
  ],
  nice_to_haves: [],
  relevant_years: 7,
  role_relevance: 90,
  cv_informative: true,
  reasoning: 'Strong TS, no Postgres.',
  strengths: ['TypeScript expertise'],
  gaps: ['No PostgreSQL mentioned'],
};

const input = (): ScoringInput => ({
  cvText: 'Experienced TypeScript engineer with Node.js background.',
  candidateFields: {
    currentRole: 'Senior Software Engineer',
    yearsExperience: 7,
    skills: ['TypeScript', 'Node.js'],
  },
  job: {
    title: 'Backend Engineer',
    description: 'Build scalable APIs.',
    roleSummary: null,
    responsibilities: null,
    mustHaveSkills: ['TypeScript', 'PostgreSQL'],
    niceToHaveSkills: [],
    expYearsMin: 3,
    expYearsMax: 8,
    preferredOrgTypes: [],
    screeningQuestions: [],
  },
});

describe('ScoringAgentService', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls generateText with the system prompt, the built user prompt and temperature 0', async () => {
    mockGenerateText.mockResolvedValue({ output: evaluation } as never);
    await makeService().score(input());
    const args = mockGenerateText.mock.calls[0][0] as unknown as {
      model: string;
      system: string;
      prompt: string;
      temperature: number;
      output: { name: string };
    };
    expect(args.model).toBe('mocked-model');
    expect(args.system).toBe(SCORING_SYSTEM_PROMPT);
    expect(args.prompt).toContain('M1. TypeScript');
    expect(args.prompt).toContain('Experienced TypeScript engineer');
    expect(args.temperature).toBe(0);
    expect(args.output.name).toBe('CandidateEvaluation');
  });

  it('computes the score from the evaluation via the policy and returns the breakdown', async () => {
    mockGenerateText.mockResolvedValue({ output: evaluation } as never);
    const result = await makeService().score(input());
    expect(result.score).toBeLessThanOrEqual(60); // one core must-have missing → cap 60
    expect(result.breakdown.caps_applied).toContainEqual({ label: 'core_must_have_missing', cap: 60 });
    expect(result.breakdown.must_haves).toHaveLength(2);
    expect(result.reasoning).toBe('Strong TS, no Postgres.');
    expect(result.strengths).toEqual(['TypeScript expertise']);
    expect(result.gaps).toEqual(['No PostgreSQL mentioned']);
    expect(result.modelUsed).toBe('anthropic/claude-sonnet-5');
  });

  it('always reports the hard-coded anthropic/claude-sonnet-5 model', async () => {
    mockGenerateText.mockResolvedValue({ output: evaluation } as never);
    const result = await makeService().score(input());
    expect(result.modelUsed).toBe('anthropic/claude-sonnet-5');
  });

  it('propagates generateText failures', async () => {
    mockGenerateText.mockRejectedValue(new Error('rate limited'));
    await expect(makeService().score(input())).rejects.toThrow('rate limited');
  });

  it('does not throw on a 50K-char CV (truncated internally)', async () => {
    mockGenerateText.mockResolvedValue({ output: evaluation } as never);
    await expect(makeService().score({ ...input(), cvText: 'a'.repeat(50_000) })).resolves.toBeDefined();
  });
});

describe('ScoringAgentService sampling', () => {
  beforeEach(() => jest.clearAllMocks());

  it('runs SCORING_SAMPLES evaluations and persists the median one', async () => {
    const met = { ...evaluation.must_haves[0] };
    const missing = { ...evaluation.must_haves[1] };
    const strong = {
      ...evaluation,
      must_haves: [met, { ...missing, status: 'met', evidence_strength: 'demonstrated' }],
      reasoning: 'strong',
    };
    const weak = { ...evaluation, must_haves: [{ ...met, status: 'missing' }, missing], reasoning: 'weak' };
    mockGenerateText
      .mockResolvedValueOnce({ output: strong } as never)
      .mockResolvedValueOnce({ output: weak } as never)
      .mockResolvedValueOnce({ output: evaluation } as never);
    const result = await makeService().score(input());
    expect(mockGenerateText).toHaveBeenCalledTimes(3);
    expect(result.reasoning).toBe('Strong TS, no Postgres.'); // the middle score's evaluation
    expect(result.breakdown.caps_applied).toContainEqual({ label: 'core_must_have_missing', cap: 60 });
  });

  it('keeps the successful samples when one of three fails, throws only when all fail', async () => {
    mockGenerateText
      .mockRejectedValueOnce(new Error('429'))
      .mockResolvedValueOnce({ output: evaluation } as never)
      .mockResolvedValueOnce({ output: evaluation } as never);
    const ok = await makeService().score(input());
    expect(ok.reasoning).toBe('Strong TS, no Postgres.');
    mockGenerateText.mockRejectedValue(new Error('all down'));
    await expect(makeService().score(input())).rejects.toThrow('all down');
  });

  it('honours opts.samples for the eval harness', async () => {
    mockGenerateText.mockResolvedValue({ output: evaluation } as never);
    await makeService().score(input(), { samples: 1 });
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });
});

describe('completeEvaluation', () => {
  const job = {
    title: 'x',
    description: null,
    roleSummary: null,
    responsibilities: null,
    mustHaveSkills: ['TypeScript', 'PostgreSQL', 'React'],
    niceToHaveSkills: ['Docker'],
    expYearsMin: null,
    expYearsMax: null,
    preferredOrgTypes: [],
    screeningQuestions: [],
  };
  const met = {
    requirement: 'typescript ',
    kind: 'skill' as const,
    status: 'met' as const,
    evidence: 'TS at Acme',
    evidence_strength: 'demonstrated' as const,
    exact_match: false,
  };
  const base = {
    relevant_years: 3,
    role_relevance: 80,
    cv_informative: true,
    reasoning: '',
    strengths: [],
    gaps: [],
  };

  it('appends every job requirement the model skipped as missing, so coverage cannot inflate', () => {
    const out = completeEvaluation({ ...base, must_haves: [met], nice_to_haves: [] }, job);
    expect(out.must_haves.map((r) => [r.requirement, r.status])).toEqual([
      ['typescript ', 'met'],
      ['PostgreSQL', 'missing'],
      ['React', 'missing'],
    ]);
    expect(out.nice_to_haves).toEqual([expect.objectContaining({ requirement: 'Docker', status: 'missing' })]);
  });

  it('leaves a complete evaluation untouched (same array reference)', () => {
    const full = [met, { ...met, requirement: 'PostgreSQL' }, { ...met, requirement: 'React' }];
    expect(
      completeEvaluation({ ...base, must_haves: full, nice_to_haves: [] }, { ...job, niceToHaveSkills: [] }).must_haves,
    ).toBe(full);
  });

  it('a repeated requirement cannot stand in for a missing one', () => {
    const out = completeEvaluation(
      { ...base, must_haves: [{ ...met, requirement: 'TypeScript' }, { ...met, requirement: 'typescript' }], nice_to_haves: [] },
      { ...job, mustHaveSkills: ['TypeScript', 'Postgres'], niceToHaveSkills: [] },
    );
    expect(out.must_haves.map((r) => [r.requirement, r.status])).toEqual([
      ['TypeScript', 'met'],
      ['Postgres', 'missing'],
    ]);
  });
});
