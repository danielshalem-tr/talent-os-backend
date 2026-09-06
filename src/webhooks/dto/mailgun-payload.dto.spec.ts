import { MailgunRawBodySchema, MailgunRawBodyDto, parseMailgunPayload } from './mailgun-payload.dto';

const VALID_HEADERS = JSON.stringify([
  ['Message-Id', '<abc-123@mail.example.com>'],
  ['From', 'Sender <sender@example.com>'],
]);

const validBody = {
  timestamp: '1748000000',
  token: 'a'.repeat(50),
  signature: 'b'.repeat(64),
  from: 'sender@example.com',
  subject: 'CV Application',
  'body-plain': 'Plain text body',
  'stripped-text': 'Stripped text body',
  'message-headers': VALID_HEADERS,
};

describe('MailgunRawBodySchema', () => {
  it('accepts a fully valid body', () => {
    const result = MailgunRawBodySchema.safeParse(validBody);
    expect(result.success).toBe(true);
  });

  it('rejects missing timestamp', () => {
    const { timestamp: _, ...rest } = validBody;
    expect(MailgunRawBodySchema.safeParse(rest).success).toBe(false);
  });

  it('rejects non-numeric timestamp', () => {
    expect(MailgunRawBodySchema.safeParse({ ...validBody, timestamp: 'not-a-number' }).success).toBe(false);
  });

  it('rejects missing token', () => {
    const { token: _, ...rest } = validBody;
    expect(MailgunRawBodySchema.safeParse(rest).success).toBe(false);
  });

  it('rejects missing signature', () => {
    const { signature: _, ...rest } = validBody;
    expect(MailgunRawBodySchema.safeParse(rest).success).toBe(false);
  });

  it('rejects missing from', () => {
    const { from: _, ...rest } = validBody;
    expect(MailgunRawBodySchema.safeParse(rest).success).toBe(false);
  });

  it('rejects invalid JSON in message-headers', () => {
    expect(MailgunRawBodySchema.safeParse({ ...validBody, 'message-headers': 'not-json' }).success).toBe(false);
  });

  it('defaults subject to empty string when absent', () => {
    const { subject: _, ...rest } = validBody;
    const result = MailgunRawBodySchema.safeParse(rest);
    expect(result.success).toBe(true);
    expect((result as any).data.subject).toBe('');
  });

  it('allows optional body-plain and body-html', () => {
    const { 'body-plain': _p, ...rest } = validBody;
    expect(MailgunRawBodySchema.safeParse(rest).success).toBe(true);
  });

  it('allows optional stripped-text', () => {
    const { 'stripped-text': _s, ...rest } = validBody;
    expect(MailgunRawBodySchema.safeParse(rest).success).toBe(true);
  });
});

describe('parseMailgunPayload', () => {
  it('extracts MessageID from Message-Id header with angle brackets stripped', () => {
    const result = parseMailgunPayload(validBody as any, []);
    // Raw header value is '<abc-123@...>' — angle brackets must be stripped.
    // R2 keys and DB messageId column cannot safely contain '<' or '>'.
    expect(result.MessageID).toBe('abc-123@mail.example.com');
  });


  it('uses from field as From', () => {
    const result = parseMailgunPayload(validBody as any, []);
    expect(result.From).toBe('sender@example.com');
  });

  it('strips display name from from field when present', () => {
    const body = { ...validBody, from: 'John Doe <john@example.com>' };
    const result = parseMailgunPayload(body as any, []);
    expect(result.From).toBe('john@example.com');
  });

  it('converts Unix timestamp to ISO date string', () => {
    const result = parseMailgunPayload(validBody as any, []);
    expect(result.Date).toBe(new Date(1748000000 * 1000).toISOString());
  });

  it('prefers stripped-text over body-plain for TextBody', () => {
    // stripped-text removes signatures/reply-chains — better signal for AI extraction
    const body = { ...validBody, 'stripped-text': 'Just the cover note', 'body-plain': 'Cover note + signature' };
    const result = parseMailgunPayload(body as any, []);
    expect(result.TextBody).toBe('Just the cover note');
  });

  it('falls back to body-plain for TextBody when stripped-text is absent', () => {
    const { 'stripped-text': _s, ...body } = validBody;
    const result = parseMailgunPayload(body as any, []);
    expect(result.TextBody).toBe('Plain text body');
  });

  it('maps subject and body-html', () => {
    const body = { ...validBody, 'body-html': '<p>Hello</p>' };
    const result = parseMailgunPayload(body as any, []);
    expect(result.Subject).toBe('CV Application');
    expect(result.HtmlBody).toBe('<p>Hello</p>');
  });

  it('maps uploaded files to base64 attachments', () => {
    const fakeFile = {
      originalname: 'resume.pdf',
      mimetype: 'application/pdf',
      size: 1024,
      buffer: Buffer.from('fake-pdf-bytes'),
    } as Express.Multer.File;

    const result = parseMailgunPayload(validBody as any, [fakeFile]);

    expect(result.Attachments).toHaveLength(1);
    expect(result.Attachments[0].Name).toBe('resume.pdf');
    expect(result.Attachments[0].ContentType).toBe('application/pdf');
    expect(result.Attachments[0].ContentLength).toBe(1024);
    expect(result.Attachments[0].Content).toBe(Buffer.from('fake-pdf-bytes').toString('base64'));
  });

  it('produces empty Attachments array when no files are uploaded', () => {
    const result = parseMailgunPayload(validBody as any, []);
    expect(result.Attachments).toEqual([]);
  });
});

describe('parseMailgunPayload — hardening', () => {
  const file = (fieldname: string, originalname: string, mimetype: string, body = 'x'): Express.Multer.File =>
    ({ fieldname, originalname, mimetype, size: body.length, buffer: Buffer.from(body) }) as Express.Multer.File;

  it('populates ContentID for inline parts from content-id-map', () => {
    const files = [file('attachment-1', 'cv.pdf', 'application/pdf'), file('attachment-2', 'logo.png', 'image/png')];
    const body = { ...validBody, 'content-id-map': JSON.stringify({ '<logo@sig>': 'attachment-2' }) };
    const out = parseMailgunPayload(body, files);
    expect(out.Attachments[0].ContentID).toBeUndefined();
    expect(out.Attachments[1].ContentID).toBe('logo@sig');
  });

  it('appends stripped-signature to TextBody and keeps the full plain body separately', () => {
    const body = {
      ...validBody,
      'stripped-text': 'Hi, CV attached.',
      'stripped-signature': 'Dana\n052-1234567',
      'body-plain': 'Hi, CV attached.\nDana\n052-1234567\n> quoted ad #106',
    };
    const out = parseMailgunPayload(body, []);
    expect(out.TextBody).toBe('Hi, CV attached.\n\nDana\n052-1234567');
    expect(out.PlainBody).toContain('#106');
  });

  it('falls back to body-plain when stripped-text is blank', () => {
    const out = parseMailgunPayload({ ...validBody, 'stripped-text': '   ', 'stripped-signature': 'sig', 'body-plain': 'full body' }, []);
    expect(out.TextBody).toBe('full body');
  });

  it('extracts the sender display name', () => {
    expect(parseMailgunPayload({ ...validBody, from: 'Emily Myaskovski <e@example.com>' }, []).FromName).toBe('Emily Myaskovski');
    expect(parseMailgunPayload({ ...validBody, from: '"Cohen, Dana" <d@example.com>' }, []).FromName).toBe('Cohen, Dana');
    expect(parseMailgunPayload({ ...validBody, from: 'bare@example.com' }, []).FromName).toBeUndefined();
  });

  it('joins a multi-part body-html', () => {
    const parsed = MailgunRawBodySchema.safeParse({ ...validBody, 'body-html': ['<p>a</p>', '<p>b</p>'] });
    expect(parsed.success).toBe(true);
    expect(parseMailgunPayload((parsed as { data: MailgunRawBodyDto }).data, []).HtmlBody).toBe('<p>a</p>\n<p>b</p>');
  });

  it('ignores malformed header entries instead of throwing', () => {
    const headers = JSON.stringify([null, ['X', 7], [7, 'id'], {}, ['Message-Id', '<ok@example.com>']]);
    expect(parseMailgunPayload({ ...validBody, 'message-headers': headers }, []).MessageID).toBe('ok@example.com');
  });

  it('derives a stable id when Message-Id is missing or blank, independent of the delivery token', () => {
    const noId = { ...validBody, 'message-headers': JSON.stringify([['Date', 'Mon, 1 Sep 2026 10:00:00 +0300']]) };
    const a = parseMailgunPayload({ ...noId, token: 'a'.repeat(50) }, []).MessageID;
    const b = parseMailgunPayload({ ...noId, token: 'b'.repeat(50) }, []).MessageID;
    expect(a).toBe(b);
    expect(a).toMatch(/^gen-[0-9a-f]{40}$/);
    expect(parseMailgunPayload({ ...validBody, 'message-headers': JSON.stringify([['Message-Id', '<>']]) }, []).MessageID).toMatch(/^gen-/);
  });

  it('strips NUL from From and Subject', () => {
    const NUL = String.fromCharCode(0);
    const out = parseMailgunPayload({ ...validBody, from: `Dana <d${NUL}@example.com>`, subject: `CV${NUL}` }, []);
    expect(out.From).toBe('d@example.com');
    expect(out.Subject).toBe('CV');
  });
});
