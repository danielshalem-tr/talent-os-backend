import { SpamFilterService, SpamFilterResult } from './spam-filter.service';
import { PostmarkPayloadDto } from '../../webhooks/dto/postmark-payload.dto';

export function mockPostmarkPayload(
  overrides: Partial<PostmarkPayloadDto> = {},
): PostmarkPayloadDto {
  return {
    MessageID: 'test-message-id',
    From: 'test@example.com',
    Subject: 'Test Subject',
    TextBody: 'Hello world, this is a test email with enough text to not be spam.',
    Date: new Date().toISOString(),
    Attachments: [],
    ...overrides,
  };
}

export function mockBase64Pdf(): string {
  return Buffer.from('%PDF-1.4 fake pdf content for testing').toString('base64');
}

export function mockBase64Docx(): string {
  return Buffer.from('PK fake docx content for testing').toString('base64');
}

describe('SpamFilterService', () => {
  let service: SpamFilterService;

  beforeEach(() => {
    service = new SpamFilterService();
  });

  // 3-01-01: PROC-02 — hard reject: no attachment AND body < 100 chars
  it('no attachment and short body', () => {
    const payload = mockPostmarkPayload({ TextBody: 'hi', Attachments: [] });
    const result = service.check(payload);
    expect(result).toEqual<SpamFilterResult>({ isSpam: true, suspicious: false });
  });

  // 3-01-02: PROC-02 — attachment present overrides short body rule
  it('attachment present', () => {
    const payload = mockPostmarkPayload({
      TextBody: 'hi',
      Attachments: [{ Name: 'cv.pdf', ContentType: 'application/pdf', ContentLength: 100 }],
    });
    const result = service.check(payload);
    expect(result.isSpam).toBe(false);
  });

  // 3-01-03: PROC-03 — keyword in subject, no attachment = hard reject
  it('keyword subject no attachment', () => {
    const payload = mockPostmarkPayload({
      Subject: 'Unsubscribe from our marketing list',
      TextBody: 'a'.repeat(150), // long enough body, but keyword in subject
      Attachments: [],
    });
    const result = service.check(payload);
    expect(result).toEqual<SpamFilterResult>({ isSpam: true, suspicious: false });
  });

  // 3-01-04: PROC-03 D-09 — keyword in body, attachment present = suspicious
  it('keyword body with attachment', () => {
    const payload = mockPostmarkPayload({
      Subject: 'Job Application',
      TextBody: 'newsletter offer ' + 'x'.repeat(100),
      Attachments: [{ Name: 'cv.pdf', ContentType: 'application/pdf', ContentLength: 100 }],
    });
    const result = service.check(payload);
    expect(result).toEqual<SpamFilterResult>({ isSpam: false, suspicious: true });
  });

  // 3-01-05: PROC-03 — case-insensitive keyword matching
  it('keyword variations', () => {
    const payloadUpper = mockPostmarkPayload({
      Subject: 'NEWSLETTER',
      TextBody: 'a'.repeat(150),
      Attachments: [],
    });
    expect(service.check(payloadUpper)).toEqual<SpamFilterResult>({ isSpam: true, suspicious: false });

    const payloadMixed = mockPostmarkPayload({
      Subject: 'Job Application',
      TextBody: 'Promotion Deal Offer ' + 'x'.repeat(100),
      Attachments: [],
    });
    expect(service.check(payloadMixed)).toEqual<SpamFilterResult>({ isSpam: true, suspicious: false });
  });
});
