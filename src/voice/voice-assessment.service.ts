import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { generateObject } from 'ai';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { moveCandidateToStage } from '../candidates/stage-move';

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

  /**
   * The `assess` worker job (spec §5): AI assessment of a completed call written into the
   * candidate's current hiring stage, then a single idempotent advance. Enqueued only by
   * finalizeFromTranscription, jobId `assess-{voiceCallId}`. Ordering is deliberate:
   * stage + existing-summary checks run BEFORE the LLM so a redelivery never spends tokens.
   */
  async assessCall(voiceCallId: string): Promise<void> {
    const row = await this.prisma.voiceCall.findUniqueOrThrow({
      where: { id: voiceCallId },
      include: {
        candidate: { select: { hiringStageId: true } },
        job: { select: { screeningQuestions: { orderBy: { order: 'asc' }, select: { text: true } } } },
      },
    });
    if (row.status !== 'completed') {
      this.logger.warn(`assess skipped for call ${row.id} — status is ${row.status}, not completed`);
      return;
    }
    const transcript = Array.isArray(row.transcript)
      ? (row.transcript as unknown as Array<{ role: string; message: string }>)
      : [];
    if (transcript.length === 0) {
      this.logger.warn(`assess skipped for call ${row.id} — no transcript stored`);
      return;
    }

    const stageId = await this.resolveCurrentStage(row);
    if (!stageId) {
      this.logger.warn(`assess skipped for call ${row.id} — no hiring stage resolvable`);
      return;
    }

    // Create-only (a recruiter's note is never overwritten) — checked before the LLM call
    // so webhook redeliveries and watchdog races cost nothing and can never advance twice.
    const existing = await this.prisma.candidateStageSummary.findUnique({
      where: { idx_cand_stage_summary: { candidateId: row.candidateId, jobStageId: stageId } },
      select: { id: true },
    });
    if (existing) return;

    const summary = await this.generateAssessment({
      transcript,
      questions: row.job.screeningQuestions,
      attempt: row.attempt,
      durationSecs: row.durationSecs,
    });

    const created = await this.createSummary(row, stageId, summary);
    if (!created) return; // P2002 race — someone else wrote the stage note; never advance

    await this.advanceToNextStage(row, stageId);
  }

  private async resolveCurrentStage(row: {
    tenantId: string;
    candidateId: string;
    jobId: string;
    candidate: { hiringStageId: string | null };
  }): Promise<string | null> {
    if (row.candidate.hiringStageId) return row.candidate.hiringStageId;
    const app = await this.prisma.application.findUnique({
      where: {
        idx_applications_unique: { tenantId: row.tenantId, candidateId: row.candidateId, jobId: row.jobId },
      },
      select: { jobStageId: true },
    });
    if (app?.jobStageId) return app.jobStageId;
    const first = await this.prisma.jobStage.findFirst({
      where: { jobId: row.jobId, tenantId: row.tenantId, isEnabled: true },
      orderBy: { order: 'asc' },
      select: { id: true },
    });
    return first?.id ?? null;
  }

  private async createSummary(
    row: { tenantId: string; candidateId: string },
    jobStageId: string,
    summary: string,
  ): Promise<boolean> {
    try {
      await this.prisma.candidateStageSummary.create({
        data: { tenantId: row.tenantId, candidateId: row.candidateId, jobStageId, summary },
      });
      return true;
    } catch (err) {
      if ((err as { code?: string })?.code === 'P2002') return false;
      throw err;
    }
  }

  private async advanceToNextStage(
    row: { tenantId: string; candidateId: string; jobId: string },
    currentStageId: string,
  ): Promise<void> {
    const stages = await this.prisma.jobStage.findMany({
      where: { jobId: row.jobId, tenantId: row.tenantId, isEnabled: true },
      orderBy: { order: 'asc' },
      select: { id: true },
    });
    const idx = stages.findIndex((s) => s.id === currentStageId);
    // Unknown/disabled current stage, or already last → summary only, no move.
    if (idx === -1 || idx === stages.length - 1) return;
    await moveCandidateToStage(this.prisma, row.candidateId, stages[idx + 1].id, row.tenantId);
  }
}
