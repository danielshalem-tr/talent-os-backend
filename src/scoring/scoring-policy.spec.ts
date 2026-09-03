import { computeScore, ScoringEvaluation, RequirementEvaluation } from './scoring-policy';

const req = (over: Partial<RequirementEvaluation> = {}): RequirementEvaluation => ({
  requirement: 'React',
  kind: 'skill',
  status: 'met',
  evidence: 'Built React apps at Acme (2021-2024)',
  evidence_strength: 'demonstrated',
  exact_match: false,
  ...over,
});

const ev = (over: Partial<ScoringEvaluation> = {}): ScoringEvaluation => ({
  must_haves: [req(), req({ requirement: 'Node.js' }), req({ requirement: 'TypeScript' })],
  nice_to_haves: [],
  relevant_years: 3,
  role_relevance: 90,
  cv_informative: true,
  reasoning: 'r',
  strengths: ['s'],
  gaps: [],
  ...over,
});

const range = { expYearsMin: 1, expYearsMax: 5 };

describe('computeScore', () => {
  it('all must-haves met, in range → high score, no caps', () => {
    const { score, breakdown } = computeScore(ev(), range);
    expect(score).toBeGreaterThanOrEqual(85);
    expect(breakdown.caps_applied).toEqual([]);
    expect(breakdown.must_have_coverage).toBe(1);
    expect(breakdown.experience_fit).toBe('in_range');
  });

  it('one core must-have missing caps at 60', () => {
    const { score, breakdown } = computeScore(
      ev({ must_haves: [req({ status: 'missing', evidence_strength: 'none' }), req(), req()] }),
      range,
    );
    expect(score).toBeLessThanOrEqual(60);
    expect(breakdown.caps_applied).toContainEqual({ label: 'core_must_have_missing', cap: 60 });
  });

  it('two or more core must-haves missing caps at 45', () => {
    const { score, breakdown } = computeScore(
      ev({ must_haves: [req({ status: 'missing' }), req({ status: 'missing' }), req()] }),
      range,
    );
    expect(score).toBeLessThanOrEqual(45);
    expect(breakdown.caps_applied).toContainEqual({ label: 'multiple_core_must_haves_missing', cap: 45 });
  });

  it('one partial core must-have (none missing) caps at 88; two or more at 78', () => {
    const one = computeScore(ev({ must_haves: [req({ status: 'partial' }), req(), req()] }), range);
    expect(one.score).toBeLessThanOrEqual(88);
    expect(one.breakdown.caps_applied).toContainEqual({ label: 'core_must_have_partial', cap: 88 });
    const two = computeScore(
      ev({ must_haves: [req({ status: 'partial' }), req({ status: 'partial' }), req()] }),
      range,
    );
    expect(two.score).toBeLessThanOrEqual(78);
    expect(two.breakdown.caps_applied).toContainEqual({ label: 'multiple_core_must_haves_partial', cap: 78 });
  });

  it('claimed discount applies to met only — a claimed partial stays 0.5', () => {
    const { breakdown } = computeScore(
      ev({ must_haves: [req({ status: 'partial', evidence_strength: 'claimed' }), req(), req()] }),
      range,
    );
    expect(breakdown.must_have_coverage).toBeCloseTo((0.5 + 1 + 1) / 3, 2);
  });

  it('exact_match is normalized to false for non-tool kinds', () => {
    const { breakdown } = computeScore(ev({ must_haves: [req({ exact_match: true }), req(), req()] }), range);
    expect(breakdown.must_haves[0].exact_match).toBe(false);
    expect(breakdown.adjustments).toEqual([]);
  });

  it('claimed-only evidence counts 0.75 of a met requirement', () => {
    const { breakdown } = computeScore(
      ev({ must_haves: [req({ evidence_strength: 'claimed' }), req(), req()] }),
      range,
    );
    expect(breakdown.must_have_coverage).toBeCloseTo((0.75 + 1 + 1) / 3, 2);
  });

  it('missing credential is a -5 adjustment, never a cap, and is excluded from coverage', () => {
    const { breakdown } = computeScore(
      ev({
        must_haves: [req({ requirement: "Bachelor's Degree", kind: 'credential', status: 'missing' }), req(), req()],
      }),
      range,
    );
    expect(breakdown.must_have_coverage).toBe(1);
    expect(breakdown.adjustments).toContainEqual({ label: 'credential_missing', delta: -5 });
    expect(breakdown.caps_applied).toEqual([]);
  });

  it('credential deductions total at most -10', () => {
    const creds = ['A', 'B', 'C'].map((r) => req({ requirement: r, kind: 'credential', status: 'missing' }));
    const { breakdown } = computeScore(ev({ must_haves: [...creds, req()] }), range);
    const total = breakdown.adjustments
      .filter((a) => a.label === 'credential_missing')
      .reduce((s, a) => s + a.delta, 0);
    expect(total).toBe(-10);
  });

  it('exact-match tool bonus is +3 each, max +5', () => {
    const tools = [
      req({ requirement: 'Claude Code', kind: 'tool', exact_match: true }),
      req({ requirement: 'Cursor', kind: 'tool', exact_match: true }),
    ];
    const { breakdown } = computeScore(ev({ must_haves: [...tools, req({ status: 'partial' })] }), range);
    const total = breakdown.adjustments.filter((a) => a.label === 'exact_tool_match').reduce((s, a) => s + a.delta, 0);
    expect(total).toBe(5);
  });

  it('equivalent tool (met, not exact) gets no bonus', () => {
    const { breakdown } = computeScore(
      ev({ must_haves: [req({ requirement: 'Claude Code', kind: 'tool', exact_match: false }), req(), req()] }),
      range,
    );
    expect(breakdown.adjustments.find((a) => a.label === 'exact_tool_match')).toBeUndefined();
  });

  it('zero experience against a minimum: factor 0.6, cap 45, flag', () => {
    const { score, breakdown } = computeScore(ev({ relevant_years: 0 }), range);
    expect(breakdown.experience_fit).toBe('below_min');
    expect(breakdown.experience_factor).toBeCloseTo(0.6, 5);
    expect(breakdown.flags).toContain('below_min_experience');
    expect(breakdown.caps_applied).toContainEqual({ label: 'below_min_experience', cap: 45 });
    expect(score).toBeLessThanOrEqual(45);
  });

  it('slightly below the minimum is continuous with in-range: no cap, factor between 0.6 and 0.8', () => {
    const { breakdown } = computeScore(ev({ relevant_years: 0.75 }), range);
    expect(breakdown.experience_fit).toBe('below_min');
    expect(breakdown.experience_factor).toBeCloseTo(0.75, 5);
    expect(breakdown.flags).toContain('below_min_experience');
    expect(breakdown.caps_applied.map((c) => c.label)).not.toContain('below_min_experience');
  });

  it('above maximum experience: light penalty down to 0.92 + over_qualified flag, no cap', () => {
    const { breakdown } = computeScore(ev({ relevant_years: 15 }), range);
    expect(breakdown.experience_fit).toBe('above_max');
    expect(breakdown.experience_factor).toBeCloseTo(0.92, 3);
    expect(breakdown.flags).toContain('over_qualified');
    expect(breakdown.caps_applied).toEqual([]);
  });

  it('in range scales 0.8 at min to 1.0 at max', () => {
    expect(computeScore(ev({ relevant_years: 1 }), range).breakdown.experience_factor).toBeCloseTo(0.8, 5);
    expect(computeScore(ev({ relevant_years: 3 }), range).breakdown.experience_factor).toBeCloseTo(0.9, 5);
    expect(computeScore(ev({ relevant_years: 5 }), range).breakdown.experience_factor).toBeCloseTo(1.0, 5);
  });

  it('no range on the job → factor 1.0, fit no_range', () => {
    const { breakdown } = computeScore(ev({ relevant_years: 12 }), { expYearsMin: null, expYearsMax: null });
    expect(breakdown.experience_fit).toBe('no_range');
    expect(breakdown.experience_factor).toBe(1);
  });

  it('unknown years → factor 0.85 and a flag', () => {
    const { breakdown } = computeScore(ev({ relevant_years: null }), range);
    expect(breakdown.experience_fit).toBe('unknown');
    expect(breakdown.experience_factor).toBe(0.85);
    expect(breakdown.flags).toContain('experience_unknown');
  });

  it('low role relevance caps at 30 (a PM applying to a dev role)', () => {
    const { score, breakdown } = computeScore(
      ev({
        role_relevance: 10,
        must_haves: [req({ status: 'missing' }), req({ status: 'missing' }), req({ status: 'missing' })],
      }),
      range,
    );
    expect(score).toBeLessThanOrEqual(30);
    expect(breakdown.caps_applied).toContainEqual({ label: 'low_role_relevance', cap: 30 });
  });

  it('uninformative CV caps at 50', () => {
    const { score, breakdown } = computeScore(ev({ cv_informative: false }), range);
    expect(score).toBeLessThanOrEqual(50);
    expect(breakdown.caps_applied).toContainEqual({ label: 'cv_uninformative', cap: 50 });
  });

  it('nice-to-haves present shift the weights (0.55 / 0.15 / 0.30)', () => {
    const withNice = computeScore(ev({ nice_to_haves: [req({ requirement: 'GraphQL', status: 'missing' })] }), range);
    const without = computeScore(ev(), range);
    expect(withNice.breakdown.nice_to_have_coverage).toBe(0);
    expect(without.breakdown.nice_to_have_coverage).toBeNull();
    expect(withNice.score).toBeLessThan(without.score);
  });

  it('no core must-haves at all → coverage falls back to role relevance', () => {
    const { breakdown } = computeScore(ev({ must_haves: [], role_relevance: 70 }), range);
    expect(breakdown.must_have_coverage).toBeCloseTo(0.7, 5);
  });

  it('result is an integer in 0..100 and is deterministic', () => {
    const a = computeScore(ev(), range);
    const b = computeScore(ev(), range);
    expect(a.score).toBe(b.score);
    expect(Number.isInteger(a.score)).toBe(true);
    expect(a.score).toBeGreaterThanOrEqual(0);
    expect(a.score).toBeLessThanOrEqual(100);
  });
});

describe('experience-kind must-haves', () => {
  it('are excluded from coverage and caps — the experience factor already prices years', () => {
    const withExp = ev({
      must_haves: [
        req(),
        req({ requirement: 'Node.js' }),
        req({
          requirement: '5+ years as a developer',
          kind: 'experience',
          status: 'missing',
          evidence_strength: 'none',
        }),
      ],
      relevant_years: 3,
    });
    const without = ev({ must_haves: [req(), req({ requirement: 'Node.js' })], relevant_years: 3 });
    const a = computeScore(withExp, range);
    const b = computeScore(without, range);
    expect(a.score).toBe(b.score);
    expect(a.breakdown.caps_applied).toEqual([]);
    expect(a.breakdown.must_haves).toHaveLength(3);
  });
});

describe('experience factor is continuous for every job range shape', () => {
  const f = (years: number, job: { expYearsMin: number | null; expYearsMax: number | null }) =>
    computeScore(ev({ relevant_years: years }), job).breakdown.experience_factor;

  it('min only: full credit at/above min, no cliff just below it', () => {
    const job = { expYearsMin: 3, expYearsMax: null };
    expect(f(3, job)).toBe(1);
    expect(f(10, job)).toBe(1);
    expect(f(2.9, job)).toBeGreaterThan(0.98);
    expect(f(0, job)).toBeCloseTo(0.6, 3);
  });

  it('max only: full credit up to max, light continuous penalty above it', () => {
    const job = { expYearsMin: null, expYearsMax: 5 };
    expect(f(1, job)).toBe(1);
    expect(f(5, job)).toBe(1);
    expect(f(5.5, job)).toBeGreaterThan(0.99);
    expect(f(10, job)).toBeCloseTo(0.92, 3);
    expect(f(30, job)).toBeCloseTo(0.92, 3);
  });

  it('min == max: no ramp, full credit at the value', () => {
    expect(f(4, { expYearsMin: 4, expYearsMax: 4 })).toBe(1);
  });

  it('interval: 0.8 at min, 1.0 at max, continuous just past both ends', () => {
    const job = { expYearsMin: 3, expYearsMax: 5 };
    expect(f(3, job)).toBeCloseTo(0.8, 3);
    expect(f(2.99, job)).toBeCloseTo(0.8, 2);
    expect(f(5, job)).toBe(1);
    expect(f(5.01, job)).toBeCloseTo(1, 2);
    expect(f(10, job)).toBeCloseTo(0.92, 3);
  });
});
