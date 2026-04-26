import { ConfigService } from '@nestjs/config';
import { ScoringAgentService, ScoreSchema, ScoringInput } from './scoring.service';
import { generateObject } from 'ai';

jest.mock('ai', () => ({
  generateObject: jest.fn(),
}));

jest.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: jest.fn().mockReturnValue({
    chat: jest.fn().mockReturnValue('mocked-model'),
  }),
}));

const mockGenerateObject = generateObject as jest.MockedFunction<typeof generateObject>;

function makeService(): ScoringAgentService {
  const configService = {
    get: jest.fn().mockImplementation((key: string) => {
      if (key === 'SCORING_MODEL') return 'openai/gpt-4o-mini';
      return 'fake-openrouter-key';
    }),
  } as unknown as ConfigService;
  return new ScoringAgentService(configService);
}

const validScoreObject = {
  score: 85,
  reasoning: 'Strong match. Candidate has relevant TypeScript experience.',
  strengths: ['TypeScript expertise', '6+ years experience'],
  gaps: ['No PostgreSQL mentioned'],
};

const mockScoringInput = (overrides: Partial<ScoringInput> = {}): ScoringInput => ({
  cvText: 'Experienced TypeScript engineer with Node.js background.',
  candidateFields: {
    currentRole: 'Senior Software Engineer',
    yearsExperience: 7,
    skills: ['TypeScript', 'Node.js'],
  },
  job: {
    title: 'Backend Engineer',
    description: 'Build scalable APIs.',
    requirements: ['TypeScript', 'PostgreSQL'],
  },
  ...overrides,
});

describe('ScoringAgentService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // SCOR-03: score() calls generateObject with correct model
  it('SCOR-03: score() calls generateObject with mocked-model', async () => {
    mockGenerateObject.mockResolvedValueOnce({ object: validScoreObject } as any);

    const service = makeService();
    await service.score(mockScoringInput());

    expect(mockGenerateObject).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'mocked-model' }),
    );
  });

  // ConfigService used to get API key
  it('reads OPENROUTER_API_KEY from ConfigService', async () => {
    mockGenerateObject.mockResolvedValueOnce({ object: validScoreObject } as any);

    const configService = { get: jest.fn().mockReturnValue('test-key') } as unknown as ConfigService;
    const service = new ScoringAgentService(configService);
    await service.score(mockScoringInput());

    expect(configService.get).toHaveBeenCalledWith('OPENROUTER_API_KEY');
  });

  // SCOR-05: modelUsed is set to 'openai/gpt-4o-mini'
  it('SCOR-05: score() returns modelUsed = "openai/gpt-4o-mini"', async () => {
    mockGenerateObject.mockResolvedValueOnce({ object: validScoreObject } as any);

    const service = makeService();
    const result = await service.score(mockScoringInput());

    expect(result.modelUsed).toBe('openai/gpt-4o-mini');
  });

  // SCOR-03 shape: result passes ScoreSchema validation
  it('SCOR-03: score result satisfies ScoreSchema', async () => {
    mockGenerateObject.mockResolvedValueOnce({ object: validScoreObject } as any);

    const service = makeService();
    const result = await service.score(mockScoringInput());

    expect(() => ScoreSchema.parse(result)).not.toThrow();
    expect(result.score).toBe(85);
  });

  // Error propagation: generateObject() failure throws (not swallowed)
  it('throws when generateObject() rejects', async () => {
    mockGenerateObject.mockRejectedValueOnce(new Error('OpenRouter rate limit'));

    const service = makeService();
    await expect(service.score(mockScoringInput())).rejects.toThrow('OpenRouter rate limit');
  });
});

describe('ScoreSchema - float coercion', () => {
  it('should coerce 85.5 to 86', () => {
    const result = ScoreSchema.parse({ score: 85.5, reasoning: 'ok', strengths: [], gaps: [] });
    expect(result.score).toBe(86);
  });

  it('should reject score > 100', () => {
    expect(() => ScoreSchema.parse({ score: 150, reasoning: 'ok', strengths: [], gaps: [] })).toThrow();
  });

  it('should accept integer score unchanged', () => {
    const result = ScoreSchema.parse({ score: 85, reasoning: 'ok', strengths: [], gaps: [] });
    expect(result.score).toBe(85);
  });
});

describe('ScoringAgentService - context limits', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should not throw on 50K char cvText (truncated internally)', async () => {
    mockGenerateObject.mockResolvedValueOnce({ object: validScoreObject } as any);
    const input: ScoringInput = {
      cvText: 'a'.repeat(50_000),
      candidateFields: { currentRole: 'Dev', yearsExperience: 5, skills: ['ts'] },
      job: { title: 'Engineer', description: 'b'.repeat(50_000), requirements: [] },
    };
    const service = makeService();
    await expect(service.score(input)).resolves.toBeDefined();
  });

  it('should propagate errors from generateObject', async () => {
    mockGenerateObject.mockRejectedValueOnce(new Error('API error'));
    const service = makeService();
    await expect(service.score(mockScoringInput())).rejects.toThrow('API error');
  });
});
