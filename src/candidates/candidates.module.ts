import { Module } from '@nestjs/common';
import { CandidatesController } from './candidates.controller';
import { CandidatesService } from './candidates.service';
import { CandidateAiService } from './candidate-ai.service';
import { PrismaModule } from '../prisma/prisma.module';
import { StorageModule } from '../storage/storage.module';
import { ScoringModule } from '../scoring/scoring.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [PrismaModule, StorageModule, ScoringModule, AuthModule],
  controllers: [CandidatesController],
  providers: [CandidatesService, CandidateAiService],
})
export class CandidatesModule {}
