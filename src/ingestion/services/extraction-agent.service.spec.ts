import { ExtractionAgentService, CandidateExtract, CandidateExtractSchema } from './extraction-agent.service';

export function mockCandidateExtract(
  overrides: Partial<CandidateExtract> = {},
): CandidateExtract {
  return {
    fullName: 'Jane Doe',
    email: 'jane.doe@example.com',
    phone: '+1-555-0100',
    currentRole: 'Senior Software Engineer',
    yearsExperience: 7,
    skills: ['TypeScript', 'Node.js', 'PostgreSQL'],
    summary: 'Experienced engineer with 7 years building TypeScript backends. Strong in distributed systems and database design.',
    source: 'direct',
    suspicious: false,
    ...overrides,
  };
}

describe('ExtractionAgentService', () => {
  let service: ExtractionAgentService;

  beforeEach(() => {
    service = new ExtractionAgentService();
  });

  // 4-01-01: AIEX-02 — mock returns all required fields including fullName
  it('mock extract returns all CandidateExtract fields', async () => {
    const result = await service.extract('some email text', false);
    expect(result.fullName).toBe('Jane Doe');
    expect(result.email).toBe('jane.doe@example.com');
    expect(Array.isArray(result.skills)).toBe(true);
    expect(result.source).toBeDefined();
    expect(typeof result.suspicious).toBe('boolean');
  });

  // 4-01-02: AIEX-03 — optional fields can be null without schema errors
  it('optional fields can be null', () => {
    const partial: CandidateExtract = {
      fullName: 'John Smith',
      email: null,
      phone: null,
      currentRole: null,
      yearsExperience: null,
      skills: [],
      summary: null,
      source: 'direct',
      suspicious: false,
    };
    // CandidateExtractSchema validates the non-suspicious fields — should not throw
    expect(() =>
      CandidateExtractSchema.parse({ ...partial }),
    ).not.toThrow();
  });

  // 4-01-03: AIEX-01 — suspicious flag passed through as metadata (D-01)
  it('suspicious flag passed through as metadata', async () => {
    const result = await service.extract('some text', true);
    expect(result.suspicious).toBe(true);

    const result2 = await service.extract('some text', false);
    expect(result2.suspicious).toBe(false);
  });

  // 4-01-04: AIEX-02 — source enum defaults to direct
  it('source defaults to direct', async () => {
    const result = await service.extract('some email text', false);
    expect(result.source).toBe('direct');
  });

  // 4-01-05: AIEX-03 — skills defaults to empty array
  it('skills defaults to empty array', () => {
    const parsed = CandidateExtractSchema.parse({
      fullName: 'Test User',
      email: null,
      phone: null,
      currentRole: null,
      yearsExperience: null,
      skills: [],
      summary: null,
    });
    expect(parsed.skills).toEqual([]);
    expect(parsed.source).toBe('direct'); // default applies
  });
});
