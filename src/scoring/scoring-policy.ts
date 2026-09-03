/**
 * Turns the LLM's structured evaluation into the 0-100 score.
 *
 * The model never emits the number. It reports, per requirement, whether the CV meets it
 * and quotes the evidence; this file applies the policy. That keeps the score auditable
 * (every cap and adjustment is recorded in the breakdown), deterministic for a given
 * evaluation, and tunable without touching the prompt.
 *
 * Rules are keyed on requirement KIND and job FIELDS only — never on a specific job's text.
 */

export type RequirementKind = 'skill' | 'tool' | 'credential' | 'experience' | 'domain' | 'other';
export type RequirementStatus = 'met' | 'partial' | 'missing';
export type EvidenceStrength = 'demonstrated' | 'claimed' | 'none';

export interface RequirementEvaluation {
  requirement: string;
  kind: RequirementKind;
  status: RequirementStatus;
  /** Short quote from the CV, or "not found". */
  evidence: string;
  /** demonstrated = used in a role/project with detail; claimed = appears only in a skills list. */
  evidence_strength: EvidenceStrength;
  /** For kind 'tool': the exact named tool appears (not just an equivalent). */
  exact_match: boolean;
}

export interface ScoringEvaluation {
  must_haves: RequirementEvaluation[];
  nice_to_haves: RequirementEvaluation[];
  /** Professional years relevant to this role, read from the CV's work history. */
  relevant_years: number | null;
  /** 0-100: how close the candidate's actual career is to this role's function. */
  role_relevance: number;
  cv_informative: boolean;
  reasoning: string;
  strengths: string[];
  gaps: string[];
}

export type ExperienceFit = 'below_min' | 'in_range' | 'above_max' | 'unknown' | 'no_range';

export interface ScoreBreakdown {
  version: 1;
  must_have_coverage: number;
  nice_to_have_coverage: number | null;
  role_relevance: number;
  relevant_years: number | null;
  experience_fit: ExperienceFit;
  experience_factor: number;
  raw_score: number;
  adjustments: Array<{ label: string; delta: number }>;
  caps_applied: Array<{ label: string; cap: number }>;
  flags: string[];
  must_haves: RequirementEvaluation[];
  nice_to_haves: RequirementEvaluation[];
}

export interface ScoringPolicy {
  statusValue: Record<RequirementStatus, number>;
  claimedEvidenceFactor: number;
  weights: {
    withNice: { core: number; nice: number; relevance: number };
    withoutNice: { core: number; relevance: number };
  };
  experience: {
    /** Factor at zero relevant years; rises linearly to the in-range factor at the job's minimum. */
    belowMinFloor: number;
    /** The hard cap applies only when the candidate has less than this share of the minimum. */
    belowMinCapShortfall: number;
    /** Factor once the candidate has double the job's maximum; ramps down linearly from 1.0 at max. */
    aboveMax: number;
    unknown: number;
    inRangeFloor: number;
  };
  credentialMissingDelta: number;
  credentialMissingFloor: number;
  exactToolBonus: number;
  exactToolBonusMax: number;
  caps: {
    lowRoleRelevance: { below: number; cap: number };
    multipleCoreMissing: number;
    oneCoreMissing: number;
    /** One core must-have only partially met. */
    corePartial: number;
    /** Two or more partially met. */
    multipleCorePartial: number;
    cvUninformative: number;
    belowMinExperience: number;
  };
}

export const SCORING_POLICY: ScoringPolicy = {
  statusValue: { met: 1, partial: 0.5, missing: 0 },
  claimedEvidenceFactor: 0.75,
  weights: {
    withNice: { core: 0.55, nice: 0.15, relevance: 0.3 },
    withoutNice: { core: 0.65, relevance: 0.35 },
  },
  experience: { belowMinFloor: 0.6, belowMinCapShortfall: 0.5, aboveMax: 0.92, unknown: 0.85, inRangeFloor: 0.8 },
  credentialMissingDelta: -5,
  credentialMissingFloor: -10,
  exactToolBonus: 3,
  exactToolBonusMax: 5,
  caps: {
    lowRoleRelevance: { below: 40, cap: 30 },
    multipleCoreMissing: 45,
    oneCoreMissing: 60,
    corePartial: 88,
    multipleCorePartial: 78,
    cvUninformative: 50,
    belowMinExperience: 45,
  },
};

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

function requirementValue(r: RequirementEvaluation, p: ScoringPolicy): number {
  const base = p.statusValue[r.status];
  // "partial" is already a discount; stacking the claimed factor on top punished a listed
  // tool twice (0.375) and made one model flip swing the score.
  return r.status === 'met' && r.evidence_strength === 'claimed' ? base * p.claimedEvidenceFactor : base;
}

function coverage(reqs: RequirementEvaluation[], p: ScoringPolicy): number | null {
  if (reqs.length === 0) return null;
  return reqs.reduce((s, r) => s + requirementValue(r, p), 0) / reqs.length;
}

function experienceFactor(
  years: number | null,
  job: { expYearsMin: number | null; expYearsMax: number | null },
  p: ScoringPolicy,
): { fit: ExperienceFit; factor: number; shortfall: number } {
  const { expYearsMin: min, expYearsMax: max } = job;
  if (min == null && max == null) return { fit: 'no_range', factor: 1, shortfall: 0 };
  if (years == null) return { fit: 'unknown', factor: p.experience.unknown, shortfall: 0 };

  // The in-range ramp (inRangeFloor at min → 1.0 at max) only exists when the job gives a real
  // interval. With one bound missing, or min == max, being in range is simply full credit; the
  // other branches start from that same value so the curve is continuous at both boundaries.
  const hasInterval = min != null && max != null && max > min;
  const factorAtMin = hasInterval ? p.experience.inRangeFloor : 1;

  if (min != null && years < min) {
    // Continuous, not a cliff: 0.9 years against a 1-year minimum is nearly in range, and the
    // model's own year estimate wobbles by a few months between runs.
    const shortfall = Math.min(1, (min - years) / min);
    const factor = factorAtMin - (factorAtMin - p.experience.belowMinFloor) * shortfall;
    return { fit: 'below_min', factor, shortfall };
  }
  if (max != null && years > max) {
    // Light, continuous penalty: reaches aboveMax once the candidate has double the maximum.
    const excess = Math.min(1, (years - max) / Math.max(max, 1));
    return { fit: 'above_max', factor: 1 - (1 - p.experience.aboveMax) * excess, shortfall: 0 };
  }
  if (!hasInterval) return { fit: 'in_range', factor: 1, shortfall: 0 };
  const frac = (years - min) / (max - min);
  return { fit: 'in_range', factor: p.experience.inRangeFloor + (1 - p.experience.inRangeFloor) * frac, shortfall: 0 };
}

export function computeScore(
  ev: ScoringEvaluation,
  job: { expYearsMin: number | null; expYearsMax: number | null },
  policy: ScoringPolicy = SCORING_POLICY,
): { score: number; breakdown: ScoreBreakdown } {
  const p = policy;
  const relevance = Math.min(100, Math.max(0, ev.role_relevance)) / 100;
  // exact_match only means something for a named tool; the model tends to set it on every
  // met skill, which would leak "exact match" badges into the UI.
  const normalize = (r: RequirementEvaluation): RequirementEvaluation => ({
    ...r,
    exact_match: r.kind === 'tool' && r.exact_match,
  });
  ev = { ...ev, must_haves: ev.must_haves.map(normalize), nice_to_haves: ev.nice_to_haves.map(normalize) };

  // Credentials never gate the score (Daniel, 2026-09-03): they are a small deduction below,
  // so they are pulled out of the coverage average and out of the cap rules entirely.
  // Pure years/seniority statements ("5+ years as a developer") are likewise excluded: the
  // experience factor below already prices relevant_years against the job's range, and counting
  // the same fact twice would punish a junior twice for one shortfall.
  const core = ev.must_haves.filter((r) => r.kind !== 'credential' && r.kind !== 'experience');
  const credentials = ev.must_haves.filter((r) => r.kind === 'credential');
  const coreCoverage = coverage(core, p) ?? relevance;
  const niceCoverage = coverage(ev.nice_to_haves, p);

  // A job with no nice-to-haves redistributes that weight onto the two remaining terms rather
  // than scoring everyone as if they missed a category that was never asked for.
  let raw: number;
  if (niceCoverage == null) {
    const w = p.weights.withoutNice;
    raw = 100 * (w.core * coreCoverage + w.relevance * relevance);
  } else {
    const w = p.weights.withNice;
    raw = 100 * (w.core * coreCoverage + w.nice * niceCoverage + w.relevance * relevance);
  }

  const flags: string[] = [];
  const exp = experienceFactor(ev.relevant_years, job, p);
  if (exp.fit === 'below_min') flags.push('below_min_experience');
  if (exp.fit === 'above_max') flags.push('over_qualified');
  if (exp.fit === 'unknown') flags.push('experience_unknown');
  raw *= exp.factor;

  const adjustments: Array<{ label: string; delta: number }> = [];
  const credentialDelta = Math.max(
    p.credentialMissingFloor,
    credentials.filter((r) => r.status === 'missing').length * p.credentialMissingDelta,
  );
  if (credentialDelta !== 0) {
    // Emit one line per missing credential so the UI can list them, but clamp the sum.
    let remaining = credentialDelta;
    const missingCredentials = credentials.filter((c) => c.status === 'missing').length;
    for (let i = 0; i < missingCredentials && remaining < 0; i++) {
      const d = Math.max(remaining, p.credentialMissingDelta);
      adjustments.push({ label: 'credential_missing', delta: d });
      remaining -= d;
    }
  }
  let toolBonus = 0;
  for (const r of ev.must_haves) {
    if (r.kind === 'tool' && r.status === 'met' && r.exact_match && toolBonus < p.exactToolBonusMax) {
      const d = Math.min(p.exactToolBonus, p.exactToolBonusMax - toolBonus);
      adjustments.push({ label: 'exact_tool_match', delta: d });
      toolBonus += d;
    }
  }
  let score = raw + adjustments.reduce((s, a) => s + a.delta, 0);

  const caps: Array<{ label: string; cap: number }> = [];
  const missing = core.filter((r) => r.status === 'missing').length;
  const partial = core.filter((r) => r.status === 'partial').length;
  if (relevance * 100 < p.caps.lowRoleRelevance.below) {
    caps.push({ label: 'low_role_relevance', cap: p.caps.lowRoleRelevance.cap });
  }
  if (missing >= 2) caps.push({ label: 'multiple_core_must_haves_missing', cap: p.caps.multipleCoreMissing });
  else if (missing === 1) caps.push({ label: 'core_must_have_missing', cap: p.caps.oneCoreMissing });
  else if (partial >= 2) caps.push({ label: 'multiple_core_must_haves_partial', cap: p.caps.multipleCorePartial });
  else if (partial === 1) caps.push({ label: 'core_must_have_partial', cap: p.caps.corePartial });
  if (!ev.cv_informative) caps.push({ label: 'cv_uninformative', cap: p.caps.cvUninformative });
  if (exp.fit === 'below_min' && exp.shortfall >= p.experience.belowMinCapShortfall) {
    caps.push({ label: 'below_min_experience', cap: p.caps.belowMinExperience });
  }
  for (const c of caps) score = Math.min(score, c.cap);

  const final = Math.round(Math.min(100, Math.max(0, score)));
  return {
    score: final,
    breakdown: {
      version: 1,
      must_have_coverage: round3(coreCoverage),
      nice_to_have_coverage: niceCoverage == null ? null : round3(niceCoverage),
      role_relevance: Math.round(relevance * 100),
      relevant_years: ev.relevant_years,
      experience_fit: exp.fit,
      experience_factor: round3(exp.factor),
      raw_score: Math.round(raw * 10) / 10,
      adjustments,
      caps_applied: caps,
      flags,
      must_haves: ev.must_haves,
      nice_to_haves: ev.nice_to_haves,
    },
  };
}
