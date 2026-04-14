import { Controller, Get, UseGuards } from '@nestjs/common';
import { SessionGuard } from '../../auth/session.guard';
import { AppConfigService } from './app-config.service';

@UseGuards(SessionGuard)
@Controller('config')
export class AppConfigController {
  constructor(private readonly appConfigService: AppConfigService) {}

  @Get()
  getConfig() {
    return this.appConfigService.getConfig();
  }
}
