import { buildScoringUserPrompt, EvaluationSchema, MAX_CV_LENGTH, SCORING_SYSTEM_PROMPT } from './scoring-prompt';
import { ScoringInput } from './scoring.service';

const input = (over: Partial<ScoringInput['job']> = {}): ScoringInput => ({
  cvText: 'CV BODY',
  candidateFields: { currentRole: 'Dev', yearsExperience: 3, skills: ['react', 'node.js'] },
  job: {
    title: 'Full Stack Developer',
    description: 'Build platforms.',
    roleSummary: 'Own features end to end.',
    responsibilities: 'Ship weekly.',
    mustHaveSkills: ['React+Node.js', "Bachelor's Degree"],
    niceToHaveSkills: ['GraphQL'],
    expYearsMin: 1,
    expYearsMax: 5,
    preferredOrgTypes: ['startup'],
    screeningQuestions: ['Used Claude Code?'],
    ...over,
  },
});

describe('buildScoringUserPrompt', () => {
  it('includes every job field, numbered must-haves and nice-to-haves', () => {
    const p = buildScoringUserPrompt(input());
    expect(p).toContain('Title: Full Stack Developer');
    expect(p).toContain('Role summary: Own features end to end.');
    expect(p).toContain('Responsibilities: Ship weekly.');
    expect(p).toContain('M1. React+Node.js');
    expect(p).toContain("M2. Bachelor's Degree");
    expect(p).toContain('N1. GraphQL');
    expect(p).toContain('Experience range: 1-5 years');
    expect(p).toContain('Preferred background: startup');
    expect(p).toContain('Used Claude Code?');
    expect(p).toContain('CV BODY');
  });

  it('marks extracted fields as unverified hints', () => {
    expect(buildScoringUserPrompt(input())).toMatch(/auto-extracted.*may be wrong/i);
  });

  it('renders "none" for empty lists and "not specified" for a missing range', () => {
    const p = buildScoringUserPrompt(
      input({ niceToHaveSkills: [], expYearsMin: null, expYearsMax: null, screeningQuestions: [] }),
    );
    expect(p).toContain('Nice-to-have requirements: none');
    expect(p).toContain('Experience range: not specified');
  });

  it('truncates the CV to MAX_CV_LENGTH', () => {
    const long = 'x'.repeat(MAX_CV_LENGTH + 500);
    const p = buildScoringUserPrompt({ ...input(), cvText: long });
    expect(p).not.toContain('x'.repeat(MAX_CV_LENGTH + 1));
  });
});

describe('SCORING_SYSTEM_PROMPT', () => {
  it('states the compound, equivalent-tool, credential and evidence rules', () => {
    expect(SCORING_SYSTEM_PROMPT).toMatch(/A\+B/);
    expect(SCORING_SYSTEM_PROMPT).toMatch(/equivalent/i);
    expect(SCORING_SYSTEM_PROMPT).toMatch(/credential/i);
    expect(SCORING_SYSTEM_PROMPT).toMatch(/quote/i);
    expect(SCORING_SYSTEM_PROMPT).not.toMatch(/score the candidate 0-100/i);
  });
});

describe('EvaluationSchema', () => {
  it('accepts a full evaluation', () => {
    const parsed = EvaluationSchema.parse({
      must_haves: [
        {
          requirement: 'React',
          kind: 'skill',
          status: 'met',
          evidence: 'React at Acme',
          evidence_strength: 'demonstrated',
          exact_match: false,
        },
      ],
      nice_to_haves: [],
      relevant_years: 3,
      role_relevance: 88,
      cv_informative: true,
      reasoning: 'ok',
      strengths: ['a'],
      gaps: [],
    });
    expect(parsed.must_haves[0].status).toBe('met');
  });

  it('rejects unknown status values and out-of-range relevance', () => {
    expect(() =>
      EvaluationSchema.parse({
        must_haves: [],
        nice_to_haves: [],
        relevant_years: null,
        role_relevance: 140,
        cv_informative: true,
        reasoning: '',
        strengths: [],
        gaps: [],
      }),
    ).toThrow();
  });
});
