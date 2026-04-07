import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenRouter } from '@openrouter/sdk';
import { z } from 'zod';

export const ScoreSchema = z.object({
  score: z.number().min(0).max(100).transform(Math.round),
  reasoning: z.string(),
  strengths: z.array(z.string()),
  gaps: z.array(z.string()),
});
export type ScoreResult = z.infer<typeof ScoreSchema>;

export interface ScoringInput {
  cvText: string;
  candidateFields: {
    currentRole: string | null;
    yearsExperience: number | null;
    skills: string[];
  };
  job: {
    title: string;
    description: string | null;
    requirements: string[];
  };
}

export interface ScoringWithMatchResult {
  matched: boolean;
  matchConfidence?: number;
  score?: ScoreResult & { modelUsed: string };
}

const SCORING_INSTRUCTIONS = `You are a technical recruiter evaluating candidate fit for a job opening.
Score the candidate 0-100 against the job requirements.

Return ONLY a raw JSON object — no markdown, no code fences, no explanation.
The JSON must contain exactly these keys:
- "score" (integer 0-100): Overall fit score. 0-30 = poor fit, 31-50 = weak, 51-70 = moderate, 71-85 = strong, 86-100 = exceptional.
- "reasoning" (string): 1-2 sentences explaining the score.
- "strengths" (string[]): 2-5 specific strengths relevant to this job.
- "gaps" (string[]): 0-5 specific gaps or missing requirements.

RULES:
- Base score solely on the provided information — do not assume skills not mentioned.
- If the CV text is very short or uninformative, score conservatively (30-50 range).
- Be specific in strengths and gaps — reference actual skills/requirements, not generic statements.

Example output:
{
  "score": 85,
  "reasoning": "Strong match. Candidate has 6 years backend experience with Node.js/TypeScript — both key requirements. Missing advanced system design experience.",
  "strengths": ["Node.js/TypeScript expertise", "PostgreSQL + AWS infrastructure", "6+ years relevant experience"],
  "gaps": ["No mention of microservices experience", "System design portfolio not detailed"]
}`;

@Injectable()
export class ScoringAgentService {
  private readonly logger = new Logger(ScoringAgentService.name);

  constructor(private readonly config: ConfigService) {}

  async score(input: ScoringInput): Promise<ScoreResult & { modelUsed: string }> {
    const apiKey = this.config.get<string>('OPENROUTER_API_KEY')!;
    const client = new OpenRouter({ apiKey });

    const MAX_CV_LENGTH = 15_000;
    const MAX_JOB_DESC_LENGTH = 15_000;

    const safeCvText = input.cvText.substring(0, MAX_CV_LENGTH);
    const safeJobDesc = (input.job.description ?? '').substring(0, MAX_JOB_DESC_LENGTH);

    const candidateSection = [
      `Candidate:`,
      `- Current Role: ${input.candidateFields.currentRole ?? 'Unknown'}`,
      `- Years of Experience: ${input.candidateFields.yearsExperience ?? 'Unknown'}`,
      `- Skills: ${input.candidateFields.skills.length > 0 ? input.candidateFields.skills.join(', ') : 'None listed'}`,
      ``,
      `CV Text:`,
      safeCvText,
    ].join('\n');

    const jobSection = [
      `Job:`,
      `- Title: ${input.job.title}`,
      `- Description: ${safeJobDesc || 'N/A'}`,
      `- Requirements: ${input.job.requirements.length > 0 ? input.job.requirements.join(', ') : 'None specified'}`,
    ].join('\n');

    const userMessage = `${candidateSection}\n\n${jobSection}`;

    try {
      const result = client.callModel({
        model: 'openai/gpt-4o-mini',
        instructions: SCORING_INSTRUCTIONS,
        input: userMessage,
      });

      const raw = await result.getText();
      const json = raw
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
        .trim();

      const parseResult = ScoreSchema.safeParse(JSON.parse(json));
      if (!parseResult.success) {
        this.logger.error('Scoring LLM returned invalid JSON', parseResult.error.issues);
        throw new Error(`Scoring output validation failed: ${parseResult.error.message}`);
      }

      this.logger.log(`Scored candidate — score: ${parseResult.data.score}`);
      return { ...parseResult.data, modelUsed: 'openai/gpt-4o-mini' };
    } catch (error) {
      if (error instanceof Error && (error.message.includes('400') || error.message.includes('413'))) {
        this.logger.error(`LLM context window exceeded: ${error.message}`);
        throw new Error('SCORING_CONTEXT_EXCEEDED');
      }
      throw error;
    }
  }
}
