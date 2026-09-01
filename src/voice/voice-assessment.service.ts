import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { generateObject } from 'ai';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';

// Same input-size convention as scoring.service.ts
const MAX_TRANSCRIPT_LENGTH = 15_000;

export const AssessmentSchema = z.object({
  answers: z.array(
    z.object({
      question: z.string(),
      answer: z.string(),
      flags: z.array(z.enum(['far_availability', 'unclear_answer', 'joking_answer', 'not_answered'])),
    }),
  ),
  recommendation: z.string(),
});
export type AssessmentResult = z.infer<typeof AssessmentSchema>;

const FLAG_LABELS: Record<AssessmentResult['answers'][number]['flags'][number], string> = {
  far_availability: 'availability is far out',
  unclear_answer: 'answer unclear',
  joking_answer: 'joking answer',
  not_answered: 'not actually answered',
};

const ASSESSMENT_INSTRUCTIONS = `You assess transcripts of short recruiter screening phone calls. The call may be in Hebrew; your output is ALWAYS English.
For EVERY screening question listed, report the candidate's answer as captured on the call — including questions that were skipped or answered badly.
Flags, only when clearly warranted: far_availability (start date months away), unclear_answer, joking_answer (the candidate joked instead of answering), not_answered (the question was never asked or never actually answered — set the answer text to "—").
Never invent information that is not in the transcript, and never assess skills beyond what was said.
Finish with a one-line recommendation for the recruiting team.`;

export function renderAssessment(a: AssessmentResult, meta: { attempt: number; durationSecs: number | null }): string {
  const duration = meta.durationSecs != null ? `, ${Math.max(1, Math.round(meta.durationSecs / 60))} min` : '';
  const lines = [`[AI screening-call assessment — attempt ${meta.attempt}${duration}]`, ''];
  a.answers.forEach((ans, i) => {
    lines.push(`${i + 1}. ${ans.question}`);
    lines.push(`   Answer: ${ans.answer}`);
    if (ans.flags.length > 0) lines.push(`   Flags: ${ans.flags.map((f) => FLAG_LABELS[f]).join(', ')}`);
  });
  lines.push('', `Recommendation: ${a.recommendation}`);
  return lines.join('\n');
}

@Injectable()
export class VoiceAssessmentService {
  private readonly logger = new Logger(VoiceAssessmentService.name);
  private readonly openrouter: ReturnType<typeof createOpenRouter>;
  private readonly model: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.openrouter = createOpenRouter({ apiKey: config.get<string>('OPENROUTER_API_KEY')! });
    this.model = config.get<string>('SCORING_MODEL') ?? 'openai/gpt-4o-mini';
  }

  async generateAssessment(input: {
    transcript: Array<{ role: string; message: string }>;
    questions: Array<{ text: string }>;
    attempt: number;
    durationSecs: number | null;
  }): Promise<string> {
    const turns = input.transcript
      .map((t) => `${t.role === 'agent' ? 'Interviewer' : 'Candidate'}: ${t.message}`)
      .join('\n')
      .substring(0, MAX_TRANSCRIPT_LENGTH);
    const questions =
      input.questions.length > 0
        ? input.questions.map((q, i) => `${i + 1}. ${q.text}`).join('\n')
        : '(no screening questions were configured — this was a general screening conversation)';

    const { object } = await generateObject({
      model: this.openrouter.chat(this.model),
      schema: AssessmentSchema,
      schemaName: 'ScreeningCallAssessment',
      system: ASSESSMENT_INSTRUCTIONS,
      prompt: `## Screening questions\n${questions}\n\n## Call transcript\n${turns}`,
      temperature: 0,
    });

    return renderAssessment(object, { attempt: input.attempt, durationSecs: input.durationSecs });
  }
}
