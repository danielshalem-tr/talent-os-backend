import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { PostmarkAttachmentDto, PostmarkPayloadDto } from '../webhooks/dto/postmark-payload.dto';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const CV_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;

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
  async upload(attachments: PostmarkAttachmentDto[], tenantId: string, messageId: string): Promise<string | null> {
    // D-01: Select largest PDF/DOCX; filters out signature images, logos, etc.
    const selected = this.selectLargestCvAttachment(attachments);
    if (!selected) {
      // D-02: No qualifying file — return null, job continues
      return null;
    }

    const extension = this.getExtension(selected.ContentType);
    // D-10: Key includes correct extension based on ContentType
    const key = `cvs/${tenantId}/${messageId}${extension}`;
    const buffer = Buffer.from(selected.Content!, 'base64');

    const command = new PutObjectCommand({
      Bucket: this.config.get<string>('R2_BUCKET_NAME')!,
      Key: key,
      Body: buffer,
      ContentType: selected.ContentType, // D-11: Explicit ContentType for browser rendering
    });

    // D-07: Transient R2 errors propagate to BullMQ for automatic retry.
    // Do NOT catch here — retrying the full job is correct for network failures.
    await this.s3Client.send(command);

    this.logger.log(`Uploaded ${key} to R2 (${buffer.length} bytes)`);
    // D-04: Return object key only — NOT a presigned URL
    return key;
  }

  async getPresignedUrl(key: string, expiresIn = 3600): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.config.get<string>('R2_BUCKET_NAME')!,
      Key: key,
    });
    return getSignedUrl(this.s3Client, command, { expiresIn });
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

  async uploadPayload(payload: PostmarkPayloadDto, tenantId: string, messageId: string): Promise<string> {
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

  async downloadPayload(tenantId: string, messageId: string): Promise<PostmarkPayloadDto> {
    const key = `emails/${tenantId}/${messageId}/payload.json`;
    const response = await this.s3Client.send(
      new GetObjectCommand({
        Bucket: this.config.get<string>('R2_BUCKET_NAME')!,
        Key: key,
      }),
    );
    const body = await response.Body!.transformToString();
    return JSON.parse(body) as PostmarkPayloadDto;
  }

  private selectLargestCvAttachment(attachments: PostmarkAttachmentDto[]): PostmarkAttachmentDto | null {
    // D-01: Only PDF/DOCX; picks the one with the largest ContentLength
    const cvFiles = attachments.filter((att) => (CV_MIME_TYPES as readonly string[]).includes(att.ContentType));
    if (cvFiles.length === 0) return null;
    return cvFiles.reduce((largest, current) =>
      (current.ContentLength ?? 0) > (largest.ContentLength ?? 0) ? current : largest,
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
