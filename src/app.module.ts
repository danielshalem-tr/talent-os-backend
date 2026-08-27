import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { LoggerModule } from 'nestjs-pino';
import { ThrottlerModule } from '@nestjs/throttler';
import { apiEnvSchema } from './config/env';
import { PrismaModule } from './prisma/prisma.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { CandidatesModule } from './candidates/candidates.module';
import { JobsModule } from './jobs/jobs.module';
import { ApplicationsModule } from './applications/applications.module';
import { AppConfigModule } from './config/app-config/app-config.module';
import { HealthModule } from './health/health.module';
import { AuthModule } from './auth/auth.module';
import { PmBridgeModule } from './pm-bridge/pm-bridge.module';
import { PmbTokenModule } from './pmb-token/pmb-token.module';
import { IngestControlModule } from './ingest-control/ingest-control.module';
import { VoiceModule } from './voice/voice.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (config) => apiEnvSchema.parse(config),
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        transport:
          process.env.NODE_ENV !== 'production'
            ? { target: 'pino-pretty', options: { colorize: true, singleLine: true } }
            : undefined,
        level: process.env.LOG_LEVEL ?? 'info',
        redact: ['req.headers.authorization', 'req.headers.cookie'],
      },
    }),
    // D-15: Rate limiting — 100 requests per 60-second window per IP
    ThrottlerModule.forRoot([{
      ttl: 60000,
      limit: 100,
    }]),
    PrismaModule,
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        connection: {
          url: configService.get<string>('REDIS_URL'),
        },
      }),
    }),
    WebhooksModule,
    CandidatesModule,
    JobsModule,
    ApplicationsModule,
    AppConfigModule,
    HealthModule,
    AuthModule,
    PmBridgeModule,
    PmbTokenModule,
    IngestControlModule,
    VoiceModule,
  ],
})
export class AppModule {}
