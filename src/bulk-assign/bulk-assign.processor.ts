import { Injectable } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger as PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { ScoringAgentService } from '../scoring/scoring.service';
import { assignCandidateToJob } from './assign-candidate';
import { AssignJobData, BULK_ASSIGN_QUEUE } from './bulk-assign.types';

@Injectable()
@Processor(BULK_ASSIGN_QUEUE, {
  // One scoring call per job; the ingest processor uses 30s for a loop of them.
  lockDuration: 60000,
  lockRenewTime: 5000,
  maxStalledCount: 2,
})
export class BulkAssignProcessor extends WorkerHost {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scoringAgent: ScoringAgentService,
    private readonly pinoLogger: PinoLogger,
  ) {
    super();
  }

  async process(job: Job<AssignJobData>): Promise<void> {
    const { tenantId, candidateId, jobId } = job.data;
    const result = await assignCandidateToJob(this.prisma, this.scoringAgent, { tenantId, candidateId, jobId });
    this.pinoLogger.log({ tenantId, candidateId, jobId, ...result }, 'Bulk assign processed');
  }
}
