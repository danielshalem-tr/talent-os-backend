import { ExtractionAgentService, CandidateExtract, CandidateExtractSchema } from './extraction-agent.service';
import { mockCandidateExtract } from './extraction-agent.service.test-helpers';
import { ConfigService } from '@nestjs/config';
import { StorageService } from '../../storage/storage.service';
import { generateObject } from 'ai';

// Re-export for backward compatibility with other specs that import from here
export { mockCandidateExtract };

jest.mock('ai', () => ({
  generateObject: jest.fn(),
}));

jest.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: jest.fn().mockReturnValue({
    chat: jest.fn().mockReturnValue('mocked-model'),
  }),
}));

const mockGenerateObject = generateObject as jest.MockedFunction<typeof generateObject>;

function makeService(storageService?: Partial<{ loadExtractionCache: jest.Mock; saveExtractionCache: jest.Mock }>): ExtractionAgentService {
  const configService = {
    get: jest.fn().mockReturnValue('fake-openrouter-key'),
  } as unknown as ConfigService;
  const mockStorage = {
    loadExtractionCache: jest.fn().mockResolvedValue(null),
    saveExtractionCache: jest.fn().mockResolvedValue(undefined),
    ...(storageService ?? {}),
  } as unknown as StorageService;
  return new ExtractionAgentService(configService, mockStorage);
}

const DEFAULT_METADATA = {
  subject: 'Test Subject',
  fromEmail: 'test@example.com',
  tenantId: 'tenant-uuid',
  messageId: 'msg-uuid',
};

describe('ExtractionAgentService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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

  // When generateObject resolves, returns AI result merged with suspicious flag
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
      source_hint: 'direct' as const,
      source_agency: null,
    };

    mockGenerateObject.mockResolvedValueOnce({ object: aiResult } as any);

    const service = makeService();
    const result = await service.extract('some cv text', false, DEFAULT_METADATA);

    expect(result.full_name).toBe('Alice Smith');
    expect(result.email).toBe('alice@example.com');
    expect(result.suspicious).toBe(false);
  });

  // suspicious=true is propagated on success
  it('propagates suspicious=true from input on success', async () => {
    mockGenerateObject.mockResolvedValueOnce({ object: {
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
    } } as any);

    const service = makeService();
    const result = await service.extract('some text', true, DEFAULT_METADATA);
    expect(result.suspicious).toBe(true);
  });

  // extract() THROWS when callAI() throws — does NOT return fallback
  it('extract() throws when callAI() throws (no fallback swallowing)', async () => {
    mockGenerateObject.mockRejectedValueOnce(new Error('Network timeout'));

    const service = makeService();
    await expect(service.extract('some text', false, DEFAULT_METADATA)).rejects.toThrow('Network timeout');
  });

  // callAI() constructs prompt with Email Metadata section
  it('callAI() constructs prompt with "--- Email Metadata ---" section', async () => {
    const aiResult = {
      full_name: 'Dana Cohen',
      email: 'dana@example.com',
      phone: null,
      current_role: 'Backend Developer',
      years_experience: 6,
      location: 'Tel Aviv, Israel',
      skills: ['TypeScript'],
      ai_summary: 'Backend developer. Strong in TypeScript.',
      source_hint: 'direct' as const,
      source_agency: null,
    };
    mockGenerateObject.mockResolvedValueOnce({ object: aiResult } as any);

    const service = makeService();
    await service.extract('cv text here', false, { subject: 'My CV', fromEmail: 'dana@example.com', tenantId: 'tid', messageId: 'mid' });

    expect(mockGenerateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('--- Email Metadata ---'),
      }),
    );
    expect(mockGenerateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('Subject: My CV'),
      }),
    );
    expect(mockGenerateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'mocked-model',
        prompt: expect.stringContaining('From: dana@example.com'),
      }),
    );
  });

  // extract calls generateObject and returns structured result
  it('extract calls generateObject and returns structured result', async () => {
    const expectedResult = {
      full_name: 'Dana Cohen',
      email: 'dana@gmail.com',
      phone: '+972-52-1234567',
      current_role: 'Engineer',
      years_experience: 5,
      location: 'Tel Aviv, Israel',
      skills: ['node.js'],
      ai_summary: 'Senior engineer.',
      source_hint: 'direct' as const,
      source_agency: null,
    };
    mockGenerateObject.mockResolvedValueOnce({ object: expectedResult } as any);

    const service = makeService();
    const result = await service.extract('cv text', false, DEFAULT_METADATA);

    expect(result).toMatchObject({ ...expectedResult, suspicious: false });
    expect(mockGenerateObject).toHaveBeenCalledTimes(1);
  });

  // extract returns cached result from R2 without calling generateObject
  it('extract returns cached result from R2 without calling generateObject', async () => {
    const cached = {
      full_name: 'Cached Name',
      email: null, phone: null, current_role: null,
      years_experience: null, location: null, skills: [],
      ai_summary: null, source_hint: null, source_agency: null,
    };
    const mockStorage = {
      loadExtractionCache: jest.fn().mockResolvedValue(cached),
      saveExtractionCache: jest.fn(),
    };
    const service = makeService(mockStorage);

    const result = await service.extract('cv text', false, DEFAULT_METADATA);

    expect(result.full_name).toBe('Cached Name');
    expect(mockGenerateObject).not.toHaveBeenCalled();
  });

  // extract saves result to R2 cache after successful AI call
  it('extract saves result to R2 cache after successful AI call', async () => {
    const aiResult = {
      full_name: 'New Candidate',
      email: null, phone: null, current_role: null,
      years_experience: null, location: null, skills: [],
      ai_summary: null, source_hint: null, source_agency: null,
    };
    mockGenerateObject.mockResolvedValueOnce({ object: aiResult } as any);
    const mockStorage = {
      loadExtractionCache: jest.fn().mockResolvedValue(null),
      saveExtractionCache: jest.fn().mockResolvedValue(undefined),
    };
    const service = makeService(mockStorage);

    await service.extract('cv text', false, DEFAULT_METADATA);

    expect(mockStorage.saveExtractionCache).toHaveBeenCalledWith(
      expect.objectContaining({ full_name: 'New Candidate' }),
      'tenant-uuid',
      'msg-uuid',
    );
  });

  // extract re-throws when saveExtractionCache rejects — AI result discarded, BullMQ will retry
  it('extract re-throws when saveExtractionCache rejects — AI result discarded, BullMQ will retry', async () => {
    const aiResult = {
      full_name: 'New Candidate',
      email: null, phone: null, current_role: null,
      years_experience: null, location: null, skills: [],
      ai_summary: null, source_hint: null, source_agency: null,
    };
    mockGenerateObject.mockResolvedValueOnce({ object: aiResult } as any);
    const mockStorage = {
      loadExtractionCache: jest.fn().mockResolvedValue(null),
      saveExtractionCache: jest.fn().mockRejectedValue(new Error('R2 unavailable')),
    };
    const service = makeService(mockStorage);

    await expect(service.extract('cv text', false, DEFAULT_METADATA)).rejects.toThrow('R2 unavailable');
    expect(mockGenerateObject).toHaveBeenCalledTimes(1);
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
  });

  it('should not throw on 100K char fullText (truncated internally)', async () => {
    const aiResult = {
      full_name: 'Test User', email: null, phone: null, current_role: null,
      years_experience: null, location: null, skills: [], ai_summary: null,
      source_hint: null, source_agency: null,
    };
    mockGenerateObject.mockResolvedValueOnce({ object: aiResult } as any);
    const service = makeService();
    const longText = 'a'.repeat(100_000);
    await expect(service.extract(longText, false, { subject: 'Test', fromEmail: 'a@b.com', tenantId: 'tid', messageId: 'mid' })).resolves.toBeDefined();
  });
});

describe('ExtractionAgentService - known agency domain resolution (Issue 3)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
    source_hint: 'agency' as const,
    source_agency: 'Job Hunt', // AI returns non-canonical name
  };

  // jobhunt.co.il domain → canonical "jobhunt", overrides AI result
  it('overrides source_agency with canonical "jobhunt" for jobhunt.co.il sender', async () => {
    mockGenerateObject.mockResolvedValueOnce({ object: agencyAiResult } as any);
    const service = makeService();
    const result = await service.extract('cv text', false, {
      subject: 'Presenting candidate',
      fromEmail: 'talent@jobhunt.co.il',
      tenantId: 'tid',
      messageId: 'mid',
    });
    expect(result.source_agency).toBe('jobhunt');
    expect(result.source_hint).toBe('agency');
  });

  // alljob.co.il domain → canonical "AllJobs", overrides AI result
  it('overrides source_agency with canonical "AllJobs" for alljob.co.il sender', async () => {
    mockGenerateObject.mockResolvedValueOnce({ object: { ...agencyAiResult, source_agency: 'AllJobs' } } as any);
    const service = makeService();
    const result = await service.extract('cv text', false, {
      subject: 'New candidate',
      fromEmail: 'alljobs@alljob.co.il',
      tenantId: 'tid',
      messageId: 'mid',
    });
    expect(result.source_agency).toBe('AllJobs');
    expect(result.source_hint).toBe('agency');
  });

  // Unknown domain: AI result is preserved as-is
  it('preserves AI source_agency for unknown domain', async () => {
    mockGenerateObject.mockResolvedValueOnce({ object: { ...agencyAiResult, source_agency: 'Recruiters Inc' } } as any);
    const service = makeService();
    const result = await service.extract('cv text', false, {
      subject: 'Candidate for your role',
      fromEmail: 'hr@someagency.com',
      tenantId: 'tid',
      messageId: 'mid',
    });
    expect(result.source_agency).toBe('Recruiters Inc');
  });

  // Known domain injects "Resolved Agency Name" line into prompt
  it('injects "Resolved Agency Name" into prompt for known domains', async () => {
    mockGenerateObject.mockResolvedValueOnce({ object: agencyAiResult } as any);
    const service = makeService();
    await service.extract('cv text', false, {
      subject: 'Presenting candidate',
      fromEmail: 'talent@jobhunt.co.il',
      tenantId: 'tid',
      messageId: 'mid',
    });
    expect(mockGenerateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('Resolved Agency Name: jobhunt'),
      }),
    );
  });

  // Unknown domain: no "Resolved Agency Name" line in prompt
  it('does NOT inject "Resolved Agency Name" for unknown domain', async () => {
    mockGenerateObject.mockResolvedValueOnce({ object: agencyAiResult } as any);
    const service = makeService();
    await service.extract('cv text', false, {
      subject: 'Candidate',
      fromEmail: 'hr@unknownagency.com',
      tenantId: 'tid',
      messageId: 'mid',
    });
    expect(mockGenerateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.not.stringContaining('Resolved Agency Name'),
      }),
    );
  });
});

describe('ExtractionAgentService - location prompt instruction (Issue 1)', () => {
  // Verify the INSTRUCTIONS string explicitly directs the AI to use HOME location signals
  // and not the employer's country — regression guard so the instruction is never accidentally removed.
  it('INSTRUCTIONS prompt contains home-location guidance and phone prefix example', async () => {
    mockGenerateObject.mockResolvedValueOnce({ object: {
      full_name: 'Test', email: null, phone: null, current_role: null,
      years_experience: null, location: null, skills: [], ai_summary: null,
      source_hint: null, source_agency: null,
    } } as any);
    const service = makeService();
    await service.extract('cv', false, { subject: 'S', fromEmail: 'a@b.com', tenantId: 'tid', messageId: 'mid' });
    const callArg = mockGenerateObject.mock.calls[0][0];
    expect(callArg.system).toContain('HOME location');
    expect(callArg.system).toContain('Phone country prefix');
    expect(callArg.system).toContain('employer');
  });
});
