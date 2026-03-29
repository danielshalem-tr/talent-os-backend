import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScoringAgentService } from './scoring_agent.service';
import { JobTitleMatcherService } from './job-title-matcher.service';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [ConfigModule, PrismaModule],
  providers: [ScoringAgentService, JobTitleMatcherService],
  exports: [ScoringAgentService],
})
export class ScoringModule {}
