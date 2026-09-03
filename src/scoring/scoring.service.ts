import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { generateObject } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { ScoringJob } from './scoring-job-context';
import { computeScore, ScoreBreakdown } from './scoring-policy';
import { buildScoringUserPrompt, EvaluationSchema, SCORING_SYSTEM_PROMPT } from './scoring-prompt';

/**
 * Deliberately NOT an env var. The model was chosen by a bake-off on real CVs (see
 * docs/superpowers/specs/2026-09-03-scoring-accuracy-research.md §7) and the policy in
 * scoring-policy.ts is tuned to its evaluations; a stray SCORING_MODEL in a deployment env must
 * not silently swap it. Change it here, re-run `npm run scoring:eval`, commit.
 */
export const SCORING_MODEL = 'anthropic/claude-sonnet-5';

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

    const results = await Promise.all(
      Array.from({ length: samples }, async () => {
        const { object: evaluation } = await generateObject({
          model: this.openrouter.chat(model),
          schema: EvaluationSchema,
          schemaName: 'CandidateEvaluation',
          system: SCORING_SYSTEM_PROMPT,
          prompt,
          temperature: 0,
        });
        return { evaluation, ...computeScore(evaluation, range) };
      }),
    );
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
