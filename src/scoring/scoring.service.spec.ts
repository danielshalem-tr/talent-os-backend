import { ConfigService } from '@nestjs/config';
import { generateObject } from 'ai';
import { ScoringAgentService, ScoringInput } from './scoring.service';
import { SCORING_SYSTEM_PROMPT } from './scoring-prompt';

jest.mock('ai', () => ({ generateObject: jest.fn() }));
jest.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: jest.fn().mockReturnValue({ chat: jest.fn().mockReturnValue('mocked-model') }),
}));

const mockGenerateObject = generateObject as jest.MockedFunction<typeof generateObject>;

function makeService(model?: string): ScoringAgentService {
  const configService = {
    get: jest.fn().mockImplementation((key: string) => (key === 'SCORING_MODEL' ? model : 'fake-openrouter-key')),
  } as unknown as ConfigService;
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

  it('calls generateObject with the system prompt, the built user prompt and temperature 0', async () => {
    mockGenerateObject.mockResolvedValueOnce({ object: evaluation } as never);
    await makeService('openai/gpt-4.1-mini').score(input());
    const args = mockGenerateObject.mock.calls[0][0] as unknown as {
      model: string;
      system: string;
      prompt: string;
      temperature: number;
      schemaName: string;
    };
    expect(args.model).toBe('mocked-model');
    expect(args.system).toBe(SCORING_SYSTEM_PROMPT);
    expect(args.prompt).toContain('M1. TypeScript');
    expect(args.prompt).toContain('Experienced TypeScript engineer');
    expect(args.temperature).toBe(0);
    expect(args.schemaName).toBe('CandidateEvaluation');
  });

  it('computes the score from the evaluation via the policy and returns the breakdown', async () => {
    mockGenerateObject.mockResolvedValueOnce({ object: evaluation } as never);
    const result = await makeService('openai/gpt-4.1-mini').score(input());
    expect(result.score).toBeLessThanOrEqual(60); // one core must-have missing → cap 60
    expect(result.breakdown.caps_applied).toContainEqual({ label: 'core_must_have_missing', cap: 60 });
    expect(result.breakdown.must_haves).toHaveLength(2);
    expect(result.reasoning).toBe('Strong TS, no Postgres.');
    expect(result.strengths).toEqual(['TypeScript expertise']);
    expect(result.gaps).toEqual(['No PostgreSQL mentioned']);
    expect(result.modelUsed).toBe('openai/gpt-4.1-mini');
  });

  it('defaults SCORING_MODEL to anthropic/claude-sonnet-5', async () => {
    mockGenerateObject.mockResolvedValueOnce({ object: evaluation } as never);
    const result = await makeService(undefined).score(input());
    expect(result.modelUsed).toBe('anthropic/claude-sonnet-5');
  });

  it('propagates generateObject failures', async () => {
    mockGenerateObject.mockRejectedValueOnce(new Error('rate limited'));
    await expect(makeService('x').score(input())).rejects.toThrow('rate limited');
  });

  it('does not throw on a 50K-char CV (truncated internally)', async () => {
    mockGenerateObject.mockResolvedValueOnce({ object: evaluation } as never);
    await expect(makeService('x').score({ ...input(), cvText: 'a'.repeat(50_000) })).resolves.toBeDefined();
  });
});
