import { BadRequestException, Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import { JwtPayload } from '../auth/jwt.service';
import { VoiceCallsService } from './voice-calls.service';

@UseGuards(ThrottlerGuard)
@Controller('voice-control')
export class VoiceControlController {
  constructor(private readonly voiceCalls: VoiceCallsService) {}

  @Get('status')
  getStatus(@Req() req: Request) {
    return this.voiceCalls.getStatus(req.session as JwtPayload);
  }

  @Put('enabled')
  setEnabled(@Req() req: Request, @Body('voice_calls_enabled') enabled: unknown) {
    // No global ValidationPipe — validate inline. A typo'd body must never coerce to false
    // and silently flip the kill switch (same rationale as ingest-control.controller.ts).
    if (typeof enabled !== 'boolean') {
      throw new BadRequestException({
        error: { code: 'VALIDATION_ERROR', message: 'voice_calls_enabled must be a boolean' },
      });
    }
    return this.voiceCalls.setEnabled(req.session as JwtPayload, enabled);
  }
}
