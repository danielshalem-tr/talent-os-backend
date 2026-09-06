import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

describe('WebhooksController', () => {
  let controller: WebhooksController;
  let mockWebhooksService: Partial<WebhooksService>;

  const VALID_HEADERS = JSON.stringify([['Message-Id', '<msg-xyz-456@example.com>']]);

  function buildMockReq(overrides: Record<string, unknown> = {}, files: unknown[] = []) {
    return {
      body: {
        timestamp: '1748000000',
        token: 'a'.repeat(50),
        signature: 'b'.repeat(64),
        from: 'applicant@example.com',
        subject: 'Applying for Engineer role',
        'message-headers': VALID_HEADERS,
        ...overrides,
      },
      files,
    };
  }

  beforeEach(async () => {
    mockWebhooksService = {
      enqueue: jest.fn().mockResolvedValue({ status: 'queued' }),
      recordRejected: jest.fn().mockResolvedValue({ status: 'rejected' }),
      checkHealth: jest.fn().mockResolvedValue({ status: 'ok', db: 'ok', redis: 'ok' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }])],
      controllers: [WebhooksController],
      providers: [{ provide: WebhooksService, useValue: mockWebhooksService }],
    }).compile();

    controller = module.get<WebhooksController>(WebhooksController);
  });

  describe('POST /webhooks/email', () => {
    it('normalizes Mailgun payload and calls enqueue with EmailPayloadDto', async () => {
      const result = await controller.ingestEmail(buildMockReq() as any);
      expect(result).toEqual({ status: 'queued' });
      expect(mockWebhooksService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          MessageID: 'msg-xyz-456@example.com',
          From: 'applicant@example.com',
          Subject: 'Applying for Engineer role',
        }),
        [],
      );
    });

    it('records a rejected row and answers 200 when the payload fails validation', async () => {
      const req = buildMockReq({ timestamp: undefined });
      await expect(controller.ingestEmail(req as any)).resolves.toEqual({ status: 'rejected' });
      expect(mockWebhooksService.recordRejected).toHaveBeenCalledWith(req.body, expect.stringMatching(/^payload rejected: /));
      expect(mockWebhooksService.enqueue).not.toHaveBeenCalled();
    });

    it('records a rejected row when from is missing', async () => {
      const req = buildMockReq({ from: undefined });
      await expect(controller.ingestEmail(req as any)).resolves.toEqual({ status: 'rejected' });
      expect(mockWebhooksService.enqueue).not.toHaveBeenCalled();
    });

    it('records a rejected row when message-headers is invalid JSON', async () => {
      const req = buildMockReq({ 'message-headers': 'not-json' });
      await expect(controller.ingestEmail(req as any)).resolves.toEqual({ status: 'rejected' });
      expect(mockWebhooksService.enqueue).not.toHaveBeenCalled();
    });

    it('records a rejected row and answers 200 when multer hit a limit', async () => {
      const req = { ...buildMockReq(), multerError: Object.assign(new Error('Too many files'), { code: 'LIMIT_FILE_COUNT' }) };
      await expect(controller.ingestEmail(req as any)).resolves.toEqual({ status: 'rejected' });
      expect(mockWebhooksService.recordRejected).toHaveBeenCalledWith(req.body, 'multipart rejected: LIMIT_FILE_COUNT');
    });

    it('passes the multer files to enqueue alongside the normalized payload', async () => {
      const files = [{ fieldname: 'attachment-1', originalname: 'cv.pdf', mimetype: 'application/pdf', size: 3, buffer: Buffer.from('pdf') }];
      await controller.ingestEmail(buildMockReq({}, files) as any);
      expect(mockWebhooksService.enqueue).toHaveBeenCalledWith(expect.objectContaining({ MessageID: 'msg-xyz-456@example.com' }), files);
    });

    it('maps uploaded files to base64 attachments and passes them to enqueue', async () => {
      const fakeFile = {
        originalname: 'cv.pdf',
        mimetype: 'application/pdf',
        size: 2048,
        buffer: Buffer.from('pdf-content'),
      };
      await controller.ingestEmail(buildMockReq({}, [fakeFile]) as any);
      const called = (mockWebhooksService.enqueue as jest.Mock).mock.calls[0][0];
      expect(called.Attachments).toHaveLength(1);
      expect(called.Attachments[0].Name).toBe('cv.pdf');
      expect(called.Attachments[0].Content).toBe(Buffer.from('pdf-content').toString('base64'));
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
