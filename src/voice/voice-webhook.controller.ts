import { BadRequestException, Controller, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { ElevenLabsWebhookGuard } from './elevenlabs-webhook.guard';
import { ElevenLabsWebhookSchema } from './dto/elevenlabs-webhook.dto';
import { VoiceResultsService } from './voice-results.service';

@Controller('webhooks')
export class VoiceWebhookController {
  constructor(private readonly voiceResults: VoiceResultsService) {}

  // @Public(): authenticated by HMAC signature (ElevenLabsWebhookGuard), not a session cookie.
  @Public()
  @UseGuards(ElevenLabsWebhookGuard, ThrottlerGuard)
  @Post('elevenlabs')
  @HttpCode(HttpStatus.OK)
  async handle(@Req() req: Request): Promise<{ status: string }> {
    const result = ElevenLabsWebhookSchema.safeParse(req.body);
    if (!result.success) {
      throw new BadRequestException({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid ElevenLabs payload', details: result.error.flatten().fieldErrors },
      });
    }
    // handleWebhookEvent never throws — unknown conversations and handler failures are
    // logged and answered 200 (ElevenLabs disables webhooks after repeated 5xx).
    await this.voiceResults.handleWebhookEvent(result.data);
    return { status: 'ok' };
  }
}
