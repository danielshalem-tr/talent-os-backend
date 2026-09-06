import { Injectable, Logger } from '@nestjs/common';
import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import { EmailAttachmentDto } from '../../webhooks';
import { sanitizePgText } from '../../common/sanitize-pg-text';
import { detectCvDocument } from '../document-detect';

@Injectable()
export class AttachmentExtractorService {
  private readonly logger = new Logger(AttachmentExtractorService.name);

  async extract(attachments: EmailAttachmentDto[]): Promise<string> {
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

        const kind = detectCvDocument(att);
        if (kind === 'pdf') {
          // PROC-04: pdf-parse@2.x class-based API accepts Buffer as Uint8Array-compatible data
          const parser = new PDFParse({ data: buffer });
          const result = await parser.getText();
          text = result.text ?? '';
        } else if (kind === 'docx') {
          // PROC-05: mammoth returns HTML; strip tags to plain text
          const result = await mammoth.convertToHtml({ buffer });
          text = this.htmlToPlainText(result.value);
        } else {
          // D-04: images, calendars, legacy .doc (no parser) — log, skip, keep going. A .doc is
          // still STORED by the webhook (storage.service.ts) so the file is downloadable.
          this.logger.warn(
            `Skipping unsupported attachment: ${att.Name} (${att.ContentType})`,
          );
          continue;
        }

        // Strip NUL bytes / lone surrogates at the source — Postgres text columns
        // reject them, and this text flows into candidates.cv_text (Phase 7).
        text = sanitizePgText(text);

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
