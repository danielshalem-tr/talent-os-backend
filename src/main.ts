import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cookieParser = require('cookie-parser');
import { AppModule } from './app.module';

async function bootstrap() {
  process.env.TZ = process.env.TZ ?? 'Asia/Jerusalem';

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    // Parsers registered explicitly below so the ElevenLabs post-call webhook (large
    // transcript JSON) fits — the express default is 100kb. useBodyParser keeps
    // req.rawBody working because the app was created with rawBody: true.
    bodyParser: false,
    bufferLogs: true,
  });

  app.useBodyParser('json', { limit: '2mb' });
  app.useBodyParser('urlencoded', { extended: true, limit: '2mb' });

  app.useLogger(app.get(Logger));

  // Exactly one proxy (Coolify's Traefik) sits in front of the API, so trust that single
  // hop: req.ip becomes the real client IP from X-Forwarded-For instead of the proxy's,
  // which is what ThrottlerGuard keys rate limits on. More hops would need a higher count.
  app.set('trust proxy', 1);

  // D-14: HTTP security headers (XSS protection, clickjacking prevention, MIME sniffing)
  app.use(helmet());

  // Phase 19: parse cookies so SessionGuard can read talent_os_session (D-16)
  app.use(cookieParser());

  // Phase 19: CORS must allow FRONTEND_URL with credentials so cookies are sent (D-03)
  const isDev = process.env.NODE_ENV === 'development';
  const frontendUrl = process.env.FRONTEND_URL ?? (isDev ? 'http://localhost:5173' : 'https://talentos.triolla.io');
  app.enableCors({
    origin: frontendUrl,
    credentials: true, // required for cookie-based auth
  });

  // Global /api prefix — must be set BEFORE app.listen()
  app.setGlobalPrefix('api');

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
