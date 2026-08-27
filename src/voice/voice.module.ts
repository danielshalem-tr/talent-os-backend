import { Module } from '@nestjs/common';
import { VoiceCoreModule } from './voice-core.module';
import { VoiceCallsController } from './voice-calls.controller';
import { VoiceControlController } from './voice-control.controller';
import { VoiceWebhookController } from './voice-webhook.controller';
import { ElevenLabsWebhookGuard } from './elevenlabs-webhook.guard';

/** API-process module: HTTP surface over VoiceCoreModule. Imported only by app.module.ts. */
@Module({
  imports: [VoiceCoreModule],
  controllers: [VoiceCallsController, VoiceControlController, VoiceWebhookController],
  providers: [ElevenLabsWebhookGuard],
})
export class VoiceModule {}
