import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { IngestionProcessor } from './ingestion.processor';
import { SpamFilterService } from './services/spam-filter.service';
import { AttachmentExtractorService } from './services/attachment-extractor.service';
import { ExtractionAgentService } from './services/extraction-agent.service';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: 'ingest-email' }),
    StorageModule,
  ],
  providers: [
    IngestionProcessor,
    SpamFilterService,
    AttachmentExtractorService,
    ExtractionAgentService,
  ],
})
export class IngestionModule {}
