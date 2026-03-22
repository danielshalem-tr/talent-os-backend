import { Injectable, Logger } from '@nestjs/common';
import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import { PostmarkAttachmentDto } from '../../webhooks/dto/postmark-payload.dto';

const DOCX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

@Injectable()
export class AttachmentExtractorService {
  private readonly logger = new Logger(AttachmentExtractorService.name);

  async extract(attachments: PostmarkAttachmentDto[]): Promise<string> {
    const sections: string[] = [];

    for (const att of attachments) {
      // Skip attachments with no Content (e.g., metadata-only in DB raw_payload)
      if (!att.Content) {
        this.logger.warn(
          `Skipping attachment ${att.Name}: no Content field (was blob stripped?)`,
        );
        continue;
      }

      try {
        const buffer = Buffer.from(att.Content, 'base64');
        let text = '';

        if (att.ContentType === 'application/pdf') {
          // PROC-04: pdf-parse@2.x class-based API accepts Buffer as Uint8Array-compatible data
          const parser = new PDFParse({ data: buffer });
          const result = await parser.getText();
          text = result.text ?? '';
        } else if (
          att.ContentType === DOCX_CONTENT_TYPE ||
          att.Name.toLowerCase().endsWith('.docx')
        ) {
          // PROC-05: mammoth returns HTML; strip tags to plain text
          const result = await mammoth.convertToHtml({ buffer });
          text = this.htmlToPlainText(result.value);
        } else {
          // D-04: unsupported type — log warning, skip (no error)
          this.logger.warn(
            `Skipping unsupported attachment: ${att.Name} (${att.ContentType})`,
          );
          continue;
        }

        if (text.trim()) {
          // D-02: demarcate each file
          sections.push(`--- Attachment: ${att.Name} ---\n${text.trim()}`);
        }
      } catch (error) {
        // D-06: corrupted file — log warning, skip, continue with others
        this.logger.warn(
          `Failed to parse attachment ${att.Name}: ${(error as Error).message}`,
        );
      }
    }

    return sections.join('\n\n');
  }

  private htmlToPlainText(html: string): string {
    return html
      .replace(/<[^>]*>/g, ' ') // Replace tags with space (not empty) to preserve word boundaries
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ') // Collapse multiple spaces
      .trim();
  }
}
