import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap() {
  process.env.TZ = process.env.TZ ?? 'Asia/Jerusalem';

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    bodyParser: true,
  });

  // Postmark sends CV attachments as base64 inside JSON — a 2 MB PDF becomes ~2.7 MB.
  // Default Express limit is 100 KB which rejects most real CVs.
  app.useBodyParser('json', { limit: '10mb' });
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
