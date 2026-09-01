import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { IngestionProcessor } from './ingestion.processor';
import { SpamFilterService } from './services/spam-filter.service';
import { AttachmentExtractorService } from './services/attachment-extractor.service';
import { ExtractionAgentService } from './services/extraction-agent.service';
import { CvClassifierService } from './services/cv-classifier.service';
import { JobMatcherService } from './services/job-matcher.service';
import { StorageModule } from '../storage/storage.module';
import { DedupModule } from '../dedup/dedup.module';
import { ScoringModule } from '../scoring/scoring.module';
import { VoiceCoreModule } from '../voice/voice-core.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: 'ingest-email' }),
    StorageModule,
    DedupModule,  // provides DedupService to IngestionProcessor
    ScoringModule, // provides ScoringAgentService to IngestionProcessor (Phase 7)
    VoiceCoreModule, // provides VoiceCallsService for the post-scoring voice seam
  ],
  providers: [
    IngestionProcessor,
    SpamFilterService,
    AttachmentExtractorService,
    ExtractionAgentService,
    CvClassifierService,
    JobMatcherService,
  ],
})
export class IngestionModule {}
