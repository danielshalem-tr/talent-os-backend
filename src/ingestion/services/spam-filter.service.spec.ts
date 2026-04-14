import { SpamFilterService, SpamFilterResult } from './spam-filter.service';
import { PostmarkPayloadDto } from '../../webhooks/dto/postmark-payload.dto';

export function mockPostmarkPayload(overrides: Partial<PostmarkPayloadDto> = {}): PostmarkPayloadDto {
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

    // "Promotion", "Deal", "Offer" are contextual now.
    // Without commercial co-signals, they do not trigger a hard reject.
    const payloadMixedClean = mockPostmarkPayload({
      Subject: 'Job Application',
      TextBody: 'Promotion Deal Offer ' + 'x'.repeat(100),
      Attachments: [],
    });
    expect(service.check(payloadMixedClean)).toEqual<SpamFilterResult>({ isSpam: false, suspicious: false });

    // With a commercial co-signal ("50% discount"), they trigger spam
    const payloadMixedSpam = mockPostmarkPayload({
      Subject: 'Job Application',
      TextBody: 'Promotion Deal Offer with 50% discount ' + 'x'.repeat(100),
      Attachments: [],
    });
    expect(service.check(payloadMixedSpam)).toEqual<SpamFilterResult>({ isSpam: true, suspicious: false });
  });

  // 3-01-06: NON_CV_SUBJECT_PATTERNS — real-estate subject, no attachment → spam
  it('real-estate subject (office space), no attachment, long body → spam', () => {
    const payload = mockPostmarkPayload({
      Subject: 'Re: 30,000 sq ft office space in Gowanus',
      TextBody:
        'Hi there, Just bumping this. Want me to send the basics on the Gowanus space (pricing range, floorplan, photos, exact location), or should I stop reaching out? Thanks, Sam Hamway Reqce Commercial (917) 270-5120.',
      Attachments: [],
    });
    expect(service.check(payload)).toEqual<SpamFilterResult>({ isSpam: true, suspicious: false });
  });

  // 3-01-07: NON_CV_SUBJECT_PATTERNS — real-estate subject WITH attachment → suspicious, not spam
  it('real-estate subject with attachment → suspicious', () => {
    const payload = mockPostmarkPayload({
      Subject: 'Office space available for lease',
      TextBody: 'Please find attached the floor plan for the available office space.',
      Attachments: [{ Name: 'floorplan.pdf', ContentType: 'application/pdf', ContentLength: 500 }],
    });
    expect(service.check(payload)).toEqual<SpamFilterResult>({ isSpam: false, suspicious: true });
  });

  // 3-01-08: SPAM_KEYWORDS expansion — "sq ft" in body
  it('"sq ft" keyword in body, no attachment → spam', () => {
    const payload = mockPostmarkPayload({
      Subject: 'Property inquiry',
      TextBody: 'We have 5,000 sq ft available in Brooklyn for immediate occupancy. Let me know if you want details.',
      Attachments: [],
    });
    expect(service.check(payload)).toEqual<SpamFilterResult>({ isSpam: true, suspicious: false });
  });

  // 3-01-09: SPAM_KEYWORDS expansion — "office space" in body
  it('"office space" keyword in body, no attachment → spam', () => {
    const payload = mockPostmarkPayload({
      Subject: 'Quick question',
      TextBody: 'We have premium office space available in your area at very competitive rates. Reply for a quote.',
      Attachments: [],
    });
    expect(service.check(payload)).toEqual<SpamFilterResult>({ isSpam: true, suspicious: false });
  });

  // 3-01-10: Clean CV email with no keywords or non-CV subject → passes
  it('clean direct CV submission passes', () => {
    const payload = mockPostmarkPayload({
      Subject: 'Application for Backend Developer role',
      TextBody: 'Please find my CV attached. I have 5 years of experience in TypeScript and NestJS.',
      Attachments: [{ Name: 'cv.pdf', ContentType: 'application/pdf', ContentLength: 80000 }],
    });
    expect(service.check(payload)).toEqual<SpamFilterResult>({ isSpam: false, suspicious: false });
  });

  // 3-01-11: Defense-in-depth — document with ContentID shouldn't be ignored
  it('defense-in-depth: PDF with ContentID is still a meaningful attachment', () => {
    const payload = mockPostmarkPayload({
      Subject: 'My Application',
      TextBody: 'hi', // Very short body, would trigger hard reject if attachment is ignored
      Attachments: [
        { Name: 'cv.pdf', ContentType: 'application/pdf', ContentLength: 500, ContentID: 'cid:some-pdf-123' },
      ],
    });
    // Body < 100 but attachment is meaningful, so it passes
    expect(service.check(payload)).toEqual<SpamFilterResult>({ isSpam: false, suspicious: false });
  });

  // 3-01-12: Defense-in-depth — inline image with ContentID is ignored
  it('inline image with ContentID is ignored as an attachment', () => {
    const payload = mockPostmarkPayload({
      Subject: 'My Application',
      TextBody: 'hi', // Very short body + no meaningful attachment = spam (PROC-02)
      Attachments: [{ Name: 'logo.png', ContentType: 'image/png', ContentLength: 100, ContentID: 'cid:logo-image' }],
    });
    expect(service.check(payload)).toEqual<SpamFilterResult>({ isSpam: true, suspicious: false });
  });
});
