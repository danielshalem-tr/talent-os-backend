import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { IngestionProcessor } from './ingestion.processor';
import { SpamFilterService } from './services/spam-filter.service';
import { AttachmentExtractorService } from './services/attachment-extractor.service';
import { ExtractionAgentService } from './services/extraction-agent.service';
import { StorageModule } from '../storage/storage.module';
import { DedupModule } from '../dedup/dedup.module';
import { ScoringModule } from '../scoring/scoring.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: 'ingest-email' }),
    StorageModule,
    DedupModule,  // provides DedupService to IngestionProcessor
    ScoringModule, // provides ScoringAgentService to IngestionProcessor (Phase 7)
  ],
  providers: [
    IngestionProcessor,
    SpamFilterService,
    AttachmentExtractorService,
    ExtractionAgentService,
  ],
})
export class IngestionModule {}
