import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { generateObject } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { ScoringJob } from './scoring-job-context';
import { computeScore, RequirementEvaluation, ScoreBreakdown, ScoringEvaluation } from './scoring-policy';
import { buildScoringUserPrompt, EvaluationSchema, SCORING_SYSTEM_PROMPT } from './scoring-prompt';

/**
 * Deliberately NOT an env var. The model was chosen by a bake-off on real CVs (eval notes are
 * kept outside the repo) and the policy in scoring-policy.ts is tuned to its evaluations; a
 * stray SCORING_MODEL in a deployment env must not silently swap it. Change it here, re-run
 * `npm run scoring:eval`, commit.
 */
export const SCORING_MODEL = 'anthropic/claude-sonnet-5';

/**
 * Per-sample upstream budget. Without it a stalled OpenRouter call hangs the HTTP assign/rescore
 * request forever; with three parallel samples the default `maxRetries: 2` would mean up to nine
 * upstream requests per CV.
 */
export const SCORING_TIMEOUT_MS = 60_000;

/**
 * Independent evaluations per CV, run in parallel; the median score wins and its evaluation is
 * the one persisted. Even at temperature 0 the model flips a borderline requirement between
 * met and partial on maybe one run in three, and a single flip moved a score by 15 points in
 * the eval set. Three samples cost ~$0.06 per CV and add no latency.
 */
export const SCORING_SAMPLES = 3;

export interface ScoringInput {
  cvText: string;
  candidateFields: {
    currentRole: string | null;
    yearsExperience: number | null;
    skills: string[];
  };
  job: ScoringJob;
}

export interface ScoreResult {
  score: number;
  reasoning: string;
  strengths: string[];
  gaps: string[];
  breakdown: ScoreBreakdown;
}

export interface ScoringWithMatchResult {
  matched: boolean;
  matchConfidence?: number;
  score?: ScoreResult & { modelUsed: string };
}

const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * The policy divides by the number of requirements the model RETURNED. If the model drops a
 * must-have it could not find, coverage rises and the must-have cap is skipped — a worse
 * candidate scores higher. Any job requirement with no matching entry is therefore appended as
 * `missing`, and a requirement the model evaluated twice counts once.
 */
export function completeEvaluation(evaluation: ScoringEvaluation, job: ScoringJob, logger?: Logger): ScoringEvaluation {
  const fill = (evaluated: RequirementEvaluation[], expected: string[], group: string) => {
    // One entry per requirement name. The old check "evaluated.length >= expected.length" let
    // a repeated or invented entry stand in for a requirement the model never evaluated —
    // coverage rose, the must-have cap was skipped, a worse candidate scored higher.
    const seen = new Set<string>();
    const deduped = evaluated.filter((r) => {
      const key = normalize(r.requirement);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const absent = expected.filter((req) => req.trim() !== '' && !seen.has(normalize(req)));
    if (absent.length === 0 && deduped.length === evaluated.length) return evaluated;
    if (deduped.length !== evaluated.length) {
      logger?.warn(`Model repeated ${evaluated.length - deduped.length} ${group} requirement(s); duplicates dropped`);
    }
    if (absent.length > 0) {
      logger?.warn(`Model skipped ${absent.length} ${group} requirement(s), recorded as missing: ${absent.join(' | ')}`);
    }
    return [
      ...deduped,
      ...absent.map<RequirementEvaluation>((requirement) => ({
        requirement,
        kind: 'other',
        status: 'missing',
        evidence: 'not found',
        evidence_strength: 'none',
        exact_match: false,
      })),
    ];
  };
  return {
    ...evaluation,
    must_haves: fill(evaluation.must_haves, job.mustHaveSkills, 'must-have'),
    nice_to_haves: fill(evaluation.nice_to_haves, job.niceToHaveSkills, 'nice-to-have'),
  };
}

/**
 * Two-step scoring: the model audits the CV against each requirement (structured
 * evaluation with quoted evidence); `computeScore` applies the policy. See scoring-policy.ts
 * for why the model never emits the number itself.
 */
@Injectable()
export class ScoringAgentService {
  private readonly logger = new Logger(ScoringAgentService.name);
  private readonly openrouter: ReturnType<typeof createOpenRouter>;

  constructor(private readonly config: ConfigService) {
    this.openrouter = createOpenRouter({ apiKey: config.get<string>('OPENROUTER_API_KEY')! });
  }

  /** `opts` exist for the eval harness (scripts/scoring-eval.ts) only; production always uses the constants. */
  async score(
    input: ScoringInput,
    opts: { model?: string; samples?: number } = {},
  ): Promise<ScoreResult & { modelUsed: string }> {
    const model = opts.model ?? SCORING_MODEL;
    const samples = Math.max(1, opts.samples ?? SCORING_SAMPLES);
    const prompt = buildScoringUserPrompt(input);
    const range = { expYearsMin: input.job.expYearsMin, expYearsMax: input.job.expYearsMax };

    const settled = await Promise.allSettled(
      Array.from({ length: samples }, async () => {
        const { object: evaluation } = await generateObject({
          model: this.openrouter.chat(model),
          schema: EvaluationSchema,
          schemaName: 'CandidateEvaluation',
          system: SCORING_SYSTEM_PROMPT,
          prompt,
          temperature: 0,
          maxRetries: 1,
          abortSignal: AbortSignal.timeout(SCORING_TIMEOUT_MS),
        });
        const complete = completeEvaluation(evaluation, input.job, this.logger);
        return { evaluation: complete, ...computeScore(complete, range) };
      }),
    );
    // One transient 429/5xx or schema miss must not fail the intake three times as often as
    // before: keep whatever succeeded, throw only when every sample failed.
    const results = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
    const failures = settled.filter((s) => s.status === 'rejected');
    if (results.length === 0) throw failures[0].reason;
    if (failures.length > 0) {
      this.logger.warn(
        `${failures.length}/${samples} scoring samples failed: ${failures.map((f) => String(f.reason)).join(' | ')}`,
      );
    }
    // Median by score; on an even count take the lower-middle so the persisted breakdown is a
    // real evaluation rather than an average of two.
    results.sort((a, b) => a.score - b.score);
    const { evaluation, score, breakdown } = results[Math.floor((results.length - 1) / 2)];

    this.logger.log(
      `Scored candidate — score: ${score} (samples ${results.map((r) => r.score).join('/')}, raw ${
        breakdown.raw_score
      }, caps: ${breakdown.caps_applied.map((c) => c.label).join(',') || 'none'})`,
    );
    return {
      score,
      reasoning: evaluation.reasoning,
      strengths: evaluation.strengths,
      gaps: evaluation.gaps,
      breakdown,
      modelUsed: model,
    };
  }
}
