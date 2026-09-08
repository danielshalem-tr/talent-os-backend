import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { generateText, Output } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { z } from 'zod';
import { aiCallGuards } from '../../common/upstream-errors';

export const JobMatchSchema = z.object({
  short_ids: z.array(z.string()),
});

export interface JobMatcherInput {
  openJobs: Array<{ shortId: string; title: string; department: string | null }>;
  emailSubject: string | null;
  emailBody: string | null;
  currentRole: string | null;
}

const MAX_BODY_CHARS = 4_000;

const INSTRUCTIONS = `You match a job application to the open positions of one recruiting company.

You are given the list of currently open jobs, the subject line and body of the application email, and the applicant's current job title taken from their CV.

Decide which open jobs this person APPLIED FOR — not which ones they would be good at.

Rules:
- The email is the strongest evidence. If the subject or body names a position, match that.
- The CV's current role is weaker evidence. Use it only when the email says nothing about which position is wanted.
- Never infer from general suitability. "This person is a developer, so maybe the developer job" is NOT evidence.
- Return every open job the application plausibly targets. If two open jobs fit equally, return both — do not pick a favourite.
- If nothing in the email or the CV role points at a specific open job, return an empty list. An empty answer is a correct and expected answer.

Return ONLY a JSON object of the form {"short_ids": ["106"]}, using short_id values copied exactly from the open-jobs list.`;

/**
 * Fallback matcher for intakes that carry no usable job number (the deterministic short-id
 * parse ran first and found nothing). One small model call, ~1k tokens.
 *
 * This service SUGGESTS. It never decides: the caller enforces the "exactly one open job"
 * rule in code, so a chatty model cannot cause a wrong assignment. Any failure returns an
 * empty list — a missed auto-assignment leaves the candidate in the talent pool, which is
 * exactly the pre-existing behaviour.
 */
@Injectable()
export class JobMatcherService {
  private readonly logger = new Logger(JobMatcherService.name);
  private readonly openrouter: ReturnType<typeof createOpenRouter>;
  private readonly matcherModel: string;

  constructor(private readonly config: ConfigService) {
    this.openrouter = createOpenRouter({ apiKey: config.get<string>('OPENROUTER_API_KEY')! });
    this.matcherModel = config.get<string>('MATCHER_MODEL') ?? 'openai/gpt-4o-mini';
  }

  async match(input: JobMatcherInput): Promise<string[]> {
    if (input.openJobs.length === 0) return [];

    const jobLines = input.openJobs
      .map((job) => `- short_id: ${job.shortId} | title: ${job.title} | department: ${job.department ?? 'unspecified'}`)
      .join('\n');

    const prompt = [
      '--- Open jobs ---',
      jobLines,
      '',
      '--- Application email ---',
      `Subject: ${input.emailSubject ?? '(none)'}`,
      `Body: ${(input.emailBody ?? '(none)').slice(0, MAX_BODY_CHARS)}`,
      '',
      '--- CV evidence ---',
      `Current role: ${input.currentRole ?? '(unknown)'}`,
    ].join('\n');

    try {
      const { output: object } = await generateText({
        model: this.openrouter.chat(this.matcherModel),
        output: Output.object({ schema: JobMatchSchema, name: 'JobMatch' }),
        system: INSTRUCTIONS,
        prompt,
        temperature: 0,
        ...aiCallGuards(),
      });

      const openIds = new Set(input.openJobs.map((job) => job.shortId));
      return [...new Set(object.short_ids.map(String))].filter((id) => openIds.has(id));
    } catch (err) {
      this.logger.warn(`Role matcher failed — leaving the candidate unassigned: ${(err as Error).message}`);
      return [];
    }
  }
}
