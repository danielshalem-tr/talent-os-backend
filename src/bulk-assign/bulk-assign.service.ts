import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { BulkAssignDto } from '../candidates/dto/bulk-assign.dto';
import { ASSIGN_JOB_OPTS, AssignJobData, BULK_ASSIGN_QUEUE } from './bulk-assign.types';

/**
 * API side of bulk assign. Validates once, then hands every candidate to the worker:
 * 200 candidates means up to 200 scoring calls, far past any HTTP timeout, so the
 * request returns 202 and the UI refreshes over SWR.
 */
@Injectable()
export class BulkAssignService {
  private readonly logger = new Logger(BulkAssignService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(BULK_ASSIGN_QUEUE) private readonly queue: Queue,
  ) {}

  async enqueue(tenantId: string, dto: BulkAssignDto): Promise<{ queued: number }> {
    const job = await this.prisma.job.findFirst({
      where: { id: dto.job_id, tenantId },
      select: { id: true, status: true },
    });
    if (!job) {
      throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'Job not found' } });
    }
    if (job.status !== 'open') {
      throw new BadRequestException({ error: { code: 'JOB_NOT_OPEN', message: 'Job is not open' } });
    }

    const firstStage = await this.prisma.jobStage.findFirst({
      where: { jobId: job.id, tenantId, isEnabled: true },
      select: { id: true },
    });
    if (!firstStage) {
      throw new BadRequestException({ error: { code: 'NO_STAGES', message: 'Job has no enabled stages' } });
    }

    const ids = [...new Set(dto.candidate_ids)];
    const candidates = await this.prisma.candidate.findMany({
      where: { id: { in: ids }, tenantId, status: 'active' },
      select: { id: true },
    });

    await Promise.all(
      candidates.map((candidate) =>
        this.queue.add(
          'assign',
          { tenantId, candidateId: candidate.id, jobId: job.id } satisfies AssignJobData,
          // Stable job id: clicking the button twice for the same selection collapses
          // into one queued job rather than paying for the scoring twice.
          { jobId: `assign-${candidate.id}-${job.id}`, ...ASSIGN_JOB_OPTS },
        ),
      ),
    );

    this.logger.log(`Bulk assign: queued ${candidates.length}/${ids.length} candidates for job ${job.id}`);
    return { queued: candidates.length };
  }
}
