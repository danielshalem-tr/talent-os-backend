import { Controller, Get } from '@nestjs/common';
import { AppConfigService } from './app-config.service';

@Controller('config')
export class AppConfigController {
  constructor(private readonly appConfigService: AppConfigService) {}

  @Get()
  getConfig() {
    return this.appConfigService.getConfig();
  }
}
