// Mock pdf-parse PDFParse class to return controlled text. The destroy spy is created inside
// the factory (and re-exported as __destroy) because jest.mock is hoisted above the imports.
jest.mock('pdf-parse', () => {
  const destroy = jest.fn().mockResolvedValue(undefined);
  return {
    __destroy: destroy,
    PDFParse: jest.fn().mockImplementation(() => ({
      getText: jest.fn().mockResolvedValue({ text: 'Extracted PDF text content' }),
      destroy,
    })),
  };
});

// Mock mammoth to return controlled raw text
jest.mock('mammoth', () => ({
  extractRawText: jest.fn().mockResolvedValue({ value: 'Extracted DOCX text content' }),
}));

import { AttachmentExtractorService } from './attachment-extractor.service';
import { EmailAttachmentDto } from '../../webhooks/dto/mailgun-payload.dto';
import { mockBase64Pdf, mockBase64Docx } from './spam-filter.service.spec';

const { __destroy: destroyMock } = jest.requireMock('pdf-parse') as { __destroy: jest.Mock };

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

  it('destroys the PDF parser after a successful parse', async () => {
    await service.extract([{ Name: 'cv.pdf', ContentType: 'application/pdf', Content: mockBase64Pdf(), ContentLength: 100 }]);
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });

  it('destroys the PDF parser even when getText throws', async () => {
    const { PDFParse } = jest.requireMock('pdf-parse') as { PDFParse: jest.Mock };
    PDFParse.mockImplementationOnce(() => ({
      getText: jest.fn().mockRejectedValue(new Error('corrupt')),
      destroy: destroyMock,
    }));
    const result = await service.extract([{ Name: 'bad.pdf', ContentType: 'application/pdf', Content: mockBase64Pdf(), ContentLength: 100 }]);
    expect(result).toBe('');
    expect(destroyMock).toHaveBeenCalledTimes(1);
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
