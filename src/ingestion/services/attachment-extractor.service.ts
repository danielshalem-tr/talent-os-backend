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
          // PROC-04: pdf-parse@2.x class API. destroy() is part of its contract — without it
          // pdf.js document structures stay alive in a worker that runs for weeks.
          const parser = new PDFParse({ data: buffer });
          try {
            const result = await parser.getText();
            text = result.text ?? '';
          } finally {
            await parser.destroy?.().catch(() => undefined);
          }
        } else if (kind === 'docx') {
          // PROC-05: raw text — no HTML round-trip, no image conversion, no entity decoding.
          const result = await mammoth.extractRawText({ buffer });
          text = result.value ?? '';
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
}
