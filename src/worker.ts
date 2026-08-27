import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  // Defense in depth: the API pins Asia/Jerusalem in main.ts; the worker container runs UTC.
  // Voice call-window math never relies on ambient TZ (it uses Intl with an explicit zone),
  // but log timestamps shouldn't drift 2–3 hours from the API's.
  process.env.TZ = process.env.TZ ?? 'Asia/Jerusalem';
  const app = await NestFactory.createApplicationContext(WorkerModule);
  const logger = new Logger('Worker');
  logger.log('BullMQ Worker started');
  app.enableShutdownHooks();
}
bootstrap();
