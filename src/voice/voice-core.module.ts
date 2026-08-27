import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { StorageModule } from '../storage/storage.module';
import { VoiceCallsService } from './voice-calls.service';
import { VoiceResultsService } from './voice-results.service';
import { ElevenLabsGatewayService } from './elevenlabs-gateway.service';

/**
 * Queue registration + services only — NO controllers (API concern, voice.module.ts) and
 * NO processor (worker concern, voice-worker.module.ts). Importable from both processes:
 * a @Processor provider consumes the queue in every process that instantiates it, so the
 * consumer must never live here.
 */
@Module({
  imports: [BullModule.registerQueue({ name: 'voice-call' }), StorageModule],
  providers: [VoiceCallsService, VoiceResultsService, ElevenLabsGatewayService],
  exports: [BullModule, VoiceCallsService, VoiceResultsService, ElevenLabsGatewayService],
})
export class VoiceCoreModule {}
