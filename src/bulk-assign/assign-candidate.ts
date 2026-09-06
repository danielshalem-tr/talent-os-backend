import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ScoringAgentService, ScoringInput } from '../scoring/scoring.service';
import { scoringJobSelect, toScoringJob } from '../scoring/scoring-job-context';
import { moveCandidateToStage } from '../candidates/stage-move';

const logger = new Logger('assignCandidateToJob');

export type AssignOutcome = 'scored' | 'assigned_not_scored' | 'skipped_inactive';

export interface AssignResult {
  outcome: AssignOutcome;
  score: number | null;
}

/**
 * Assign ONE candidate to ONE job and score them against it.
 *
 * A plain function, not a provider — the same reason `stage-move.ts` is one: the BullMQ
 * worker must be able to call this without importing CandidatesModule, whose AuthModule
 * registers a global APP_GUARD that has no business running in the worker process.
 *
 * Every write is idempotent, so a BullMQ retry (or the same candidate selected twice in
 * the UI) costs at most one extra scoring call and changes nothing else.
 */
export async function assignCandidateToJob(
  prisma: PrismaService,
  scoringAgent: ScoringAgentService,
  params: { tenantId: string; candidateId: string; jobId: string },
): Promise<AssignResult> {
  const { tenantId, candidateId, jobId } = params;

  const candidate = await prisma.candidate.findFirst({
    where: { id: candidateId, tenantId },
    select: { id: true, status: true, cvText: true, currentRole: true, yearsExperience: true, skills: true },
  });
  if (!candidate) {
    throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'Candidate not found' } });
  }
  if (candidate.status !== 'active') {
    return { outcome: 'skipped_inactive', score: null };
  }

  const job = await prisma.job.findFirst({
    where: { id: jobId, tenantId },
    select: { id: true, status: true, ...scoringJobSelect },
  });
  if (!job) {
    throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'Job not found' } });
  }
  if (job.status !== 'open') {
    throw new BadRequestException({ error: { code: 'JOB_NOT_OPEN', message: 'Job is not open' } });
  }

  // 1. Application row — unique per (tenant, candidate, job), so this is a no-op on repeat.
  const application = await prisma.application.upsert({
    where: { idx_applications_unique: { tenantId, candidateId, jobId } },
    create: { tenantId, candidateId, jobId, stage: 'new' },
    update: {},
    select: { id: true, jobStageId: true },
  });

  // 2. Point the candidate at the job BEFORE any stage work: moveCandidateToStage
  //    validates the target stage against candidate.jobId and throws NO_JOB otherwise.
  await prisma.candidate.update({ where: { id: candidateId }, data: { jobId } });

  // 3. Initial stage placement ONLY. A completed screening call auto-advances the candidate
  //    (the voice assess worker), so re-running an assign must never drag them back to the
  //    first stage. Voice auto-advance always wins.
  if (application.jobStageId === null) {
    const firstStage = await prisma.jobStage.findFirst({
      where: { jobId, tenantId, isEnabled: true },
      orderBy: { order: 'asc' },
      select: { id: true },
    });
    if (firstStage) {
      await moveCandidateToStage(prisma, candidateId, firstStage.id, tenantId);
    } else {
      logger.warn(`Job ${jobId} has no enabled stages — candidate ${candidateId} assigned without a stage`);
    }
  }

  // 4. Score. No CV text means there is nothing to score against; the assignment stands.
  const cvText = candidate.cvText?.trim() ?? '';
  if (cvText === '') {
    return { outcome: 'assigned_not_scored', score: null };
  }

  const scoreResult = await scoringAgent.score({
    cvText,
    candidateFields: {
      currentRole: candidate.currentRole,
      yearsExperience: candidate.yearsExperience,
      skills: candidate.skills,
    },
    job: toScoringJob(job),
  } satisfies ScoringInput);

  await prisma.candidateJobScore.upsert({
    where: { idx_scores_unique_per_app: { tenantId, applicationId: application.id } },
    create: {
      tenantId,
      applicationId: application.id,
      score: scoreResult.score,
      reasoning: scoreResult.reasoning,
      strengths: scoreResult.strengths,
      gaps: scoreResult.gaps,
      breakdown: scoreResult.breakdown as unknown as Prisma.InputJsonValue,
      modelUsed: scoreResult.modelUsed,
    },
    update: {
      score: scoreResult.score,
      reasoning: scoreResult.reasoning,
      strengths: scoreResult.strengths,
      gaps: scoreResult.gaps,
      breakdown: scoreResult.breakdown as unknown as Prisma.InputJsonValue,
      modelUsed: scoreResult.modelUsed,
      // scoredAt only defaults on INSERT — a re-assign must stamp it explicitly or the row
      // keeps the original ingestion time while showing a freshly computed score.
      scoredAt: new Date(),
    },
  });

  // Denormalized score — skipped while a recruiter override is sticky (TO-58). updateMany
  // keeps the guard atomic, matching the ingestion and reassignment paths.
  await prisma.candidate.updateMany({
    where: { id: candidateId, isScoreOverridden: false },
    data: { aiScore: scoreResult.score },
  });

  return { outcome: 'scored', score: scoreResult.score };
}
