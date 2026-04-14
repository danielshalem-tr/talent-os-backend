import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { SessionGuard } from '../auth/session.guard';
import { ApplicationsService } from './applications.service';

@UseGuards(SessionGuard)
@Controller('applications')
export class ApplicationsController {
  constructor(private readonly applicationsService: ApplicationsService) {}

  @Get()
  async findAll(@Req() req: Request) {
    const tenantId = req.session!.org;
    return this.applicationsService.findAll(tenantId);
  }
}
