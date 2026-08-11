import { BadRequestException, Body, Controller, Get, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import { JwtPayload } from '../auth/jwt.service';
import { IngestControlService } from './ingest-control.service';

// ThrottlerGuard is opt-in per controller in this app (see webhooks.controller.ts) — replay
// enqueues jobs, so rate-limit the whole controller.
@UseGuards(ThrottlerGuard)
@Controller('ingest-control')
export class IngestControlController {
  constructor(private readonly ingestControl: IngestControlService) {}

  @Get()
  getStatus(@Req() req: Request) {
    return this.ingestControl.getStatus(req.session as JwtPayload);
  }

  @Patch()
  setEnabled(@Req() req: Request, @Body('ai_ingest_enabled') enabled: unknown) {
    // No global ValidationPipe in this app — validate inline. Without this, a missing or
    // typo'd body would coerce to `false` and silently PAUSE ingest.
    if (typeof enabled !== 'boolean') {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'ai_ingest_enabled must be a boolean' });
    }
    return this.ingestControl.setEnabled(req.session as JwtPayload, enabled);
  }

  @Get('held')
  listHeld(@Req() req: Request) {
    return this.ingestControl.listHeld(req.session as JwtPayload);
  }

  @Post('replay')
  replay(@Req() req: Request) {
    return this.ingestControl.replayHeld(req.session as JwtPayload);
  }
}
