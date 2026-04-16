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

  // CandidateExtractSchema: all 10 fields (no suspicious) parse correctly
  it('CandidateExtractSchema parses full object with all 10 fields without throwing', () => {
    expect(() =>
      CandidateExtractSchema.parse({
        full_name: 'X',
        email: null,
        phone: null,
        current_role: null,
        years_experience: null,
        location: null,
        skills: [],
        ai_summary: null,
        source_hint: null,
        source_agency: null,
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
      skills: [],
      ai_summary: null,
      source_hint: null,
      source_agency: null,
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
      skills: [],
      ai_summary: null,
      source_hint: 'linkedin',
      source_agency: null,
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
        skills: [],
        ai_summary: null,
        source_hint: 'invalid',
        source_agency: null,
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
      skills: [],
      ai_summary: null,
      source_hint: null,
      source_agency: null,
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
      skills: [],
      ai_summary: null,
      source_hint: null,
      source_agency: null,
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
      skills: ['Strategy', 'Roadmapping'],
      ai_summary: 'PM with 5 years experience. Skilled in roadmapping and stakeholder management.',
      source_hint: 'direct',
      source_agency: null,
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
      skills: [],
      ai_summary: null,
      source_hint: null,
      source_agency: null,
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
      skills: ['Python'],
      ai_summary: 'Data scientist. Specialises in ML pipelines.',
      source_hint: null,
      source_agency: null,
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
      skills: ['TypeScript'],
      ai_summary: 'Backend developer. Strong in TypeScript.',
      source_hint: 'direct',
      source_agency: null,
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
        model: 'openai/gpt-4o-mini',
        input: expect.stringContaining('From: dana@example.com'),
      }),
    );
  });

  // extractDeterministically() skips injected headers (Phase 14 fix)
  it('extractDeterministically() skips injected headers to find correctly formatted name', () => {
    const service = makeService();
    const input = [
      '--- Email Metadata ---',
      'Subject: CV for Developer Role',
      'From: sender@example.com',
      '',
      '--- Email Body ---',
      'John Smith',
      'john@example.com',
      'I am a TypeScript developer',
    ].join('\n');

    const result = service.extractDeterministically(input);

    expect(result.full_name).toBe('John Smith');
    expect(result.email).toBe('john@example.com');
  });

  // extractDeterministically() is PUBLIC and returns all new fields as null
  it('extractDeterministically() is public and returns current_role, years_experience, location, source_hint, source_agency as null', () => {
    const service = makeService();
    const result = service.extractDeterministically('John Smith\njohn@example.com\nTypeScript developer');

    expect(result).toHaveProperty('current_role', null);
    expect(result).toHaveProperty('years_experience', null);
    expect(result).toHaveProperty('location', null);
    expect(result).toHaveProperty('source_hint', null);
    expect(result).toHaveProperty('source_agency', null);
    expect(result).toHaveProperty('full_name');
    expect(result).toHaveProperty('skills');
  });
});

describe('CandidateExtractSchema - float coercion', () => {
  const validBase = {
    full_name: 'Test User',
    email: null,
    phone: null,
    current_role: null,
    location: null,
    skills: [],
    ai_summary: null,
    source_hint: null,
    source_agency: null,
  };

  it('should coerce years_experience 6.7 to 7', () => {
    const result = CandidateExtractSchema.parse({ ...validBase, years_experience: 6.7 });
    expect(result.years_experience).toBe(7);
  });

  it('should accept years_experience null', () => {
    const result = CandidateExtractSchema.parse({ ...validBase, years_experience: null });
    expect(result.years_experience).toBeNull();
  });

  it('should reject years_experience > 50', () => {
    expect(() => CandidateExtractSchema.parse({ ...validBase, years_experience: 75 })).toThrow();
  });

  it('should coerce stringified years_experience "6" to integer 6', () => {
    const result = CandidateExtractSchema.parse({ ...validBase, years_experience: '6' });
    expect(result.years_experience).toBe(6);
  });
});

describe('ExtractionAgentService - context limits', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCallModel.mockReturnValue({ getText: mockGetText });
  });

  it('should not throw on 100K char fullText (truncated internally)', async () => {
    const aiResult = {
      full_name: 'Test User', email: null, phone: null, current_role: null,
      years_experience: null, location: null, skills: [], ai_summary: null,
      source_hint: null, source_agency: null,
    };
    mockGetText.mockResolvedValueOnce(JSON.stringify(aiResult));
    const service = makeService();
    const longText = 'a'.repeat(100_000);
    await expect(service.extract(longText, false, { subject: 'Test', fromEmail: 'a@b.com' })).resolves.toBeDefined();
  });

  it('should throw EXTRACTION_CONTEXT_EXCEEDED on HTTP 400 error', async () => {
    mockGetText.mockRejectedValueOnce(new Error('Request failed with status 400'));
    const service = makeService();
    await expect(service.extract('text', false, { subject: 'Test', fromEmail: 'a@b.com' })).rejects.toThrow('EXTRACTION_CONTEXT_EXCEEDED');
  });

  it('should throw EXTRACTION_CONTEXT_EXCEEDED on HTTP 413 error', async () => {
    mockGetText.mockRejectedValueOnce(new Error('413 Payload Too Large'));
    const service = makeService();
    await expect(service.extract('text', false, { subject: 'Test', fromEmail: 'a@b.com' })).rejects.toThrow('EXTRACTION_CONTEXT_EXCEEDED');
  });
});

describe('extractDeterministically() - name detection', () => {
  let service: ExtractionAgentService;

  beforeEach(() => {
    const configService = { get: jest.fn().mockReturnValue('fake-key') } as unknown as ConfigService;
    service = new ExtractionAgentService(configService);
  });

  it('should skip CONFIDENTIAL header and find name', () => {
    const result = service.extractDeterministically('CONFIDENTIAL\nJohn Doe\nSenior Engineer\njohn@test.com');
    expect(result.full_name).toBe('John Doe');
  });

  it('should skip date line and find name', () => {
    const result = service.extractDeterministically('01/15/2024\nJane Smith\nEngineer');
    expect(result.full_name).toBe('Jane Smith');
  });

  it('should detect Hebrew name', () => {
    const result = service.extractDeterministically('אבי לוי\nמהנדס תוכנה\navi@test.com');
    expect(result.full_name).toBe('אבי לוי');
  });

  it('should detect Arabic name', () => {
    const result = service.extractDeterministically('محمد علي\nمهندس برمجيات');
    expect(result.full_name).toBe('محمد علي');
  });

  it('should handle hyphenated names', () => {
    const result = service.extractDeterministically('Jean-Pierre Dupont\nEngineer');
    expect(result.full_name).toBe('Jean-Pierre Dupont');
  });

  it('should reject single-word lines as names', () => {
    const result = service.extractDeterministically(
      'Summary\nThis document contains a very long professional description that spans many words.\n',
    );
    expect(result.full_name).toBe('Unknown Candidate');
  });

  it('should fallback to Unknown Candidate when no name found', () => {
    const result = service.extractDeterministically(
      'CONFIDENTIAL\nProfessional Summary\nThis is a long description of the candidate profile and experience.',
    );
    expect(result.full_name).toBe('Unknown Candidate');
  });

  it('should skip Curriculum Vitae header', () => {
    const result = service.extractDeterministically('Curriculum Vitae\nDavid Cohen\nSoftware Developer');
    expect(result.full_name).toBe('David Cohen');
  });

  it('should accept multi-part names (Maria de la Cruz)', () => {
    const result = service.extractDeterministically('Maria de la Cruz\nSenior Engineer');
    expect(result.full_name).toBe('Maria de la Cruz');
  });

  it('should accept Arabic multi-part name', () => {
    const result = service.extractDeterministically('عبد الرحمن الحسيني\nمهندس برمجيات');
    expect(result.full_name).toBe('عبد الرحمن الحسيني');
  });
});

describe('ExtractionAgentService - known agency domain resolution (Issue 3)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCallModel.mockReturnValue({ getText: mockGetText });
  });

  const agencyAiResult = {
    full_name: 'Avi Levi',
    email: 'avi@gmail.com',
    phone: '+972-52-0000000',
    current_role: 'Software Engineer',
    years_experience: 4,
    location: 'Tel Aviv, Israel',
    skills: ['node.js'],
    ai_summary: 'Software engineer. Strong Node.js background.',
    source_hint: 'agency',
    source_agency: 'Job Hunt', // AI returns non-canonical name
  };

  // jobhunt.co.il domain → canonical "jobhunt", overrides AI result
  it('overrides source_agency with canonical "jobhunt" for jobhunt.co.il sender', async () => {
    mockGetText.mockResolvedValueOnce(JSON.stringify(agencyAiResult));
    const service = makeService();
    const result = await service.extract('cv text', false, {
      subject: 'Presenting candidate',
      fromEmail: 'talent@jobhunt.co.il',
    });
    expect(result.source_agency).toBe('jobhunt');
    expect(result.source_hint).toBe('agency');
  });

  // alljob.co.il domain → canonical "AllJobs", overrides AI result
  it('overrides source_agency with canonical "AllJobs" for alljob.co.il sender', async () => {
    mockGetText.mockResolvedValueOnce(JSON.stringify({ ...agencyAiResult, source_agency: 'AllJobs' }));
    const service = makeService();
    const result = await service.extract('cv text', false, {
      subject: 'New candidate',
      fromEmail: 'alljobs@alljob.co.il',
    });
    expect(result.source_agency).toBe('AllJobs');
    expect(result.source_hint).toBe('agency');
  });

  // Unknown domain: AI result is preserved as-is
  it('preserves AI source_agency for unknown domain', async () => {
    mockGetText.mockResolvedValueOnce(JSON.stringify({ ...agencyAiResult, source_agency: 'Recruiters Inc' }));
    const service = makeService();
    const result = await service.extract('cv text', false, {
      subject: 'Candidate for your role',
      fromEmail: 'hr@someagency.com',
    });
    expect(result.source_agency).toBe('Recruiters Inc');
  });

  // Known domain injects "Resolved Agency Name" line into userMessage
  it('injects "Resolved Agency Name" into prompt for known domains', async () => {
    mockGetText.mockResolvedValueOnce(JSON.stringify(agencyAiResult));
    const service = makeService();
    await service.extract('cv text', false, {
      subject: 'Presenting candidate',
      fromEmail: 'talent@jobhunt.co.il',
    });
    expect(mockCallModel).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.stringContaining('Resolved Agency Name: jobhunt'),
      }),
    );
  });

  // Unknown domain: no "Resolved Agency Name" line in prompt
  it('does NOT inject "Resolved Agency Name" for unknown domain', async () => {
    mockGetText.mockResolvedValueOnce(JSON.stringify(agencyAiResult));
    const service = makeService();
    await service.extract('cv text', false, {
      subject: 'Candidate',
      fromEmail: 'hr@unknownagency.com',
    });
    expect(mockCallModel).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.not.stringContaining('Resolved Agency Name'),
      }),
    );
  });
});

describe('ExtractionAgentService - location prompt instruction (Issue 1)', () => {
  // Verify the INSTRUCTIONS string explicitly directs the AI to use HOME location signals
  // and not the employer's country — regression guard so the instruction is never accidentally removed.
  it('INSTRUCTIONS prompt contains home-location guidance and phone prefix example', () => {
    // Import the module to access the compiled constant indirectly via the callModel input
    const service = makeService();
    // The instructions are passed as `instructions` in callModel — verify via a mocked call
    mockGetText.mockResolvedValueOnce(JSON.stringify({
      full_name: 'Test', email: null, phone: null, current_role: null,
      years_experience: null, location: null, skills: [], ai_summary: null,
      source_hint: null, source_agency: null,
    }));
    return service.extract('cv', false, { subject: 'S', fromEmail: 'a@b.com' }).then(() => {
      const callArg = mockCallModel.mock.calls[0][0];
      expect(callArg.instructions).toContain('HOME location');
      expect(callArg.instructions).toContain('Phone country prefix');
      expect(callArg.instructions).toContain('employer');
    });
  });
});
