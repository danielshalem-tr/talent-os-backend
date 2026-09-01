import { Module } from '@nestjs/common';
import { CandidatesController } from './candidates.controller';
import { CandidatesService } from './candidates.service';
import { CandidateAiService } from './candidate-ai.service';
import { PrismaModule } from '../prisma/prisma.module';
import { StorageModule } from '../storage/storage.module';
import { ScoringModule } from '../scoring/scoring.module';
import { AuthModule } from '../auth/auth.module';
import { AttachmentExtractorService } from '../ingestion/services/attachment-extractor.service';
import { BulkAssignCoreModule } from '../bulk-assign/bulk-assign-core.module';

@Module({
  imports: [PrismaModule, StorageModule, ScoringModule, AuthModule, BulkAssignCoreModule],
  controllers: [CandidatesController],
  // AttachmentExtractorService has no injected deps, so provide it directly rather than
  // importing IngestionModule (which registers a Bull queue).
  providers: [CandidatesService, CandidateAiService, AttachmentExtractorService],
  exports: [CandidatesService, CandidateAiService],
})
export class CandidatesModule {}
