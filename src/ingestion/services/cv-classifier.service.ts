import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { generateText, Output } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { z } from 'zod';
import { StorageService } from '../../storage/storage.service';
import { aiCallGuards } from '../../common/upstream-errors';

export type CvVerdict = 'cv' | 'not_cv' | 'uncertain';

export const CvClassificationSchema = z.object({
  verdict: z.enum(['cv', 'not_cv', 'uncertain']),
  reason: z.string(),
});

export type CvClassification = z.infer<typeof CvClassificationSchema>;

export interface CvClassifierInput {
  fullText: string; // body + attachment text (already built in the processor)
  subject: string;
  fromEmail: string;
  suspicious: boolean; // revived spam-filter signal
  hasMeaningfulAttachment: boolean;
  /** True only when an attachment is a PDF/DOCX/DOC (document-detect.ts) — not a logo. */
  hasCvDocument: boolean;
  bodyLength: number;
  resolvedAgency: string | null; // from resolveAgencyFromEmail()
  tenantId: string;
  messageId: string; // for retry-safe caching
}

const INSTRUCTIONS = `You are a strict gatekeeper for an Israeli recruiting platform's email intake.
Your ONLY job is to decide whether an inbound email is a job application.

It IS a job application ("cv") when it is any of:
- a candidate sending their CV / resume (as text or as an attachment),
- a cover letter or an email expressing interest in a specific job,
- a recruiting agency presenting or submitting a candidate.

It is NOT a job application ("not_cv") when it is any of:
- an invoice, receipt, quote, purchase order, or contract,
- sales / marketing / promotional outreach,
- a newsletter or mailing-list blast,
- vendor / supplier / partnership mail,
- an internal reply or an ongoing thread ("thanks", "talk tomorrow", "see notes attached"),
- a calendar invite or meeting item,
- a general question, or a support / helpdesk request.

If you genuinely cannot tell, answer "uncertain". DO NOT GUESS — losing a real
candidate is worse than asking a human to look. But do not label obvious
non-applications "uncertain" just to be safe.

Respond with the verdict and a single short sentence of reasoning.`;

@Injectable()
export class CvClassifierService {
  private readonly logger = new Logger(CvClassifierService.name);
  private readonly openrouter: ReturnType<typeof createOpenRouter>;
  private readonly classifierModel: string;

  constructor(
    private readonly config: ConfigService,
    private readonly storageService: StorageService,
  ) {
    this.openrouter = createOpenRouter({ apiKey: config.get<string>('OPENROUTER_API_KEY')! });
    this.classifierModel = config.get<string>('CLASSIFIER_MODEL') ?? 'openai/gpt-4o-mini';
  }

  async classify(input: CvClassifierInput): Promise<CvClassification> {
    // Layer 1 — deterministic short-circuit (no AI):
    // a known recruiting agency submitting a document is an unambiguous CV signal.
    if (input.resolvedAgency !== null && input.hasCvDocument) {
      return { verdict: 'cv', reason: `Known agency sender (${input.resolvedAgency}) with a document attachment` };
    }

    // Retry-safe cache — a BullMQ retry must not re-call the model.
    const cached = await this.storageService.loadClassificationCache(input.tenantId, input.messageId);
    if (cached !== null) {
      this.logger.log(`Classification cache hit for ${input.messageId}`);
      return CvClassificationSchema.parse(cached);
    }

    // Layer 2 — AI judge.
    const classification = await this.callAI(input);

    try {
      await this.storageService.saveClassificationCache(classification, input.tenantId, input.messageId);
    } catch (cacheErr) {
      this.logger.warn(
        `Failed to cache classification for ${input.messageId} — retry will re-call AI: ${(cacheErr as Error).message}`,
      );
    }

    return classification;
  }

  private async callAI(input: CvClassifierInput): Promise<CvClassification> {
    const MAX_INPUT_LENGTH = 20_000;
    const safeFullText = input.fullText.substring(0, MAX_INPUT_LENGTH);

    const prompt = [
      `--- Signals ---`,
      `From: ${input.fromEmail}`,
      `Subject: ${input.subject}`,
      `Has document attachment: ${input.hasMeaningfulAttachment ? 'yes' : 'no'}`,
      `Flagged suspicious by pre-filter: ${input.suspicious ? 'yes' : 'no'}`,
      `Body length (chars): ${input.bodyLength}`,
      `Resolved recruiting agency: ${input.resolvedAgency ?? 'none'}`,
      ``,
      `--- Email content (body + attachment text, truncated) ---`,
      safeFullText,
    ].join('\n');

    const { output: object } = await generateText({
      model: this.openrouter.chat(this.classifierModel),
      output: Output.object({ schema: CvClassificationSchema, name: 'CvClassification' }),
      system: INSTRUCTIONS,
      prompt,
      temperature: 0,
      ...aiCallGuards(),
    });

    this.logger.log(`CV classification for ${input.messageId}: ${object.verdict}`);
    return object;
  }
}
