import { ExtractionAgentService, CandidateExtract, CandidateExtractSchema } from './extraction-agent.service';
import { mockCandidateExtract } from './extraction-agent.service.test-helpers';
import { ConfigService } from '@nestjs/config';

// Re-export for backward compatibility with other specs that import from here
export { mockCandidateExtract };

// Mock @openrouter/sdk so tests don't hit real network
const mockGetText = jest.fn();
const mockCallModel = jest.fn().mockReturnValue({ getText: mockGetText });

jest.mock('@openrouter/sdk', () => ({
  OpenRouter: jest.fn().mockImplementation(() => ({
    callModel: mockCallModel,
  })),
}));

function makeService(): ExtractionAgentService {
  const configService = {
    get: jest.fn().mockReturnValue('fake-openrouter-key'),
  } as unknown as ConfigService;
  return new ExtractionAgentService(configService);
}

const DEFAULT_METADATA = { subject: 'Test Subject', fromEmail: 'test@example.com' };

describe('ExtractionAgentService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCallModel.mockReturnValue({ getText: mockGetText });
  });

  // CandidateExtractSchema: all 9 fields (no suspicious) parse correctly
  it('CandidateExtractSchema parses full object with all 9 fields without throwing', () => {
    expect(() =>
      CandidateExtractSchema.parse({
        full_name: 'X',
        email: null,
        phone: null,
        current_role: null,
        years_experience: null,
        location: null,
        job_title_hint: null,
        skills: [],
        ai_summary: null,
        source_hint: null,
      }),
    ).not.toThrow();
  });

  // years_experience must be an integer
  it('CandidateExtractSchema parses years_experience as integer', () => {
    const parsed = CandidateExtractSchema.parse({
      full_name: 'X',
      email: null,
      phone: null,
      current_role: null,
      years_experience: 6,
      location: null,
      job_title_hint: null,
      skills: [],
      ai_summary: null,
      source_hint: null,
    });
    expect(parsed.years_experience).toBe(6);
  });

  // source_hint enum validation: valid value passes
  it('CandidateExtractSchema parses source_hint "linkedin"', () => {
    const parsed = CandidateExtractSchema.parse({
      full_name: 'X',
      email: null,
      phone: null,
      current_role: null,
      years_experience: null,
      location: null,
      job_title_hint: null,
      skills: [],
      ai_summary: null,
      source_hint: 'linkedin',
    });
    expect(parsed.source_hint).toBe('linkedin');
  });

  // source_hint enum validation: invalid value throws
  it('CandidateExtractSchema throws for invalid source_hint value', () => {
    expect(() =>
      CandidateExtractSchema.parse({
        full_name: 'X',
        email: null,
        phone: null,
        current_role: null,
        years_experience: null,
        location: null,
        job_title_hint: null,
        skills: [],
        ai_summary: null,
        source_hint: 'invalid',
      }),
    ).toThrow();
  });

  // 4-01-02: AIEX-03 — optional fields can be null without schema errors
  it('optional fields can be null', () => {
    const partial = {
      full_name: 'John Smith',
      email: null,
      phone: null,
      current_role: null,
      years_experience: null,
      location: null,
      job_title_hint: null,
      skills: [],
      ai_summary: null,
      source_hint: null,
    };
    expect(() => CandidateExtractSchema.parse(partial)).not.toThrow();
  });

  // 4-01-05: AIEX-03 — skills defaults to empty array
  it('skills defaults to empty array', () => {
    const parsed = CandidateExtractSchema.parse({
      full_name: 'Test User',
      email: null,
      phone: null,
      current_role: null,
      years_experience: null,
      location: null,
      job_title_hint: null,
      skills: [],
      ai_summary: null,
      source_hint: null,
    });
    expect(parsed.skills).toEqual([]);
  });

  // When callModel resolves, returns AI result merged with suspicious flag
  it('returns AI result merged with suspicious flag on success', async () => {
    const aiResult = {
      full_name: 'Alice Smith',
      email: 'alice@example.com',
      phone: '+44-7700-900000',
      current_role: 'Product Manager',
      years_experience: 5,
      location: 'London, UK',
      job_title_hint: 'Senior Product Manager',
      skills: ['Strategy', 'Roadmapping'],
      ai_summary: 'PM with 5 years experience. Skilled in roadmapping and stakeholder management.',
      source_hint: 'direct',
    };

    mockGetText.mockResolvedValueOnce(JSON.stringify(aiResult));

    const service = makeService();
    const result = await service.extract('some cv text', false, DEFAULT_METADATA);

    expect(result.full_name).toBe('Alice Smith');
    expect(result.email).toBe('alice@example.com');
    expect(result.suspicious).toBe(false);
  });

  // suspicious=true is propagated on success
  it('propagates suspicious=true from input on success', async () => {
    mockGetText.mockResolvedValueOnce(JSON.stringify({
      full_name: 'Bob Jones',
      email: null,
      phone: null,
      current_role: null,
      years_experience: null,
      location: null,
      job_title_hint: null,
      skills: [],
      ai_summary: null,
      source_hint: null,
    }));

    const service = makeService();
    const result = await service.extract('some text', true, DEFAULT_METADATA);
    expect(result.suspicious).toBe(true);
  });

  // extract() THROWS when callAI() throws — does NOT return fallback
  it('extract() throws when callAI() throws (no fallback swallowing)', async () => {
    mockGetText.mockRejectedValueOnce(new Error('Network timeout'));

    const service = makeService();
    await expect(service.extract('some text', false, DEFAULT_METADATA)).rejects.toThrow('Network timeout');
  });

  // Strips markdown code fences if model wraps output
  it('strips markdown code fences from model response', async () => {
    const aiResult = {
      full_name: 'Carol White',
      email: 'carol@example.com',
      phone: null,
      current_role: 'Data Scientist',
      years_experience: 3,
      location: 'Berlin, Germany',
      job_title_hint: 'Data Scientist',
      skills: ['Python'],
      ai_summary: 'Data scientist. Specialises in ML pipelines.',
      source_hint: null,
    };

    mockGetText.mockResolvedValueOnce('```json\n' + JSON.stringify(aiResult) + '\n```');

    const service = makeService();
    const result = await service.extract('some cv text', false, DEFAULT_METADATA);
    expect(result.full_name).toBe('Carol White');
  });

  // callAI() uses safeParse and throws on schema validation failure
  it('callAI() throws when safeParse fails (invalid schema)', async () => {
    const invalidResult = {
      full_name: 'X',
      // missing many fields, source_hint invalid
      source_hint: 'not-valid-enum',
    };
    mockGetText.mockResolvedValueOnce(JSON.stringify(invalidResult));

    const service = makeService();
    await expect(service.extract('text', false, DEFAULT_METADATA)).rejects.toThrow(/validation failed/i);
  });

  // callAI() constructs userMessage with Email Metadata section
  it('callAI() constructs userMessage with "--- Email Metadata ---" section', async () => {
    const aiResult = {
      full_name: 'Dana Cohen',
      email: 'dana@example.com',
      phone: null,
      current_role: 'Backend Developer',
      years_experience: 6,
      location: 'Tel Aviv, Israel',
      job_title_hint: 'Senior Backend Developer',
      skills: ['TypeScript'],
      ai_summary: 'Backend developer. Strong in TypeScript.',
      source_hint: 'direct',
    };
    mockGetText.mockResolvedValueOnce(JSON.stringify(aiResult));

    const service = makeService();
    await service.extract('cv text here', false, { subject: 'My CV', fromEmail: 'dana@example.com' });

    expect(mockCallModel).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.stringContaining('--- Email Metadata ---'),
      }),
    );
    expect(mockCallModel).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.stringContaining('Subject: My CV'),
      }),
    );
    expect(mockCallModel).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.stringContaining('From: dana@example.com'),
      }),
    );
  });

  // extractDeterministically() is PUBLIC and returns all new fields as null
  it('extractDeterministically() is public and returns current_role, years_experience, location, source_hint as null', () => {
    const service = makeService();
    const result = service.extractDeterministically('John Smith\njohn@example.com\nTypeScript developer');

    expect(result).toHaveProperty('current_role', null);
    expect(result).toHaveProperty('years_experience', null);
    expect(result).toHaveProperty('location', null);
    expect(result).toHaveProperty('source_hint', null);
    expect(result).toHaveProperty('job_title_hint', null);
    expect(result).toHaveProperty('full_name');
    expect(result).toHaveProperty('skills');
  });
});
