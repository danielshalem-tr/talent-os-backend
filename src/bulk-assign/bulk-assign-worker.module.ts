import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ScoringModule } from '../scoring/scoring.module';
import { BulkAssignCoreModule } from './bulk-assign-core.module';
import { BulkAssignProcessor } from './bulk-assign.processor';

/** Worker-process-only: imported exclusively by worker.module.ts. */
@Module({
  imports: [BulkAssignCoreModule, PrismaModule, ScoringModule],
  providers: [BulkAssignProcessor],
})
export class BulkAssignWorkerModule {}
