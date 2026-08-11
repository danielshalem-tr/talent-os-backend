import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { IngestControlController } from './ingest-control.controller';
import { IngestControlService } from './ingest-control.service';

@Module({
  imports: [BullModule.registerQueue({ name: 'ingest-email' })],
  controllers: [IngestControlController],
  providers: [IngestControlService],
})
export class IngestControlModule {}
