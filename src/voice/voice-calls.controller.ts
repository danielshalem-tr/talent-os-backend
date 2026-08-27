import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { JwtPayload } from '../auth/jwt.service';
import { VoiceCallsService } from './voice-calls.service';
import { TriggerCallSchema } from './dto/trigger-call.dto';

// Session enforcement comes from the global APP_GUARD SessionGuard (ingest-control pattern).
// ThrottlerGuard added controller-wide: POST endpoints trigger paid external calls.
@UseGuards(ThrottlerGuard)
@Controller('candidates')
export class VoiceCallsController {
  constructor(private readonly voiceCalls: VoiceCallsService) {}

  @Get(':id/calls')
  listCalls(@Param('id') candidateId: string, @Req() req: Request) {
    return this.voiceCalls.listCalls(candidateId, req.session!.org);
  }

  @Post(':id/call')
  @HttpCode(HttpStatus.CREATED)
  triggerCall(@Param('id') candidateId: string, @Body() body: unknown, @Req() req: Request) {
    const result = TriggerCallSchema.safeParse(body);
    if (!result.success) {
      throw new BadRequestException({
        error: { code: 'VALIDATION_ERROR', message: 'job_id (UUID) is required', details: result.error.flatten().fieldErrors },
      });
    }
    return this.voiceCalls.triggerManualCall(candidateId, result.data.job_id, req.session as JwtPayload);
  }

  @Post(':id/calls/:callId/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(@Param('id') candidateId: string, @Param('callId') callId: string, @Req() req: Request) {
    return this.voiceCalls.cancelCall(candidateId, callId, req.session as JwtPayload);
  }

  /**
   * Stream the recording same-origin (cv-file pattern verbatim: candidates.controller.ts:92-107).
   * Content type is pinned to audio/mpeg — we wrote the object ourselves in uploadVoiceAudio.
   */
  @Get(':id/calls/:callId/audio')
  async audio(
    @Param('id') candidateId: string,
    @Param('callId') callId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const body = await this.voiceCalls.getAudioBytes(candidateId, callId, req.session!.org);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', 'inline; filename="screening-call.mp3"');
    res.setHeader('Content-Length', body.length);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.end(body);
  }
}
