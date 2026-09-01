import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The single source of truth for moving a candidate between hiring stages — used by the
 * kanban (PUT /candidates/:id/stage) and MCP move_candidate_stage via
 * CandidatesService.updateStage, and by the voice assess worker. A plain function (not a
 * provider) so the worker can use it without importing CandidatesModule → AuthModule,
 * whose global APP_GUARD must never register in the worker (auth.module.ts).
 */
export async function moveCandidateToStage(
  prisma: PrismaService,
  candidateId: string,
  hiringStageId: string,
  tenantId: string,
): Promise<void> {
  // 1. Find the candidate and verify ownership
  const candidate = await prisma.candidate.findFirst({
    where: { id: candidateId, tenantId },
    select: { id: true, jobId: true },
  });

  if (!candidate) {
    throw new NotFoundException({
      error: { code: 'NOT_FOUND', message: 'Candidate not found' },
    });
  }

  if (!candidate.jobId) {
    throw new BadRequestException({
      error: { code: 'NO_JOB', message: 'Candidate is not linked to a job' },
    });
  }

  // 2. Validate the target stage belongs to the candidate's job
  const stage = await prisma.jobStage.findFirst({
    where: {
      id: hiringStageId,
      jobId: candidate.jobId,
      tenantId,
    },
  });

  if (!stage) {
    throw new NotFoundException({
      error: {
        code: 'STAGE_NOT_FOUND',
        message: 'Hiring stage not found for this job',
      },
    });
  }

  // 3. Atomic update: candidate.hiringStageId + application.jobStageId
  await prisma.$transaction(async (tx) => {
    // Update the candidate's current stage
    await tx.candidate.update({
      where: { id: candidateId },
      data: { hiringStageId },
    });

    // Sync the matching application record
    await tx.application.updateMany({
      where: {
        candidateId,
        jobId: candidate.jobId!,
        tenantId,
      },
      data: { jobStageId: hiringStageId },
    });
  });
}
