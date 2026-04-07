import { ConfigService } from '@nestjs/config';
import { ScoringAgentService, ScoreSchema, ScoringInput } from './scoring.service';

// Mock @openrouter/sdk so tests don't hit real network
const mockGetText = jest.fn();
const mockCallModel = jest.fn().mockReturnValue({ getText: mockGetText });

jest.mock('@openrouter/sdk', () => ({
  OpenRouter: jest.fn().mockImplementation(() => ({
    callModel: mockCallModel,
  })),
}));

function makeService(): ScoringAgentService {
  const configService = {
    get: jest.fn().mockReturnValue('fake-openrouter-key'),
  } as unknown as ConfigService;
  return new ScoringAgentService(configService);
}

const validScoreResponse = JSON.stringify({
  score: 85,
  reasoning: 'Strong match. Candidate has relevant TypeScript experience.',
  strengths: ['TypeScript expertise', '6+ years experience'],
  gaps: ['No PostgreSQL mentioned'],
});

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
    mockCallModel.mockReturnValue({ getText: mockGetText });
  });

  // SCOR-03: score() calls OpenRouter with correct model
  it('SCOR-03: score() calls callModel with openai/gpt-4o-mini model', async () => {
    mockGetText.mockResolvedValueOnce(validScoreResponse);

    const service = makeService();
    await service.score(mockScoringInput());

    expect(mockCallModel).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'openai/gpt-4o-mini' }),
    );
  });

  // ConfigService used to get API key
  it('reads OPENROUTER_API_KEY from ConfigService', async () => {
    mockGetText.mockResolvedValueOnce(validScoreResponse);

    const configService = { get: jest.fn().mockReturnValue('test-key') } as unknown as ConfigService;
    const service = new ScoringAgentService(configService);
    await service.score(mockScoringInput());

    expect(configService.get).toHaveBeenCalledWith('OPENROUTER_API_KEY');
  });

  // SCOR-05: modelUsed is set to 'openai/gpt-4o-mini'
  it('SCOR-05: score() returns modelUsed = "openai/gpt-4o-mini"', async () => {
    mockGetText.mockResolvedValueOnce(validScoreResponse);

    const service = makeService();
    const result = await service.score(mockScoringInput());

    expect(result.modelUsed).toBe('openai/gpt-4o-mini');
  });

  // SCOR-03 shape: result passes ScoreSchema validation
  it('SCOR-03: score result satisfies ScoreSchema', async () => {
    mockGetText.mockResolvedValueOnce(validScoreResponse);

    const service = makeService();
    const result = await service.score(mockScoringInput());

    expect(() => ScoreSchema.parse(result)).not.toThrow();
    expect(result.score).toBe(85);
  });

  // Error propagation: getText() failure throws (not swallowed)
  it('throws when callModel().getText() rejects', async () => {
    mockGetText.mockRejectedValueOnce(new Error('OpenRouter rate limit'));

    const service = makeService();
    await expect(service.score(mockScoringInput())).rejects.toThrow('OpenRouter rate limit');
  });

  // Schema validation failure: LLM returns bad JSON → throws
  it('throws when LLM output fails ScoreSchema validation', async () => {
    // score field is string instead of integer
    mockGetText.mockResolvedValueOnce(JSON.stringify({ score: 'high', reasoning: 'ok', strengths: [], gaps: [] }));

    const service = makeService();
    await expect(service.score(mockScoringInput())).rejects.toThrow('Scoring output validation failed');
  });

  // Strips markdown code fences like extraction service does
  it('strips markdown code fences from model response', async () => {
    mockGetText.mockResolvedValueOnce('```json\n' + validScoreResponse + '\n```');

    const service = makeService();
    const result = await service.score(mockScoringInput());
    expect(result.score).toBe(85);
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
    mockCallModel.mockReturnValue({ getText: mockGetText });
  });

  it('should not throw on 50K char cvText (truncated internally)', async () => {
    mockGetText.mockResolvedValueOnce(validScoreResponse);
    const input: ScoringInput = {
      cvText: 'a'.repeat(50_000),
      candidateFields: { currentRole: 'Dev', yearsExperience: 5, skills: ['ts'] },
      job: { title: 'Engineer', description: 'b'.repeat(50_000), requirements: [] },
    };
    const service = makeService();
    await expect(service.score(input)).resolves.toBeDefined();
  });

  it('should throw SCORING_CONTEXT_EXCEEDED on HTTP 400 error', async () => {
    mockGetText.mockRejectedValueOnce(new Error('Request failed with status 400'));
    const service = makeService();
    await expect(service.score(mockScoringInput())).rejects.toThrow('SCORING_CONTEXT_EXCEEDED');
  });

  it('should throw SCORING_CONTEXT_EXCEEDED on HTTP 413 error', async () => {
    mockGetText.mockRejectedValueOnce(new Error('413 Payload Too Large'));
    const service = makeService();
    await expect(service.score(mockScoringInput())).rejects.toThrow('SCORING_CONTEXT_EXCEEDED');
  });
});
