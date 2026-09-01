import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { generateObject } from 'ai';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { moveCandidateToStage } from '../candidates/stage-move';

// Same input-size convention as scoring.service.ts
const MAX_TRANSCRIPT_LENGTH = 15_000;

// A call ElevenLabs marks `completed` may still be a 4-second hang-up: the agent's opening
// line alone is already a transcript turn. These gate the AUTO-ADVANCE, which moves a real
// person down a real pipeline — deliberately conservative, under-advance over over-advance.
const MIN_ADVANCE_CANDIDATE_TURNS = 2;
const MIN_ADVANCE_DURATION_SECS = 30;

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

/** As stored by VoiceResultsService.mapTranscript — `message` is genuinely nullable. */
export interface TranscriptTurn {
  role: string;
  message: string | null;
}

/**
 * Turns that actually carry speech. Tool-call and system turns are persisted with a null
 * message; interpolating those would feed the model the literal word "null" as if the
 * candidate had said it, and would inflate the substance gate's turn count.
 */
function substantiveTurns(transcript: TranscriptTurn[]): Array<{ role: string; message: string }> {
  return transcript.flatMap((t) =>
    typeof t.message === 'string' && t.message.trim() !== '' ? [{ role: t.role, message: t.message }] : [],
  );
}

export function renderAssessment(a: AssessmentResult, meta: { attempt: number; durationSecs: number | null }): string {
  // Sub-minute calls report seconds — rounding a 4-second hang-up up to "1 min" would read
  // as a real conversation to whoever skims the stage note.
  const duration =
    meta.durationSecs == null
      ? ''
      : meta.durationSecs < 60
        ? `, ${meta.durationSecs}s`
        : `, ${Math.round(meta.durationSecs / 60)} min`;
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
    transcript: TranscriptTurn[];
    questions: Array<{ text: string }>;
    attempt: number;
    durationSecs: number | null;
  }): Promise<string> {
    const turns = substantiveTurns(input.transcript)
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
    const transcript = Array.isArray(row.transcript) ? (row.transcript as unknown as TranscriptTurn[]) : [];
    const spoken = substantiveTurns(transcript);
    const candidateTurns = spoken.filter((t) => t.role !== 'agent').length;
    if (candidateTurns === 0) {
      // The candidate never said a word (no-pickup, instant hang-up). Nothing to assess and
      // certainly nothing to advance on — the VoiceCall row itself already tells that story.
      this.logger.warn(`assess skipped for call ${row.id} — the candidate never spoke`);
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
    if (existing) {
      // Not silent: this is the one path where a completed call produces no assessment and
      // no advance, and the cause (a human got there first) is invisible in the UI.
      this.logger.warn(
        `assess skipped for call ${row.id} — stage ${stageId} already has a stage summary; not overwriting, not advancing`,
      );
      return;
    }

    const summary = await this.generateAssessment({
      transcript,
      questions: row.job.screeningQuestions,
      attempt: row.attempt,
      durationSecs: row.durationSecs,
    });

    const created = await this.createSummary(row, stageId, summary);
    if (!created) return; // P2002 race — someone else wrote the stage note; never advance

    // The assessment is recorded either way; only the auto-advance needs real substance.
    if (candidateTurns < MIN_ADVANCE_CANDIDATE_TURNS) {
      this.logger.warn(
        `advance skipped for call ${row.id} — only ${candidateTurns} candidate turn(s); assessment recorded`,
      );
      return;
    }
    if (row.durationSecs != null && row.durationSecs < MIN_ADVANCE_DURATION_SECS) {
      this.logger.warn(
        `advance skipped for call ${row.id} — ${row.durationSecs}s is too short to screen on; assessment recorded`,
      );
      return;
    }

    await this.advanceToNextStage(row, stageId);
  }

  /**
   * The stage this call's assessment belongs to. EVERY branch is scoped to the CALL's job,
   * not the candidate's: scheduleAutoCalls can create a call for job B while the candidate
   * sits in job A's pipeline, and filing the note against job A's stage would put screening
   * results in the wrong pipeline (and hand advanceToNextStage a stage it cannot find).
   */
  private async resolveCurrentStage(row: {
    tenantId: string;
    candidateId: string;
    jobId: string;
    candidate: { hiringStageId: string | null };
  }): Promise<string | null> {
    if (row.candidate.hiringStageId) {
      const onThisJob = await this.prisma.jobStage.findFirst({
        where: { id: row.candidate.hiringStageId, jobId: row.jobId, tenantId: row.tenantId },
        select: { id: true },
      });
      if (onThisJob) return onThisJob.id;
    }
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
