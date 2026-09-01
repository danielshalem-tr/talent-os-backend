import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../prisma/prisma.module';
import { BulkAssignService } from './bulk-assign.service';
import { BULK_ASSIGN_QUEUE } from './bulk-assign.types';

/**
 * Queue registration + the enqueue service. NO processor here: a @Processor provider
 * consumes the queue in every process that instantiates it, so the consumer must stay
 * in bulk-assign-worker.module.ts (same split as voice-core / voice-worker).
 */
@Module({
  imports: [BullModule.registerQueue({ name: BULK_ASSIGN_QUEUE }), PrismaModule],
  providers: [BulkAssignService],
  exports: [BullModule, BulkAssignService],
})
export class BulkAssignCoreModule {}
