import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { generateObject } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { ScoringJob } from './scoring-job-context';
import { computeScore, ScoreBreakdown } from './scoring-policy';
import { buildScoringUserPrompt, EvaluationSchema, SCORING_SYSTEM_PROMPT } from './scoring-prompt';

export const DEFAULT_SCORING_MODEL = 'anthropic/claude-sonnet-5';

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
  private readonly scoringModel: string;

  constructor(private readonly config: ConfigService) {
    this.openrouter = createOpenRouter({ apiKey: config.get<string>('OPENROUTER_API_KEY')! });
    this.scoringModel = config.get<string>('SCORING_MODEL') ?? DEFAULT_SCORING_MODEL;
  }

  async score(input: ScoringInput): Promise<ScoreResult & { modelUsed: string }> {
    const { object: evaluation } = await generateObject({
      model: this.openrouter.chat(this.scoringModel),
      schema: EvaluationSchema,
      schemaName: 'CandidateEvaluation',
      system: SCORING_SYSTEM_PROMPT,
      prompt: buildScoringUserPrompt(input),
      temperature: 0,
    });

    const { score, breakdown } = computeScore(evaluation, {
      expYearsMin: input.job.expYearsMin,
      expYearsMax: input.job.expYearsMax,
    });

    this.logger.log(
      `Scored candidate — score: ${score} (raw ${breakdown.raw_score}, caps: ${
        breakdown.caps_applied.map((c) => c.label).join(',') || 'none'
      })`,
    );
    return {
      score,
      reasoning: evaluation.reasoning,
      strengths: evaluation.strengths,
      gaps: evaluation.gaps,
      breakdown,
      modelUsed: this.scoringModel,
    };
  }
}
