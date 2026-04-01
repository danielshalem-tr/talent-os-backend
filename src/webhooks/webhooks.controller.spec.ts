import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { PostmarkPayloadDto } from './dto/postmark-payload.dto';

describe('WebhooksController', () => {
  let controller: WebhooksController;
  let mockWebhooksService: Partial<WebhooksService>;

  const validPayload: PostmarkPayloadDto = {
    MessageID: 'msg-xyz-456',
    From: 'applicant@example.com',
    Subject: 'Applying for Engineer role',
    Date: '2026-03-22T12:00:00Z',
    Attachments: [],
  };

  beforeEach(async () => {
    mockWebhooksService = {
      enqueue: jest.fn().mockResolvedValue({ status: 'queued' }),
      checkHealth: jest.fn().mockResolvedValue({ status: 'ok', db: 'ok', redis: 'ok' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }])],
      controllers: [WebhooksController],
      providers: [
        {
          provide: WebhooksService,
          useValue: mockWebhooksService,
        },
      ],
    }).compile();

    controller = module.get<WebhooksController>(WebhooksController);
  });

  describe('POST /webhooks/email', () => {
    it('returns 200 with { status: "queued" } on valid payload', async () => {
      const result = await controller.ingestEmail(validPayload);
      expect(result).toEqual({ status: 'queued' });
      expect(mockWebhooksService.enqueue).toHaveBeenCalledWith(validPayload);
    });
  });

  describe('GET /health', () => {
    it('returns { status: "ok", db: "ok", redis: "ok" }', async () => {
      const result = await controller.health();
      expect(result).toEqual({ status: 'ok', db: 'ok', redis: 'ok' });
      expect(mockWebhooksService.checkHealth).toHaveBeenCalled();
    });
  });
});
