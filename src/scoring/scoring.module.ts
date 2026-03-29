import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScoringAgentService } from './scoring.service';

@Module({
  imports: [ConfigModule],
  providers: [ScoringAgentService],
  exports: [ScoringAgentService],
})
export class ScoringModule {}
