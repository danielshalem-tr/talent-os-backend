// Mock pdf-parse PDFParse class to return controlled text
jest.mock('pdf-parse', () => ({
  PDFParse: jest.fn().mockImplementation(() => ({
    getText: jest.fn().mockResolvedValue({ text: 'Extracted PDF text content' }),
  })),
}));

// Mock mammoth to return controlled HTML
jest.mock('mammoth', () => ({
  convertToHtml: jest
    .fn()
    .mockResolvedValue({ value: '<p>Extracted DOCX text content</p>' }),
}));

import { AttachmentExtractorService } from './attachment-extractor.service';
import { EmailAttachmentDto } from '../../webhooks/dto/mailgun-payload.dto';
import { mockBase64Pdf, mockBase64Docx } from './spam-filter.service.spec';

describe('AttachmentExtractorService', () => {
  let service: AttachmentExtractorService;

  beforeEach(() => {
    service = new AttachmentExtractorService();
    jest.clearAllMocks();
  });

  // 3-02-01: PROC-04 — PDF extraction with demarcation
  it('PDF extraction', async () => {
    const att: EmailAttachmentDto = {
      Name: 'cv.pdf',
      ContentType: 'application/pdf',
      Content: mockBase64Pdf(),
      ContentLength: 100,
    };
    const result = await service.extract([att]);
    expect(result).toContain('--- Attachment: cv.pdf ---');
    expect(result).toContain('Extracted PDF text content');
  });

  // 3-02-02: PROC-05 — DOCX extraction with demarcation and HTML stripped
  it('DOCX extraction', async () => {
    const att: EmailAttachmentDto = {
      Name: 'cover-letter.docx',
      ContentType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      Content: mockBase64Docx(),
      ContentLength: 100,
    };
    const result = await service.extract([att]);
    expect(result).toContain('--- Attachment: cover-letter.docx ---');
    expect(result).toContain('Extracted DOCX text content');
    expect(result).not.toContain('<p>'); // HTML must be stripped
  });

  // 3-02-03: D-04 — unsupported type skipped silently
  it('unsupported type', async () => {
    const att: EmailAttachmentDto = {
      Name: 'photo.png',
      ContentType: 'image/png',
      Content: 'abc123',
      ContentLength: 50,
    };
    const result = await service.extract([att]);
    expect(result).toBe(''); // No text extracted, no error
  });

  // 3-02-04: D-06 — corrupted PDF caught and skipped
  it('corrupted PDF', async () => {
    // Make PDFParse.getText() throw for this test only
    const { PDFParse } = require('pdf-parse');
    PDFParse.mockImplementationOnce(() => ({
      getText: jest
        .fn()
        .mockRejectedValueOnce(new Error('Invalid PDF structure')),
    }));

    const att: EmailAttachmentDto = {
      Name: 'corrupt.pdf',
      ContentType: 'application/pdf',
      Content: mockBase64Pdf(),
      ContentLength: 10,
    };
    // Should NOT throw — corrupted files are caught and skipped
    await expect(service.extract([att])).resolves.toBe('');
  });

  // 3-02-05: D-01, D-02 — multiple attachments merged with demarcation
  it('multiple attachments', async () => {
    const pdf: EmailAttachmentDto = {
      Name: 'cv.pdf',
      ContentType: 'application/pdf',
      Content: mockBase64Pdf(),
      ContentLength: 100,
    };
    const docx: EmailAttachmentDto = {
      Name: 'cover.docx',
      ContentType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      Content: mockBase64Docx(),
      ContentLength: 100,
    };
    const result = await service.extract([pdf, docx]);
    expect(result).toContain('--- Attachment: cv.pdf ---');
    expect(result).toContain('--- Attachment: cover.docx ---');
    // Both sections present in one merged string
    expect(result.indexOf('cv.pdf')).toBeLessThan(result.indexOf('cover.docx'));
  });

  it('parses a PDF delivered as application/octet-stream when the filename says .pdf', async () => {
    const att: EmailAttachmentDto = {
      Name: 'Resume.PDF',
      ContentType: 'application/octet-stream',
      Content: mockBase64Pdf(),
      ContentLength: 100,
    };
    const result = await service.extract([att]);
    expect(result).toContain('Extracted PDF text content');
  });

  // BUG-CV-NULLBYTE: pdf-parse can emit NUL (U+0000) bytes that Postgres text columns
  // reject. The extractor must strip them at the source so cv_text can be persisted.
  it('strips NUL bytes from extracted PDF text', async () => {
    const NUL = String.fromCharCode(0);
    const { PDFParse } = require('pdf-parse');
    PDFParse.mockImplementationOnce(() => ({
      getText: jest.fn().mockResolvedValue({ text: `Daniel${NUL}Amar${NUL}` }),
    }));

    const att: EmailAttachmentDto = {
      Name: 'cv.pdf',
      ContentType: 'application/pdf',
      Content: mockBase64Pdf(),
      ContentLength: 100,
    };
    const result = await service.extract([att]);

    expect(result).toContain('DanielAmar');
    expect(result.includes(NUL)).toBe(false);
  });
});
