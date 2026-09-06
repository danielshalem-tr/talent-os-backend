import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { MailgunAuthGuard } from './guards/mailgun-auth.guard';
import { StorageModule } from '../storage/storage.module';
import { mailgunMultipart } from './multipart';

@Module({
  imports: [BullModule.registerQueue({ name: 'ingest-email' }), StorageModule],
  controllers: [WebhooksController],
  providers: [WebhooksService, MailgunAuthGuard],
})
export class WebhooksModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(mailgunMultipart())
      .forRoutes({ path: 'webhooks/email', method: RequestMethod.POST });
  }
}
