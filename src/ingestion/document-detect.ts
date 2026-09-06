export type CvDocumentKind = 'pdf' | 'docx' | 'doc';

export const PDF_MIME = 'application/pdf';
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const DOC_MIME = 'application/msword';

const MIME_TO_KIND: Record<string, CvDocumentKind> = {
  [PDF_MIME]: 'pdf',
  'application/x-pdf': 'pdf',
  [DOCX_MIME]: 'docx',
  [DOC_MIME]: 'doc',
};

const EXT_TO_KIND: Record<string, CvDocumentKind> = { '.pdf': 'pdf', '.docx': 'docx', '.doc': 'doc' };

export interface DocumentLike {
  Name: string;
  ContentType: string;
  /** base64 body when available — enables the magic-byte check. */
  Content?: string;
}

function extensionOf(name: string): string {
  const match = /\.[a-z0-9]+$/i.exec(name.trim());
  return match ? match[0].toLowerCase() : '';
}

/**
 * The single answer to "is this attachment a CV document we store and read?", shared by the
 * webhook (which file to keep in R2), the extractor (which files to parse) and the classifier
 * (known agency + document shortcut). Before this, storage matched the exact MIME only, the
 * extractor accepted a `.docx` filename but not a `.pdf` one, and `.doc` files were dropped
 * everywhere — so Gmail-forwarded `application/octet-stream` CVs vanished.
 *
 * Order: exact MIME → filename extension → `%PDF-` magic bytes. A bare zip signature is NOT
 * treated as DOCX (every Office/zip container starts the same way).
 */
export function detectCvDocument(att: DocumentLike): CvDocumentKind | null {
  const mime = (att.ContentType ?? '').toLowerCase().split(';')[0].trim();
  if (MIME_TO_KIND[mime]) return MIME_TO_KIND[mime];
  const byExt = EXT_TO_KIND[extensionOf(att.Name ?? '')];
  if (byExt) return byExt;
  if (att.Content) {
    // 12 base64 chars → 9 bytes; enough for the 5-byte PDF signature, cheap for a 10 MB file.
    const head = Buffer.from(att.Content.slice(0, 12), 'base64');
    if (head.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  }
  return null;
}

export function mimeForKind(kind: CvDocumentKind): string {
  return kind === 'pdf' ? PDF_MIME : kind === 'docx' ? DOCX_MIME : DOC_MIME;
}

export function extensionForKind(kind: CvDocumentKind): '.pdf' | '.docx' | '.doc' {
  return kind === 'pdf' ? '.pdf' : kind === 'docx' ? '.docx' : '.doc';
}

export function hasCvDocument(attachments: DocumentLike[] | undefined | null): boolean {
  return (attachments ?? []).some((att) => detectCvDocument(att) !== null);
}
