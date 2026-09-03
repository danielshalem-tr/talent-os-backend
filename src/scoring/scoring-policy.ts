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
  experience: { belowMin: number; aboveMax: number; unknown: number; inRangeFloor: number };
  credentialMissingDelta: number;
  credentialMissingFloor: number;
  exactToolBonus: number;
  exactToolBonusMax: number;
  caps: {
    lowRoleRelevance: { below: number; cap: number };
    multipleCoreMissing: number;
    oneCoreMissing: number;
    corePartial: number;
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
  experience: { belowMin: 0.6, aboveMax: 0.92, unknown: 0.85, inRangeFloor: 0.8 },
  credentialMissingDelta: -5,
  credentialMissingFloor: -10,
  exactToolBonus: 3,
  exactToolBonusMax: 5,
  caps: {
    lowRoleRelevance: { below: 40, cap: 30 },
    multipleCoreMissing: 45,
    oneCoreMissing: 60,
    corePartial: 78,
    cvUninformative: 50,
    belowMinExperience: 45,
  },
};

function requirementValue(r: RequirementEvaluation, p: ScoringPolicy): number {
  const base = p.statusValue[r.status];
  return r.evidence_strength === 'claimed' ? base * p.claimedEvidenceFactor : base;
}

function coverage(reqs: RequirementEvaluation[], p: ScoringPolicy): number | null {
  if (reqs.length === 0) return null;
  return reqs.reduce((s, r) => s + requirementValue(r, p), 0) / reqs.length;
}

function experienceFactor(
  years: number | null,
  job: { expYearsMin: number | null; expYearsMax: number | null },
  p: ScoringPolicy,
): { fit: ExperienceFit; factor: number } {
  const { expYearsMin: min, expYearsMax: max } = job;
  if (min == null && max == null) return { fit: 'no_range', factor: 1 };
  if (years == null) return { fit: 'unknown', factor: p.experience.unknown };
  if (min != null && years < min) return { fit: 'below_min', factor: p.experience.belowMin };
  if (max != null && years > max) return { fit: 'above_max', factor: p.experience.aboveMax };
  const lo = min ?? years;
  const hi = max ?? years;
  if (hi <= lo) return { fit: 'in_range', factor: 1 };
  const frac = (years - lo) / (hi - lo);
  return { fit: 'in_range', factor: p.experience.inRangeFloor + (1 - p.experience.inRangeFloor) * frac };
}

export function computeScore(
  ev: ScoringEvaluation,
  job: { expYearsMin: number | null; expYearsMax: number | null },
  policy: ScoringPolicy = SCORING_POLICY,
): { score: number; breakdown: ScoreBreakdown } {
  const p = policy;
  const relevance = Math.min(100, Math.max(0, ev.role_relevance)) / 100;

  // Credentials never gate the score (Daniel, 2026-09-03): they are a small deduction below,
  // so they are pulled out of the coverage average and out of the cap rules entirely.
  const core = ev.must_haves.filter((r) => r.kind !== 'credential');
  const credentials = ev.must_haves.filter((r) => r.kind === 'credential');
  const coreCoverage = coverage(core, p) ?? relevance;
  const niceCoverage = coverage(ev.nice_to_haves, p);

  const w = niceCoverage == null ? p.weights.withoutNice : p.weights.withNice;
  let raw =
    niceCoverage == null
      ? 100 * (w.core * coreCoverage + w.relevance * relevance)
      : 100 * (w.core * coreCoverage + (w as { nice: number }).nice * niceCoverage + w.relevance * relevance);

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
    for (const r of credentials.filter((c) => c.status === 'missing')) {
      if (remaining >= 0) break;
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
  else if (partial >= 1) caps.push({ label: 'core_must_have_partial', cap: p.caps.corePartial });
  if (!ev.cv_informative) caps.push({ label: 'cv_uninformative', cap: p.caps.cvUninformative });
  if (exp.fit === 'below_min') caps.push({ label: 'below_min_experience', cap: p.caps.belowMinExperience });
  for (const c of caps) score = Math.min(score, c.cap);

  const final = Math.round(Math.min(100, Math.max(0, score)));
  return {
    score: final,
    breakdown: {
      version: 1,
      must_have_coverage: coreCoverage,
      nice_to_have_coverage: niceCoverage,
      role_relevance: Math.round(relevance * 100),
      relevant_years: ev.relevant_years,
      experience_fit: exp.fit,
      experience_factor: exp.factor,
      raw_score: Math.round(raw * 10) / 10,
      adjustments,
      caps_applied: caps,
      flags,
      must_haves: ev.must_haves,
      nice_to_haves: ev.nice_to_haves,
    },
  };
}
