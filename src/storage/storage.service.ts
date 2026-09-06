import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { EmailAttachmentDto, EmailPayloadDto } from '../webhooks';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { CvDocumentKind, detectCvDocument, extensionForKind, mimeForKind } from '../ingestion/document-detect';


@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly s3Client: S3Client;

  constructor(private readonly config: ConfigService) {
    this.s3Client = new S3Client({
      region: 'auto', // R2 uses 'auto' region (not a standard AWS region)
      credentials: {
        accessKeyId: this.config.get<string>('R2_ACCESS_KEY_ID')!,
        secretAccessKey: this.config.get<string>('R2_SECRET_ACCESS_KEY')!,
      },
      endpoint: `https://${this.config.get<string>('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
    });
  }

  // D-01, D-02, D-04, D-06, D-10, D-11
  async upload(
    attachments: EmailAttachmentDto[],
    tenantId: string,
    messageId: string,
    rawBuffers?: Buffer[],
  ): Promise<string | null> {
    // D-01: the largest CV document (PDF/DOCX/DOC by MIME, extension or magic bytes) — logos,
    // signatures and calendar parts never qualify.
    const selected = this.selectLargestCvAttachment(attachments);
    if (!selected) return null; // D-02: no qualifying file — job continues

    // D-10: key extension and D-11: ContentType come from the DETECTED kind, so an
    // `application/octet-stream` PDF is stored as `.pdf` + `application/pdf` and renders in-browser.
    const key = `cvs/${tenantId}/${messageId}${extensionForKind(selected.kind)}`;
    // rawBuffers[i] is the multer buffer for attachments[i] — skip the base64 round-trip when given.
    const index = attachments.indexOf(selected.att);
    const buffer = rawBuffers?.[index] ?? Buffer.from(selected.att.Content!, 'base64');

    const command = new PutObjectCommand({
      Bucket: this.config.get<string>('R2_BUCKET_NAME')!,
      Key: key,
      Body: buffer,
      ContentType: mimeForKind(selected.kind),
    });

    // D-07: Transient R2 errors propagate to the caller (webhook → 5xx → Mailgun retries).
    await this.s3Client.send(command);

    this.logger.log(`Uploaded ${key} to R2 (${buffer.length} bytes)`);
    return key; // D-04: object key only — NOT a presigned URL
  }

  getPresignedUrl(key: string, expiresIn = 3600): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.config.get<string>('R2_BUCKET_NAME')!,
      Key: key,
    });
    return getSignedUrl(this.s3Client, command, { expiresIn });
  }

  /**
   * Fetch an object's raw bytes from R2. Used to stream CV files back to the
   * browser same-origin (so the client can `fetch().arrayBuffer()` them for
   * in-browser rendering without depending on R2 CORS). CV files are small, so
   * buffering the whole object is fine.
   */
  async getObject(key: string): Promise<{ body: Buffer; contentType: string }> {
    const response = await this.s3Client.send(
      new GetObjectCommand({
        Bucket: this.config.get<string>('R2_BUCKET_NAME')!,
        Key: key,
      }),
    );
    if (!response.Body) {
      // A successful GetObject always carries a Body stream; guard so an edge/empty
      // response surfaces a clear error instead of a raw "undefined" TypeError.
      throw new Error(`R2 object ${key} returned no body`);
    }
    const bytes = await response.Body.transformToByteArray();
    return {
      body: Buffer.from(bytes),
      contentType: response.ContentType ?? 'application/octet-stream',
    };
  }

  // Upload from a raw buffer (used for UI-uploaded files)
  // D-02: cv_text stays null; returns R2 object key only (not presigned URL)
  async uploadFromBuffer(buffer: Buffer, mimetype: string, tenantId: string, candidateId: string): Promise<string> {
    const ALLOWED_MIME_TYPES = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ];

    if (!ALLOWED_MIME_TYPES.includes(mimetype)) {
      throw new BadRequestException({
        error: {
          code: 'INVALID_FILE_TYPE',
          message: `Invalid file type: ${mimetype}. Only PDF and Word documents are accepted.`,
        },
      });
    }

    const extension = this.getExtension(mimetype);
    const key = `cvs/${tenantId}/${candidateId}${extension}`;

    const command = new PutObjectCommand({
      Bucket: this.config.get<string>('R2_BUCKET_NAME')!,
      Key: key,
      Body: buffer,
      ContentType: mimetype,
    });

    await this.s3Client.send(command);

    this.logger.log(`Uploaded ${key} to R2 (${buffer.length} bytes)`);
    return key;
  }

  // Upload an org logo from a raw buffer with an explicit R2 key
  async uploadLogoFromBuffer(buffer: Buffer, mimetype: string, key: string): Promise<void> {
    const command = new PutObjectCommand({
      Bucket: this.config.get<string>('R2_BUCKET_NAME')!,
      Key: key,
      Body: buffer,
      ContentType: mimetype,
    });
    await this.s3Client.send(command);
    this.logger.log(`Uploaded logo ${key} to R2 (${buffer.length} bytes)`);
  }

  /**
   * Store a voice screening call recording (MP3 pulled from ElevenLabs).
   * Key convention: calls/{tenantId}/{voiceCallId}/audio.mp3 (mirrors emails/...).
   */
  async uploadVoiceAudio(buffer: Buffer, tenantId: string, voiceCallId: string): Promise<string> {
    const key = `calls/${tenantId}/${voiceCallId}/audio.mp3`;
    const command = new PutObjectCommand({
      Bucket: this.config.get<string>('R2_BUCKET_NAME')!,
      Key: key,
      Body: buffer,
      ContentType: 'audio/mpeg',
    });
    // D-07 convention: transient R2 errors propagate to BullMQ for automatic retry.
    await this.s3Client.send(command);
    this.logger.log(`Uploaded voice audio: ${key} (${buffer.length} bytes)`);
    return key;
  }

  async uploadPayload(payload: EmailPayloadDto, tenantId: string, messageId: string): Promise<string> {
    const key = `emails/${tenantId}/${messageId}/payload.json`;
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.config.get<string>('R2_BUCKET_NAME')!,
        Key: key,
        Body: JSON.stringify(payload),
        ContentType: 'application/json',
      }),
    );
    this.logger.log(`Uploaded payload ${key} to R2`);
    return key;
  }

  async downloadPayload(tenantId: string, messageId: string): Promise<EmailPayloadDto> {
    const key = `emails/${tenantId}/${messageId}/payload.json`;
    const response = await this.s3Client.send(
      new GetObjectCommand({
        Bucket: this.config.get<string>('R2_BUCKET_NAME')!,
        Key: key,
      }),
    );
    const body = await response.Body!.transformToString();
    return JSON.parse(body) as EmailPayloadDto;
  }

  async saveExtractionCache(result: Record<string, unknown>, tenantId: string, messageId: string): Promise<void> {
    const key = `emails/${tenantId}/${messageId}/extraction.json`;
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.config.get<string>('R2_BUCKET_NAME')!,
        Key: key,
        Body: JSON.stringify(result),
        ContentType: 'application/json',
      }),
    );
    this.logger.log(`Cached extraction result at ${key}`);
  }

  async loadExtractionCache(tenantId: string, messageId: string): Promise<Record<string, unknown> | null> {
    const key = `emails/${tenantId}/${messageId}/extraction.json`;
    try {
      const response = await this.s3Client.send(
        new GetObjectCommand({
          Bucket: this.config.get<string>('R2_BUCKET_NAME')!,
          Key: key,
        }),
      );
      const body = await response.Body!.transformToString();
      return JSON.parse(body) as Record<string, unknown>;
    } catch (err: any) {
      if (err.name === 'NoSuchKey') return null;
      throw err;
    }
  }

  async saveClassificationCache(result: Record<string, unknown>, tenantId: string, messageId: string): Promise<void> {
    const key = `emails/${tenantId}/${messageId}/classification.json`;
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.config.get<string>('R2_BUCKET_NAME')!,
        Key: key,
        Body: JSON.stringify(result),
        ContentType: 'application/json',
      }),
    );
    this.logger.log(`Cached classification result at ${key}`);
  }

  async loadClassificationCache(tenantId: string, messageId: string): Promise<Record<string, unknown> | null> {
    const key = `emails/${tenantId}/${messageId}/classification.json`;
    try {
      const response = await this.s3Client.send(
        new GetObjectCommand({
          Bucket: this.config.get<string>('R2_BUCKET_NAME')!,
          Key: key,
        }),
      );
      const body = await response.Body!.transformToString();
      return JSON.parse(body) as Record<string, unknown>;
    } catch (err: any) {
      if (err.name === 'NoSuchKey') return null;
      throw err;
    }
  }

  private selectLargestCvAttachment(
    attachments: EmailAttachmentDto[],
  ): { att: EmailAttachmentDto; kind: CvDocumentKind } | null {
    const documents = attachments.flatMap((att) => {
      const kind = detectCvDocument(att);
      return kind ? [{ att, kind }] : [];
    });
    if (documents.length === 0) return null;
    return documents.reduce((largest, current) =>
      (current.att.ContentLength ?? 0) > (largest.att.ContentLength ?? 0) ? current : largest,
    );
  }

  private getExtension(contentType: string): string {
    const extensions: Record<string, string> = {
      'application/pdf': '.pdf',
      'application/msword': '.doc',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    };
    return extensions[contentType] ?? '.bin';
  }
}
