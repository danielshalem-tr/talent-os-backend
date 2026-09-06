import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { StorageService } from './storage.service';
import { EmailAttachmentDto } from '../webhooks/dto/mailgun-payload.dto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const mockS3Send = jest.fn();

jest.mock('@aws-sdk/client-s3', () => {
  const actual = jest.requireActual('@aws-sdk/client-s3');
  return {
    ...actual,
    S3Client: jest.fn().mockImplementation(() => ({
      send: mockS3Send,
    })),
  };
});

const mockConfigService = {
  get: jest.fn((key: string) => {
    const vars: Record<string, string> = {
      R2_ACCOUNT_ID: 'test-account',
      R2_ACCESS_KEY_ID: 'test-key',
      R2_SECRET_ACCESS_KEY: 'test-secret',
      R2_BUCKET_NAME: 'test-bucket',
    };
    return vars[key];
  }),
};

describe('StorageService', () => {
  let service: StorageService;

  beforeEach(async () => {
    mockS3Send.mockReset();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StorageService,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();
    service = module.get<StorageService>(StorageService);
  });

  const pdfAttachment = (): EmailAttachmentDto => ({
    Name: 'cv.pdf',
    ContentType: 'application/pdf',
    ContentLength: 150000,
    Content: Buffer.from('PDF data').toString('base64'),
  });

  const docxAttachment = (): EmailAttachmentDto => ({
    Name: 'cv.docx',
    ContentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ContentLength: 100000,
    Content: Buffer.from('DOCX data').toString('base64'),
  });

  const pngAttachment = (): EmailAttachmentDto => ({
    Name: 'signature.png',
    ContentType: 'image/png',
    ContentLength: 5000,
    Content: Buffer.from('PNG data').toString('base64'),
  });

  it('STOR-01: uploads largest PDF to R2 with correct key format', async () => {
    mockS3Send.mockResolvedValue({});

    const key = await service.upload(
      [pngAttachment(), pdfAttachment()],
      'tenant-123',
      'msg-456',
    );

    expect(key).toBe('cvs/tenant-123/msg-456.pdf');
    expect(mockS3Send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          Key: 'cvs/tenant-123/msg-456.pdf',
          Bucket: 'test-bucket',
          ContentType: 'application/pdf',
        }),
      }),
    );
  });

  it('STOR-01: returns null if no PDF/DOCX attachment found (D-02)', async () => {
    const key = await service.upload([pngAttachment()], 'tenant-123', 'msg-456');

    expect(key).toBeNull();
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it('STOR-02: does NOT return presigned URL, only object key', async () => {
    mockS3Send.mockResolvedValue({});

    const key = await service.upload([pdfAttachment()], 'tenant-123', 'msg-456');

    expect(key).not.toContain('https://');
    expect(key).not.toContain('r2.cloudflarestorage.com');
    expect(key).toMatch(/^cvs\/[^/]+\/[^/]+\.(pdf|docx)$/);
  });

  it('D-11: sets explicit ContentType on PutObjectCommand', async () => {
    mockS3Send.mockResolvedValue({});

    await service.upload([docxAttachment()], 'tenant-123', 'msg-456');

    expect(mockS3Send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          ContentType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        }),
      }),
    );
  });

  it('D-07: propagates R2 errors to caller (no catch)', async () => {
    mockS3Send.mockRejectedValue(new Error('R2 temporarily unavailable'));

    await expect(
      service.upload([pdfAttachment()], 'tenant-123', 'msg-456'),
    ).rejects.toThrow('R2 temporarily unavailable');
  });

  it('stores an octet-stream .pdf under a .pdf key with the real content type', async () => {
    mockS3Send.mockResolvedValue({});
    const key = await service.upload(
      [{ Name: 'Dana CV.pdf', ContentType: 'application/octet-stream', ContentLength: 5000, Content: Buffer.from('%PDF-1.4 x').toString('base64') }],
      'tenant-1',
      'msg-1',
    );
    expect(key).toBe('cvs/tenant-1/msg-1.pdf');
    const cmd = mockS3Send.mock.calls[0][0] as PutObjectCommand;
    expect(cmd.input.ContentType).toBe('application/pdf');
  });

  it('keeps a legacy .doc CV so the recruiter can download it', async () => {
    mockS3Send.mockResolvedValue({});
    const key = await service.upload(
      [{ Name: 'cv.doc', ContentType: 'application/msword', ContentLength: 5000, Content: Buffer.from('doc').toString('base64') }],
      'tenant-1',
      'msg-2',
    );
    expect(key).toBe('cvs/tenant-1/msg-2.doc');
  });

  it('uses the raw buffer for the selected attachment when provided', async () => {
    mockS3Send.mockResolvedValue({});
    const raw = Buffer.from('%PDF-raw');
    await service.upload([pngAttachment(), pdfAttachment()], 'tenant-1', 'msg-3', [Buffer.from('png'), raw]);
    const cmd = mockS3Send.mock.calls[0][0] as PutObjectCommand;
    expect(cmd.input.Body).toBe(raw);
  });

  describe('uploadPayload / downloadPayload', () => {
    it('uploadPayload calls PutObjectCommand with correct key and JSON body', async () => {
      mockS3Send.mockResolvedValue({});
      const payload = { MessageID: 'msg-1', From: 'a@b.com' } as any;

      const key = await service.uploadPayload(payload, 'tenant-1', 'msg-1');

      expect(key).toBe('emails/tenant-1/msg-1/payload.json');
      expect(mockS3Send).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            Key: 'emails/tenant-1/msg-1/payload.json',
            ContentType: 'application/json',
          }),
        }),
      );
    });

    it('downloadPayload fetches and parses the payload from R2', async () => {
      const payload = { MessageID: 'msg-1', From: 'a@b.com' };
      mockS3Send.mockResolvedValue({
        Body: { transformToString: jest.fn().mockResolvedValue(JSON.stringify(payload)) },
      });

      const result = await service.downloadPayload('tenant-1', 'msg-1');

      expect(result).toEqual(payload);
      expect(mockS3Send).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({ Key: 'emails/tenant-1/msg-1/payload.json' }),
        }),
      );
    });
  });

  describe('saveExtractionCache / loadExtractionCache', () => {
    it('saveExtractionCache calls PutObjectCommand with key emails/t/m/extraction.json', async () => {
      mockS3Send.mockResolvedValue({});
      const result = { full_name: 'Dana Cohen', email: null };

      await service.saveExtractionCache(result, 't', 'm');

      expect(mockS3Send).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            Key: 'emails/t/m/extraction.json',
            Bucket: 'test-bucket',
            ContentType: 'application/json',
          }),
        }),
      );
    });

    it('loadExtractionCache returns parsed JSON on cache hit', async () => {
      const cached = { full_name: 'Cached Name', email: null };
      mockS3Send.mockResolvedValue({
        Body: { transformToString: jest.fn().mockResolvedValue(JSON.stringify(cached)) },
      });

      const result = await service.loadExtractionCache('tenant-1', 'msg-1');

      expect(result).toEqual(cached);
      expect(mockS3Send).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({ Key: 'emails/tenant-1/msg-1/extraction.json' }),
        }),
      );
    });

    it('loadExtractionCache returns null on NoSuchKey error', async () => {
      const noSuchKeyError = new Error('NoSuchKey');
      noSuchKeyError.name = 'NoSuchKey';
      mockS3Send.mockRejectedValue(noSuchKeyError);

      const result = await service.loadExtractionCache('tenant-1', 'msg-1');

      expect(result).toBeNull();
    });
  });

  describe('saveClassificationCache / loadClassificationCache', () => {
    it('saveClassificationCache PUTs to key emails/t/m/classification.json as JSON', async () => {
      mockS3Send.mockResolvedValue({});
      const result = { verdict: 'not_cv', reason: 'invoice PDF' };

      await service.saveClassificationCache(result, 't', 'm');

      expect(mockS3Send).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            Key: 'emails/t/m/classification.json',
            Bucket: 'test-bucket',
            ContentType: 'application/json',
          }),
        }),
      );
    });

    it('loadClassificationCache returns parsed JSON on cache hit', async () => {
      const cached = { verdict: 'cv', reason: 'resume' };
      mockS3Send.mockResolvedValue({
        Body: { transformToString: jest.fn().mockResolvedValue(JSON.stringify(cached)) },
      });

      const result = await service.loadClassificationCache('tenant-1', 'msg-1');

      expect(result).toEqual(cached);
      expect(mockS3Send).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({ Key: 'emails/tenant-1/msg-1/classification.json' }),
        }),
      );
    });

    it('loadClassificationCache returns null on NoSuchKey error', async () => {
      const noSuchKeyError = new Error('NoSuchKey');
      noSuchKeyError.name = 'NoSuchKey';
      mockS3Send.mockRejectedValue(noSuchKeyError);

      const result = await service.loadClassificationCache('tenant-1', 'msg-1');

      expect(result).toBeNull();
    });
  });

  describe('getObject', () => {
    it('fetches raw bytes as a Buffer plus the stored ContentType', async () => {
      const raw = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
      const transformToByteArray = jest.fn().mockResolvedValue(raw);
      mockS3Send.mockResolvedValue({
        Body: { transformToByteArray },
        ContentType: 'application/pdf',
      });

      const result = await service.getObject('cvs/tenant-1/msg-1.pdf');

      expect(Buffer.isBuffer(result.body)).toBe(true);
      expect(result.body).toEqual(Buffer.from(raw));
      expect(result.contentType).toBe('application/pdf');
      expect(transformToByteArray).toHaveBeenCalledTimes(1);
      expect(mockS3Send).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({ Key: 'cvs/tenant-1/msg-1.pdf', Bucket: 'test-bucket' }),
        }),
      );
    });

    it('falls back to application/octet-stream when R2 omits ContentType', async () => {
      mockS3Send.mockResolvedValue({
        Body: { transformToByteArray: jest.fn().mockResolvedValue(new Uint8Array([1])) },
      });

      const result = await service.getObject('cvs/tenant-1/no-type.bin');

      expect(result.contentType).toBe('application/octet-stream');
    });

    it('propagates R2 errors to the caller (no swallow)', async () => {
      mockS3Send.mockRejectedValue(new Error('R2 unavailable'));

      await expect(service.getObject('cvs/tenant-1/msg-1.pdf')).rejects.toThrow('R2 unavailable');
    });
  });
});
