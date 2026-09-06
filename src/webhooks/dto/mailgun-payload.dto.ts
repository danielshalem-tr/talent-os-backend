import { createHash } from 'crypto';
import { z } from 'zod';
import { sanitizePgText } from '../../common/sanitize-pg-text';

// ─── Raw Mailgun multipart body (fields only — files are on req.files) ────────

export const MailgunRawBodySchema = z.object({
  timestamp: z.string().regex(/^\d+$/, 'timestamp must be a Unix epoch number'),
  token: z.string().min(1),
  signature: z.string().min(1),
  from: z.string().min(1),
  subject: z.string().default(''),
  'body-plain': z.string().optional(),
  // Mailgun documents one-or-many HTML parts; normalised to one string in parseMailgunPayload.
  'body-html': z.union([z.string(), z.array(z.string())]).optional(),
  // stripped-text: Mailgun removes reply chains AND the signature. Preferred for the classifier.
  'stripped-text': z.string().optional(),
  // The signature block that stripped-text cut off — phone numbers and emails live here.
  'stripped-signature': z.string().optional(),
  // JSON map of inline Content-ID → multipart field name, e.g. {"<logo@x>": "attachment-3"}.
  'content-id-map': z.string().optional(),
  'message-headers': z.string().refine(
    (val) => {
      try {
        JSON.parse(val);
        return true;
      } catch {
        return false;
      }
    },
    { message: 'message-headers must be valid JSON' },
  ),
  recipient: z.string().optional(),
});

export type MailgunRawBodyDto = z.infer<typeof MailgunRawBodySchema>;

// ─── Internal normalized email payload ───────────────────────────────────────
// PascalCase field names used throughout the storage service, ingestion pipeline, and worker.
// New optional fields (FromName, PlainBody) stay optional forever: payload.json objects already
// in R2 do not have them.

export const EmailAttachmentSchema = z.object({
  Name: z.string(),
  Content: z.string().optional(),
  ContentType: z.string(),
  ContentLength: z.number(),
  ContentID: z.string().optional(),
});

export const EmailPayloadSchema = z.object({
  MessageID: z.string().min(1),
  From: z.string().email(),
  /** RFC-5322 display name of the sender, when present ("Dana Cohen <d@x>" → "Dana Cohen"). */
  FromName: z.string().optional(),
  Subject: z.string().default(''),
  /** stripped-text (+ stripped-signature) — the low-noise body for the classifier and extractor. */
  TextBody: z.string().optional(),
  /** body-plain verbatim — includes quoted threads; used to find job numbers the applicant replied to. */
  PlainBody: z.string().optional(),
  HtmlBody: z.string().optional(),
  Date: z.string(),
  Attachments: z.array(EmailAttachmentSchema).default([]),
});

export type EmailAttachmentDto = z.infer<typeof EmailAttachmentSchema>;
export type EmailPayloadDto = z.infer<typeof EmailPayloadSchema>;

// ─── Mapping: Mailgun multipart → internal EmailPayloadDto ───────────────────

/**
 * `message-headers` is documented as [[name, value], …] but real payloads have been seen with
 * odd entries. Keep only string pairs.
 */
export function parseMessageHeaders(raw: string): Array<[string, string]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry): Array<[string, string]> =>
    Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string' ? [[entry[0], entry[1]]] : [],
  );
}

function headerValue(headers: Array<[string, string]>, name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers.find(([n]) => n.toLowerCase() === lower)?.[1];
}

function extractEmail(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return (match ? match[1] : from).trim();
}

/** "Dana Cohen <d@x>" → "Dana Cohen"; '"Cohen, Dana" <d@x>' → "Cohen, Dana"; a bare address → undefined. */
export function extractDisplayName(from: string): string | undefined {
  const match = from.match(/^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/);
  const name = match?.[1]?.trim();
  return name ? name : undefined;
}

/**
 * Identity for a message without a usable Message-Id header. Mailgun's `token` is per delivery
 * ATTEMPT, so using it (the old fallback) gave every retry of one email a new identity → two
 * intake rows, two candidates. A content digest is stable across retries.
 */
export function fallbackMessageId(
  body: { from: string; subject: string; 'body-plain'?: string },
  dateHeader: string | undefined,
): string {
  const digest = createHash('sha256')
    .update([body.from, body.subject ?? '', dateHeader ?? '', (body['body-plain'] ?? '').slice(0, 2000)].join('\n'))
    .digest('hex');
  return `gen-${digest.slice(0, 40)}`;
}

/** {"<cid>": "attachment-N"} → Map(fieldname → cid without angle brackets). Malformed → empty map. */
function contentIdByField(raw: string | undefined): Map<string, string> {
  const byField = new Map<string, string>();
  if (!raw) return byField;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const [cid, field] of Object.entries(parsed)) {
      if (typeof field === 'string') byField.set(field, cid.replace(/^<|>$/g, ''));
    }
  } catch {
    // no inline detection for this message — same as before this field was read at all
  }
  return byField;
}

export function parseMailgunPayload(body: MailgunRawBodyDto, files: Express.Multer.File[]): EmailPayloadDto {
  const headers = parseMessageHeaders(body['message-headers']);
  // Strip RFC-2822 angle brackets so the value is safe as an R2 key path segment.
  const headerMessageId = headerValue(headers, 'message-id')
    ?.replace(/^<|>$/g, '')
    .trim();
  const messageId = headerMessageId || fallbackMessageId(body, headerValue(headers, 'date'));

  const cidByField = contentIdByField(body['content-id-map']);
  const displayName = extractDisplayName(body.from);
  const html = body['body-html'];

  // stripped-text loses the signature (contact data!) — glue it back. Fall back to the full
  // plain body when Mailgun's stripped variant is blank (e.g. a reply that is all quoted text).
  const strippedText = body['stripped-text']?.trim()
    ? [body['stripped-text'], body['stripped-signature']].filter((part): part is string => !!part?.trim()).join('\n\n')
    : undefined;

  return {
    MessageID: messageId,
    From: sanitizePgText(extractEmail(body.from)),
    FromName: displayName ? sanitizePgText(displayName) : undefined,
    Subject: sanitizePgText(body.subject ?? ''),
    TextBody: strippedText ?? body['body-plain'],
    PlainBody: body['body-plain'],
    HtmlBody: Array.isArray(html) ? html.join('\n') : html,
    Date: new Date(parseInt(body.timestamp, 10) * 1000).toISOString(),
    // Base64 Content is still required: the worker's AttachmentExtractorService reads
    // att.Content from payload.json in R2. See Task 5 for why the webhook no longer re-decodes it.
    Attachments: files.map((file) => ({
      Name: file.originalname,
      Content: file.buffer.toString('base64'),
      ContentType: file.mimetype,
      ContentLength: file.size,
      ContentID: cidByField.get(file.fieldname),
    })),
  };
}
