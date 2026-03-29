import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScoringAgentService } from './scoring.service';
import { JobTitleMatcherService } from './job-title-matcher.service';

@Module({
  imports: [ConfigModule],
  providers: [ScoringAgentService, JobTitleMatcherService],
  exports: [ScoringAgentService, JobTitleMatcherService],
})
export class ScoringModule {}
