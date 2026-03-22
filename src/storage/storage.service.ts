import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PostmarkAttachmentDto } from '../webhooks/dto/postmark-payload.dto';

@Injectable()
export class StorageService {
  constructor(private readonly config: ConfigService) {}

  async upload(
    attachments: PostmarkAttachmentDto[],
    tenantId: string,
    messageId: string,
  ): Promise<string | null> {
    throw new Error('not implemented');
  }
}
