import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { PostmarkAuthGuard } from './guards/postmark-auth.guard';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [BullModule.registerQueue({ name: 'ingest-email' }), StorageModule],
  controllers: [WebhooksController],
  providers: [WebhooksService, PostmarkAuthGuard],
})
export class WebhooksModule {}
