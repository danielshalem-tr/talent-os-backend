import { detectCvDocument, extensionForKind, hasCvDocument, mimeForKind, DOCX_MIME, PDF_MIME } from './document-detect';

const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('detectCvDocument', () => {
  it('recognises exact MIME types', () => {
    expect(detectCvDocument({ Name: 'x', ContentType: PDF_MIME })).toBe('pdf');
    expect(detectCvDocument({ Name: 'x', ContentType: DOCX_MIME })).toBe('docx');
    expect(detectCvDocument({ Name: 'x', ContentType: 'application/msword' })).toBe('doc');
    expect(detectCvDocument({ Name: 'x', ContentType: 'application/x-pdf' })).toBe('pdf');
    expect(detectCvDocument({ Name: 'x', ContentType: 'Application/PDF; name=cv.pdf' })).toBe('pdf');
  });

  it('falls back to the filename extension for octet-stream', () => {
    expect(detectCvDocument({ Name: 'Dana CV.PDF', ContentType: 'application/octet-stream' })).toBe('pdf');
    expect(detectCvDocument({ Name: 'cv.docx', ContentType: 'application/octet-stream' })).toBe('docx');
    expect(detectCvDocument({ Name: 'cv.doc', ContentType: 'binary/octet-stream' })).toBe('doc');
  });

  it('falls back to the %PDF- magic bytes', () => {
    expect(detectCvDocument({ Name: 'attachment', ContentType: 'application/octet-stream', Content: b64('%PDF-1.7 rest') })).toBe('pdf');
  });

  it('returns null for images, calendars and unknown blobs', () => {
    expect(detectCvDocument({ Name: 'logo.png', ContentType: 'image/png' })).toBeNull();
    expect(detectCvDocument({ Name: 'invite.ics', ContentType: 'text/calendar' })).toBeNull();
    expect(detectCvDocument({ Name: 'blob', ContentType: 'application/octet-stream', Content: b64('PK zip') })).toBeNull();
  });

  it('maps kinds back to mime/extension', () => {
    expect(mimeForKind('pdf')).toBe(PDF_MIME);
    expect(extensionForKind('docx')).toBe('.docx');
    expect(extensionForKind('doc')).toBe('.doc');
  });

  it('hasCvDocument is true when any attachment is a document', () => {
    expect(hasCvDocument([{ Name: 'logo.png', ContentType: 'image/png' }, { Name: 'cv.pdf', ContentType: 'application/octet-stream' }])).toBe(true);
    expect(hasCvDocument([{ Name: 'logo.png', ContentType: 'image/png' }])).toBe(false);
    expect(hasCvDocument(undefined)).toBe(false);
  });
});
