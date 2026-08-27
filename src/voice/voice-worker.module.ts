import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { VoiceCoreModule } from './voice-core.module';
import { VoiceCallProcessor } from './voice-call.processor';

/** Worker-process-only: imported exclusively by worker.module.ts. */
@Module({
  imports: [VoiceCoreModule, StorageModule],
  providers: [VoiceCallProcessor],
})
export class VoiceWorkerModule {}
