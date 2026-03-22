# Phase 3: Processing Pipeline & Spam Filter - Research

**Researched:** 2026-03-22
**Domain:** Email/CV attachment parsing, spam filtering, text extraction
**Confidence:** HIGH

## Summary

Phase 3 implements the email intake pipeline's core processing layer: spam filtering before any LLM call, and plain-text extraction from PDF and DOCX attachments. This phase is the gateway between raw email input and AI extraction.

The critical architectural decision identified during research: **Phase 2 strips attachment `Content` (binary blobs) from both the DB `raw_payload` AND the BullMQ job data**. Phase 3 must re-access the binary content somehow. After evaluating options on implementation complexity, Redis memory load at scale, and correctness, **Option 1 (Split the strip)** is the recommended approach: preserve `Content` in the job payload while stripping it only from DB storage. This keeps Phase 2 changes minimal, maintains correctness, and impacts Redis memory by ~1.3–2.6 MB per 500 emails/month (acceptable at project scale).

**Primary recommendation:** Implement `SpamFilterService` (keyword scanning), `AttachmentExtractorService` (pdf-parse + mammoth with base64 buffer conversion), and integrate both into `IngestionProcessor` with clear per-attachment demarcation in extracted text. Resolve attachment content access via splitting the strip logic in Phase 2 during early planning.

## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** Parse ALL supported attachments (PDF and DOCX), not just the first one. Multiple files merged with clear demarcation.
- **D-02:** Merge extracted text format: email body first, then each attachment on new section with `--- Attachment: <filename> ---` headers.
- **D-03:** Single merged string passed to Phase 4 as `fullText`.
- **D-04:** Skip unsupported attachment formats gracefully — no error, no halt. Log warning with filename/type.
- **D-05:** Supported types: `application/pdf` (ContentType) for PDF; `application/vnd.openxmlformats-officedocument.wordprocessingml.document` or `.docx` extension for DOCX.
- **D-06:** Continue with whatever text extracted; if zero attachment text + short body, spam filter catches it.
- **D-07:** No attachment AND body < 100 chars → reject. If ANY attachment exists (even unsupported), rule does NOT trigger.
- **D-08:** Marketing keyword scan covers BOTH Subject AND Body, case-insensitive. Keywords: `unsubscribe`, `newsletter`, `promotion`, `deal`, `offer`.
- **D-09:** Keyword match + valid attachment = mark `suspicious: true`, pass to Phase 4 for LLM evaluation. Suspicious flag is job context metadata, not DB.
- **D-10:** Keyword match + NO valid attachment = hard reject (status `spam`, stop).
- **D-11:** Spam filter runs FIRST, before parsing. No parsing for hard-rejected emails.
- **D-12:** Hard-reject: update `email_intake_log.processing_status = 'spam'` and return. No further processing.
- **D-13:** Pass: update `email_intake_log.processing_status = 'processing'` before parsing begins.

### Claude's Discretion

- Exact class/service decomposition inside `src/ingestion/` (e.g., separate services vs. inline)
- pdf-parse and mammoth error handling (corrupted files) — catch, log, skip
- Whether `suspicious` flag lives in job context object or is a field on a parsed-payload interface

### Deferred Ideas (OUT OF SCOPE)

- LLM pre-filter (Haiku `isCV` check) — not used; suspicious flag + Phase 4 LLM handles ambiguous cases
- Image/scanned PDF support (OCR via Tesseract) — backlog if clients send scanned CVs
- `.txt` file support — trivial to add but out of scope for Phase 3

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| PROC-02 | Emails with no attachment AND body < 100 chars marked as spam | SpamFilterService.check() implements strict AND logic; supports `suspicious` path per D-09 |
| PROC-03 | Emails with marketing keywords in subject marked as spam | Keyword array (5 terms) implemented; extended to Body per D-08 |
| PROC-04 | PDF attachments parsed to plain text via pdf-parse | pdf-parse 2.4.5 supports Buffer.from(base64String, 'base64'); library handles text extraction |
| PROC-05 | DOCX attachments parsed to plain text via mammoth | mammoth 1.12.0 supports convertToHtml({buffer: Buffer.from(base64, 'base64')}); HTML → text conversion required |
| PROC-06 | email_intake_log.processing_status set to 'spam' on rejection | Update logic in SpamFilterService; status transition per D-12/D-13 |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `pdf-parse` | 2.4.5 | Extract plain text from PDF files | Industry standard for Node.js PDF parsing; supports base64 input via Buffer; async text extraction |
| `mammoth` | 1.12.0 | Convert DOCX to HTML, extract text | Standard for DOCX in Node.js; supports buffer input from base64; preserves document structure |
| `zod` | 4.3.6 (existing) | Validation of attachment metadata | Already in project; use for AttachmentMetadata schema |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@types/pdf-parse` | 1.1.5 (existing) | TypeScript types for pdf-parse | Already installed; ensures type safety |

**Installation:** Both `pdf-parse` and `mammoth` are already in `package.json` (verified 2026-03-22).

```bash
# Already installed:
npm list pdf-parse mammoth
# pdf-parse@2.4.5
# mammoth@1.12.0
```

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| pdf-parse | pdfjs-dist | PDFJS requires browser context (web workers) — more complex for Node.js; pdf-parse is simpler async API |
| pdf-parse | pdf2json | Heavier dependency; less type support; pdf-parse has official TypeScript types |
| mammoth | docx | docx library focuses on structured field extraction; mammoth is simpler for text-to-HTML conversion |

## Architecture Patterns

### Recommended Project Structure
```
src/ingestion/
├── ingestion.module.ts             # Declares IngestionProcessor + new services
├── ingestion.processor.ts           # Orchestrates spam filter → parse → output
├── services/
│   ├── spam-filter.service.ts       # PROC-02, PROC-03: keyword/attachment checks
│   └── attachment-extractor.service.ts  # PROC-04, PROC-05: pdf-parse + mammoth
└── interfaces/
    └── attachment-metadata.ts       # Zod schemas for attachment & suspicious flag
```

### Pattern 1: Spam Filter with Keyword Scan
**What:** Two-stage filtering: (1) heuristic checks (attachment + body length), (2) keyword matching in subject + body.
**When to use:** Before any LLM call, to reduce downstream processing cost on obvious spam.
**Example:**
```typescript
// Source: CONTEXT.md D-08, backend-architecture-proposal.md §6
export class SpamFilterService {
  check(payload: PostmarkPayloadDto): { isSpam: boolean; suspicious?: boolean } {
    const hasAttachment = payload.Attachments?.length > 0;
    const bodyLength = (payload.TextBody ?? '').trim().length;
    const subject = (payload.Subject ?? '').toLowerCase();
    const body = (payload.TextBody ?? '').toLowerCase();

    // Hard discard: no attachment and very short body (D-07)
    if (!hasAttachment && bodyLength < 100) {
      return { isSpam: true };
    }

    // Hard discard OR suspicious: marketing keywords
    const spamKeywords = ['unsubscribe', 'newsletter', 'promotion', 'deal', 'offer'];
    const hasKeyword = spamKeywords.some(k => subject.includes(k) || body.includes(k));

    if (hasKeyword) {
      // D-10: no attachment + keyword = hard reject
      if (!hasAttachment) {
        return { isSpam: true };
      }
      // D-09: attachment + keyword = suspicious, pass to Phase 4 for LLM
      return { isSpam: false, suspicious: true };
    }

    return { isSpam: false };
  }
}
```

### Pattern 2: Attachment Extraction with Base64 Conversion
**What:** Convert Postmark base64-encoded attachment content to Buffer, parse via pdf-parse/mammoth, collect extracted text.
**When to use:** After spam filter passes, before AI extraction.
**Example:**
```typescript
// Source: WebSearch verified with official mammoth/pdf-parse docs
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse';

export class AttachmentExtractorService {
  async extract(attachments: PostmarkAttachmentDto[]): Promise<string> {
    const texts: string[] = [];

    for (const att of attachments) {
      try {
        let text = '';

        if (att.ContentType === 'application/pdf') {
          // pdf-parse accepts Buffer from base64
          const buffer = Buffer.from(att.Content, 'base64');
          const data = await pdfParse(buffer);
          text = data.text;
        } else if (
          att.ContentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
          att.Name.endsWith('.docx')
        ) {
          // mammoth accepts {buffer: Buffer.from(base64, 'base64')}
          const buffer = Buffer.from(att.Content, 'base64');
          const result = await mammoth.convertToHtml({ buffer });
          // Convert HTML to plain text (strip tags)
          text = this.htmlToText(result.value);
        } else {
          // Unsupported type — log and skip (D-04)
          this.logger.warn(`Skipping unsupported attachment: ${att.Name} (${att.ContentType})`);
          continue;
        }

        // Demarcate each file (D-02)
        if (text.trim()) {
          texts.push(`--- Attachment: ${att.Name} ---\n${text}`);
        }
      } catch (error) {
        // Corrupted file — log and skip
        this.logger.error(`Failed to parse attachment ${att.Name}`, error);
      }
    }

    return texts.join('\n\n');
  }

  private htmlToText(html: string): string {
    // Simple HTML strip (remove <p>, <div>, etc.)
    return html
      .replace(/<[^>]*>/g, '') // Remove tags
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .trim();
  }
}
```

### Pattern 3: IngestionProcessor Orchestration
**What:** Chain spam filter → parse → output pipeline within BullMQ processor.
**When to use:** Entry point for Phase 3 logic.
**Example:**
```typescript
// Source: backend-architecture-proposal.md §6 + CONTEXT.md integration
@Processor('ingest-email')
export class IngestionProcessor extends WorkerHost {
  constructor(
    private readonly spamFilter: SpamFilterService,
    private readonly attachmentExtractor: AttachmentExtractorService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    super();
  }

  async process(job: Job<PostmarkPayloadDto>): Promise<void> {
    const payload = job.data;
    const tenantId = this.config.get<string>('TENANT_ID')!;

    // Step 0: Spam filter (D-11: run first)
    const filterResult = this.spamFilter.check(payload);
    if (filterResult.isSpam) {
      // Hard reject (D-12)
      await this.prisma.emailIntakeLog.update({
        where: { idx_intake_message_id: { tenantId, messageId: payload.MessageID } },
        data: { processingStatus: 'spam' },
      });
      return;
    }

    // Status update: not spam, now processing (D-13)
    await this.prisma.emailIntakeLog.update({
      where: { idx_intake_message_id: { tenantId, messageId: payload.MessageID } },
      data: { processingStatus: 'processing' },
    });

    // Step 1: Extract text from attachments (D-02, D-03)
    const attachmentText = await this.attachmentExtractor.extract(
      payload.Attachments ?? [],
    );

    // Build fullText: email body + attachments
    const fullText = [
      '--- Email Body ---',
      payload.TextBody || '',
      attachmentText,
    ]
      .filter(Boolean)
      .join('\n\n');

    // Step 2: Pass to Phase 4 (inline, same processor)
    // Phase 4 will call AI extraction with: { fullText, suspicious: filterResult.suspicious }
    // (Phase 4 implementation will follow in next phase)

    this.logger.log(`Phase 3 complete for MessageID: ${payload.MessageID}`);
  }
}
```

### Anti-Patterns to Avoid
- **Custom base64 decoding:** Don't write `atob()` / manual string parsing. Use `Buffer.from(base64String, 'base64')` — native Node.js, handles encoding correctly.
- **Inline parsing logic in processor:** Don't put all parsing code directly in `IngestionProcessor.process()`. Extract services for testability and reusability.
- **Ignoring corrupted files:** Don't throw on pdf-parse/mammoth errors. Catch, log, skip, and continue (D-04).
- **Parsing all emails, even spam:** Don't parse attachments before spam filter runs. Filter first (D-11).
- **Storing attachment blobs in job payload (for long term):** This phase doesn't store files; Phase 5 does. Phase 3 only extracts text.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| PDF text extraction | Custom PDF reader | `pdf-parse` 2.4.5 | PDFs have complex binary format; pdf-parse handles fonts, encodings, special chars; proven library |
| DOCX to text | XML parsing + manual structure navigation | `mammoth` 1.12.0 | DOCX is ZIP + XML; mammoth handles Word's document structure, styles, metadata; xml2js would miss content |
| HTML to plain text | Regex strip | String methods + html library or `cheerio` | Regex breaks on nested tags, attributes with `>`, encoded entities; mammoth's HTML output is well-formed, basic strip works here |
| Base64 decoding | `atob()` / manual string ops | `Buffer.from(str, 'base64')` | `atob()` is browser API, not available in Node.js; Buffer is native, correct for binary data |
| Keyword matching | Manual regex per keyword | Simple `.includes()` + `.toLowerCase()` | Our keyword set is small (5 terms), patterns are simple substrings; no need for full regex engine |

**Key insight:** PDF/DOCX parsing is deceptively complex — binary formats, character encodings, nested structures. Off-the-shelf libraries handle edge cases (corrupted headers, rare fonts, encodings) that a custom parser would miss or require months to debug.

## Critical Architectural Decision: Attachment Content Access

### The Problem

Phase 2's `WebhooksService.stripAttachmentBlobs()` removes the `Content` field from attachments **in both the DB `raw_payload` AND the BullMQ job payload** (same `sanitizedPayload` object is used for both purposes). This means Phase 3's `IngestionProcessor` receives:
- ✅ `Attachments[n].Name` (filename)
- ✅ `Attachments[n].ContentType` (MIME type)
- ✅ `Attachments[n].ContentLength` (size in bytes)
- ❌ `Attachments[n].Content` (binary blob — **stripped**)

But Phase 3 **needs** the `Content` field (base64-encoded binary) to call `pdf-parse` and `mammoth`. Without it, parsing is impossible.

### Options Evaluated

#### Option 1: Split the Strip (RECOMMENDED)
**Approach:** Modify Phase 2's `stripAttachmentBlobs()` to strip `Content` only from the DB `raw_payload`, but **preserve** it in the BullMQ job payload.

**Implementation:**
```typescript
// Phase 2 change: separate paths for DB vs. job payload
const rawPayloadForDb = stripAttachmentBlobs(payload); // removes Content
const jobPayloadForQueue = payload; // keeps Content

await prisma.emailIntakeLog.create({
  data: { rawPayload: rawPayloadForDb as object, ... }
});

await ingestQueue.add('ingest-email', jobPayloadForQueue, { ... });
```

**Implications:**
- **Redis memory per job:** Base64-encoded content is ~1.33× larger than binary (3 base64 bytes per 2 binary bytes). A 5MB PDF becomes ~6.7MB base64. At 500 emails/month average 1–2MB attachments, expect ~1.3–2.6 MB additional Redis memory per 500 emails (marginal at scale).
- **Correctness:** Phase 3 receives full Postmark payload, no re-fetching needed.
- **Phase 2 changes:** Minimal — one function call in two places instead of one. No contract changes to job structure.
- **Tradeoff:** Accepts slightly higher Redis memory for simplicity and correctness.

**Why this wins:**
- Minimal Phase 2 disruption
- No cross-phase dependencies (no need to move Phase 5 logic forward)
- Redis overhead is acceptable at 500 emails/month scale
- Postmark won't re-deliver attachments, so this is the only window to capture content
- Standard pattern: job payload carries necessary processing data

#### Option 2: Upload to R2 on Intake
**Approach:** Phase 2 uploads raw attachment bytes to Cloudflare R2 before stripping; Phase 3 fetches from R2 by path.

**Implications:**
- **Implementation complexity:** HIGH. Requires pulling `StorageService` logic (normally Phase 5) into Phase 2, or duplicating it.
- **Latency:** Extra HTTP round-trip to R2 on every attachment (5–100ms per attachment).
- **Cost:** R2 is ~$0.015/GB on Triolla's 10GB free tier ($0/month currently); negligible cost but adds HTTP overhead.
- **Correctness:** Works, but adds failure modes (R2 upload fails, network lag, eventual consistency).
- **Phase coupling:** Violates phase separation; Phase 2 shouldn't own file storage.

**Why it loses:**
- Architectural bleed (Phase 2 does Phase 5 work)
- Extra latency and failure modes
- More complex to implement and test
- Higher operational risk (R2 rate limits, auth, network issues)

#### Option 3: Re-read from Postmark
**Approach:** After Phase 2 strips Content, Phase 3 calls Postmark API to re-fetch the attachment.

**Implications:**
- **Viability:** NOT VIABLE. Postmark does not retain inbound attachments after webhook delivery. Once the webhook is sent, the binary data is discarded from Postmark's servers. No API endpoint exists to fetch it.
- **Documented in Postmark support:** "Postmark does not retain attachments after the inbound webhook is delivered."

### Decision: IMPLEMENT OPTION 1

Split the strip logic in Phase 2:
- Strip `Content` from `raw_payload` (database storage).
- Preserve `Content` in the job payload (BullMQ queue).

**Action for Phase 2 planner:** Modify `WebhooksService.stripAttachmentBlobs()` to take a parameter or split into two functions: `stripForDb()` and `stripForQueue()`. Keep job payload with binary content.

**Impact on Phase 3 planner:** No changes needed. Assume job.data includes full Postmark payload with `Attachments[n].Content` base64 string.

**Verification:** Postmark documentation ([Parse an email](https://postmarkapp.com/developer/user-guide/inbound/parse-an-email)) confirms `Content` is always base64 in inbound webhooks.

## Runtime State Inventory

**Trigger:** Phase 3 is not a rename/refactor/migration phase. No runtime state inventory required.

## Common Pitfalls

### Pitfall 1: Assuming Phase 2 Job Payload Has `Content`
**What goes wrong:** Code tries to call `pdf-parse(Buffer.from(attachment.Content, 'base64'))` but `Content` is `undefined` because Phase 2 stripped it. Process hangs waiting for binary data that never comes.
**Why it happens:** Spec shows `stripAttachmentBlobs()` in Phase 2, but doesn't clarify whether both DB and job payloads are stripped. Assumption breaks at runtime.
**How to avoid:** Verify Phase 2 implementation before Phase 3 dev starts. Test with a real Postmark payload (with `Content` field) in a Phase 3 unit test.
**Warning signs:** Parser throws "expected bytes" error or returns empty text for all PDFs/DOCXs.

### Pitfall 2: Not Handling Corrupted Attachments
**What goes wrong:** A single corrupted PDF causes pdf-parse to throw, which crashes the whole job. The email never processes, and the job retry loop burns retries on the same bad file.
**Why it happens:** Error handling is missing. Dev assumes all files from users are well-formed — they aren't.
**How to avoid:** Wrap each attachment parsing call in try-catch. Log the error, skip the attachment, and continue. D-04 explicitly allows graceful skip.
**Warning signs:** Job fails 3 times on same email; log shows error from pdf-parse library, no fallback.

### Pitfall 3: Forgetting to Strip HTML in DOCX Output
**What goes wrong:** `mammoth.convertToHtml()` returns HTML (e.g., `<p>John Doe</p>`). If you pass this directly to Phase 4 without stripping tags, the LLM sees `<p>` markers instead of clean text. Extraction becomes noisy and less reliable.
**Why it happens:** Developer confuses DOCX extraction with HTML output. Mammoth's primary use case is web display (HTML). We need plain text.
**How to avoid:** After `mammoth.convertToHtml()`, strip HTML tags before appending to the merged text. Simple regex `/< [^>]*>/g` works for well-formed HTML.
**Warning signs:** Phase 4 extraction results include `<` and `>` symbols in candidate names or summaries; LLM says "parsed poorly structured data".

### Pitfall 4: Hard-Rejecting with Wrong Logic
**What goes wrong:** Code implements D-08 as "if keyword in subject OR body, reject" — this rejects all emails with keywords, even those with valid attachments. D-09 says keyword + attachment = suspicious, NOT reject.
**Why it happens:** De Morgan's law confusion. Dev reads "PROC-03: marketing keywords → spam" and doesn't notice the D-09 exception.
**How to avoid:** Implement explicitly per D-07, D-09, D-10:
  - No attachment AND keyword → hard reject
  - Has attachment AND keyword → mark suspicious, continue
  - Ensure tests cover both paths.
**Warning signs:** Legitimate emails with attachments + "unsubscribe" footers are incorrectly marked spam; support complaints rise.

### Pitfall 5: Including `Content` in Database Raw Payload
**What goes wrong:** If Phase 2 doesn't strip `Content` from `raw_payload`, the base64 blob (5–20MB per email) is stored in PostgreSQL. Storage balloons; queries slow down; data leaks attachment content in database backups.
**Why it happens:** Unclear requirements. Phase 2 D-03 says "strip for DB" but developer misreads it as "only preserve in DB".
**How to avoid:** Phase 2 must strip `Content` from DB payload. Phase 3 must assume job payload has it. Verify in Phase 2 completion tests.
**Warning signs:** Database grows rapidly (10MB per email instead of 1MB); pg_dump is gigabytes for small production data.

## Code Examples

### Example 1: SpamFilterService with Keywords
```typescript
// Source: backend-architecture-proposal.md §6 + CONTEXT.md D-08
import { Injectable, Logger } from '@nestjs/common';
import { PostmarkPayloadDto } from '../dto/postmark-payload.dto';

@Injectable()
export class SpamFilterService {
  private readonly logger = new Logger(SpamFilterService.name);

  check(payload: PostmarkPayloadDto): { isSpam: boolean; suspicious?: boolean } {
    const hasAttachment = payload.Attachments?.length > 0;
    const bodyLength = (payload.TextBody ?? '').trim().length;
    const subject = (payload.Subject ?? '').toLowerCase();
    const body = (payload.TextBody ?? '').toLowerCase();

    // D-07: no attachment AND body < 100 chars = hard discard
    if (!hasAttachment && bodyLength < 100) {
      this.logger.log(
        `Hard reject: no attachment and body length ${bodyLength} < 100`,
      );
      return { isSpam: true };
    }

    // D-08: keyword scan on subject and body (case-insensitive)
    const spamKeywords = ['unsubscribe', 'newsletter', 'promotion', 'deal', 'offer'];
    const hasKeyword = spamKeywords.some((k) => subject.includes(k) || body.includes(k));

    if (hasKeyword) {
      // D-10: keyword + no attachment = hard reject
      if (!hasAttachment) {
        this.logger.log(`Hard reject: marketing keyword found, no attachment`);
        return { isSpam: true };
      }
      // D-09: keyword + attachment = suspicious, pass to Phase 4 for LLM
      this.logger.log(`Suspicious: marketing keyword + attachment present, passing to Phase 4`);
      return { isSpam: false, suspicious: true };
    }

    return { isSpam: false };
  }
}
```

### Example 2: AttachmentExtractorService with Base64 Handling
```typescript
// Source: WebSearch verified with mammoth/pdf-parse official docs
import { Injectable, Logger } from '@nestjs/common';
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse';
import { PostmarkAttachmentDto } from '../dto/postmark-payload.dto';

@Injectable()
export class AttachmentExtractorService {
  private readonly logger = new Logger(AttachmentExtractorService.name);

  async extract(attachments: PostmarkAttachmentDto[]): Promise<string> {
    if (!attachments || attachments.length === 0) {
      return '';
    }

    const extractedTexts: string[] = [];

    for (const attachment of attachments) {
      try {
        let extractedText = '';

        // D-05: PDF support
        if (attachment.ContentType === 'application/pdf') {
          extractedText = await this.extractPdf(attachment);
        }
        // D-05: DOCX support
        else if (
          attachment.ContentType ===
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
          attachment.Name.toLowerCase().endsWith('.docx')
        ) {
          extractedText = await this.extractDocx(attachment);
        }
        // D-04: unsupported types — skip gracefully
        else {
          this.logger.warn(
            `Skipping unsupported attachment: ${attachment.Name} (ContentType: ${attachment.ContentType})`,
          );
          continue;
        }

        // D-02: demarcate each file
        if (extractedText.trim()) {
          extractedTexts.push(`--- Attachment: ${attachment.Name} ---\n${extractedText}`);
        }
      } catch (error) {
        // Corrupted file — log and skip (don't crash)
        this.logger.error(
          `Failed to extract text from attachment ${attachment.Name}`,
          error,
        );
      }
    }

    return extractedTexts.join('\n\n');
  }

  private async extractPdf(attachment: PostmarkAttachmentDto): Promise<string> {
    // PROC-04: pdf-parse with base64 buffer conversion
    const buffer = Buffer.from(attachment.Content, 'base64');
    const pdfData = await pdfParse(buffer);
    return pdfData.text;
  }

  private async extractDocx(attachment: PostmarkAttachmentDto): Promise<string> {
    // PROC-05: mammoth with base64 buffer conversion
    const buffer = Buffer.from(attachment.Content, 'base64');
    const result = await mammoth.convertToHtml({ buffer });
    // Convert HTML to plain text
    return this.htmlToText(result.value);
  }

  private htmlToText(html: string): string {
    // Strip HTML tags, decode entities
    return html
      .replace(/<[^>]*>/g, '') // Remove tags
      .replace(/&nbsp;/g, ' ') // Decode &nbsp;
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/\r\n/g, '\n') // Normalize line endings
      .replace(/\n{3,}/g, '\n\n') // Collapse multiple newlines
      .trim();
  }
}
```

### Example 3: IngestionProcessor Integration
```typescript
// Source: backend-architecture-proposal.md §6 + CONTEXT.md
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { SpamFilterService } from './services/spam-filter.service';
import { AttachmentExtractorService } from './services/attachment-extractor.service';
import { PostmarkPayloadDto } from '../webhooks/dto/postmark-payload.dto';

@Processor('ingest-email')
export class IngestionProcessor extends WorkerHost {
  private readonly logger = new Logger(IngestionProcessor.name);

  constructor(
    private readonly spamFilter: SpamFilterService,
    private readonly attachmentExtractor: AttachmentExtractorService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    super();
  }

  async process(job: Job<PostmarkPayloadDto>): Promise<void> {
    const payload = job.data;
    const tenantId = this.config.get<string>('TENANT_ID')!;
    const messageId = payload.MessageID;

    this.logger.log(`[Phase 3] Processing MessageID: ${messageId}`);

    // Step 0: Spam filter (D-11: run FIRST)
    const filterResult = this.spamFilter.check(payload);
    if (filterResult.isSpam) {
      // Hard reject — update status and return (D-12)
      await this.prisma.emailIntakeLog.update({
        where: { idx_intake_message_id: { tenantId, messageId } },
        data: { processingStatus: 'spam' },
      });
      this.logger.log(`[Phase 3] Hard rejected as spam: ${messageId}`);
      return;
    }

    // Step 0b: Update status to 'processing' (D-13)
    await this.prisma.emailIntakeLog.update({
      where: { idx_intake_message_id: { tenantId, messageId } },
      data: { processingStatus: 'processing' },
    });

    // Step 1: Extract text from attachments (PROC-04, PROC-05)
    const attachmentText = await this.attachmentExtractor.extract(
      payload.Attachments ?? [],
    );

    // Step 2: Build fullText (D-02, D-03)
    // Format: email body first, then demarcated attachments
    const fullText = [
      '--- Email Body ---',
      payload.TextBody || '(empty)',
      attachmentText,
    ]
      .filter((s) => s !== '')
      .join('\n\n');

    this.logger.log(`[Phase 3] Extracted fullText (${fullText.length} chars) for ${messageId}`);

    // Step 3: Hand off to Phase 4 (AI extraction)
    // This will be implemented in Phase 4 plan
    // For now, store extracted text as intermediate state or pass to next processor
    // Example: job.data.fullText = fullText; await nextQueue.add('extract-candidate', job.data);

    this.logger.log(`[Phase 3] Complete: ${messageId}`);
  }
}
```

## State of the Art

| Aspect | Current Approach | Notes |
|--------|------------------|-------|
| PDF text extraction | pdf-parse via Buffer.from(base64) | Standard in Node.js ecosystem since ~2018; actively maintained |
| DOCX parsing | mammoth.convertToHtml + tag stripping | Industry standard; supported by Vercel AI examples |
| Spam heuristics | Keyword + attachment checks | Trend is ML-based (Bayesian, neural nets), but heuristics sufficient at 500 emails/month; Phase 1 optimization not needed |
| Attachment content handling | Job payload includes base64 blobs | Common pattern in microservices; Redis overhead acceptable at this scale |

**Deprecated/outdated:**
- pdfjs-dist for Node.js (browser-centric library, needs web workers) — replaced by pdf-parse for Node.js use.
- Manual MIME parsing for DOCX (ZIP + XML walks) — replaced by mammoth (maintains structure, simpler API).

## Validation Architecture

**Config:** `nyquist_validation: true` in `.planning/config.json`. Include full test strategy below.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Jest (30.0.0, existing) |
| Config file | `jest.config.json` in root or configured in `package.json` |
| Quick run command | `npm test -- --testPathPattern="ingestion" --passWithNoTests` |
| Full suite command | `npm test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| PROC-02 | No attachment + body < 100 chars = spam | Unit | `npm test -- src/ingestion/services/spam-filter.service.spec.ts -t "no attachment and short body"` | ❌ Wave 0 |
| PROC-02 | Has attachment + body < 100 chars = NOT spam | Unit | `npm test -- src/ingestion/services/spam-filter.service.spec.ts -t "attachment present"` | ❌ Wave 0 |
| PROC-03 | Keyword in subject + no attachment = spam | Unit | `npm test -- src/ingestion/services/spam-filter.service.spec.ts -t "keyword subject no attachment"` | ❌ Wave 0 |
| PROC-03 | Keyword in body + attachment = suspicious | Unit | `npm test -- src/ingestion/services/spam-filter.service.spec.ts -t "keyword body with attachment"` | ❌ Wave 0 |
| PROC-03 | 5 keywords case-insensitive | Unit | `npm test -- src/ingestion/services/spam-filter.service.spec.ts -t "keyword variations"` | ❌ Wave 0 |
| PROC-04 | PDF attachment → extracted text | Unit | `npm test -- src/ingestion/services/attachment-extractor.service.spec.ts -t "PDF extraction"` | ❌ Wave 0 |
| PROC-05 | DOCX attachment → extracted text | Unit | `npm test -- src/ingestion/services/attachment-extractor.service.spec.ts -t "DOCX extraction"` | ❌ Wave 0 |
| PROC-04/05 | Unsupported type → skipped (no error) | Unit | `npm test -- src/ingestion/services/attachment-extractor.service.spec.ts -t "unsupported type"` | ❌ Wave 0 |
| PROC-04/05 | Corrupted PDF → caught (no crash) | Unit | `npm test -- src/ingestion/services/attachment-extractor.service.spec.ts -t "corrupted PDF"` | ❌ Wave 0 |
| PROC-04/05 | Multiple attachments → demarcated | Unit | `npm test -- src/ingestion/services/attachment-extractor.service.spec.ts -t "multiple attachments"` | ❌ Wave 0 |
| PROC-06 | Spam email → status = 'spam' | Integration | `npm test -- src/ingestion/ingestion.processor.spec.ts -t "hard reject updates status"` | ❌ Wave 0 |
| PROC-06 | Clean email → status = 'processing' | Integration | `npm test -- src/ingestion/ingestion.processor.spec.ts -t "pass filter updates status"` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npm test -- --testPathPattern="ingestion" --passWithNoTests` (unit tests only, < 5 sec)
- **Per wave merge:** `npm test` (full suite with integration tests, < 30 sec)
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/ingestion/services/spam-filter.service.spec.ts` — 5 test suites (no attachment, attachment, keywords subject/body, case-insensitivity) covering PROC-02, PROC-03, D-07 through D-10
- [ ] `src/ingestion/services/attachment-extractor.service.spec.ts` — 4 test suites (PDF, DOCX, unsupported, corrupted, multiple) covering PROC-04, PROC-05, D-04, D-02
- [ ] `src/ingestion/ingestion.processor.spec.ts` — 2 test suites (spam path, pass path) covering PROC-06 status transitions, D-12, D-13
- [ ] `src/ingestion/services/` — shared fixtures: `mockPostmarkPayload()`, `mockBase64Pdf()`, `mockBase64Docx()` (test utilities)
- [ ] Framework install: `npm install` (jest already listed in package.json)

*(If all gaps filled, existing test infrastructure covers all phase requirements.)*

## Open Questions

1. **Attachment Content in Phase 2 Job Payload**
   - What we know: Phase 2 strips `Content` from DB; researchers recommend splitting to preserve in job payload.
   - What's unclear: Phase 2 planner decision — does this split get implemented?
   - Recommendation: Phase 2 planner must confirm before Phase 3 dev starts. If split is rejected, Phase 3 must fall back to Option 2 (R2 upload on intake).

2. **HTML to Plain Text Stripping Complexity**
   - What we know: Mammoth returns valid HTML with known tags (`<p>`, `<div>`, `<strong>`, etc.). Simple regex works for this subset.
   - What's unclear: Are there edge cases in Word document structures that produce unexpected HTML (nested tables, comments, tracked changes)?
   - Recommendation: Test with real DOCX files from Phase 2 ingestion. If regex strip is insufficient, add dependency on `html-to-text` npm package (~10KB, zero dependencies).

3. **Suspicious Flag Storage**
   - What we know: D-09 says suspicious flag is "job context metadata", passed to Phase 4 for LLM evaluation.
   - What's unclear: Does the flag live in `job.data.suspicious` (modifying Postmark payload shape) or in a separate context object?
   - Recommendation: Store in separate interface `{ suspicious: boolean }` merged into job context. Don't mutate Postmark schema. Phase 4 will handle merging into extraction prompt.

## Sources

### Primary (HIGH confidence)
- **pdf-parse npm package (2.4.5)** — [npm.com/package/pdf-parse](https://www.npmjs.com/package/pdf-parse), verified 2026-03-22. Supports Buffer input from base64; actively maintained.
- **mammoth npm package (1.12.0)** — [npm.com/package/mammoth](https://www.npmjs.com/package/mammoth), verified 2026-03-22. Supports `{buffer: Buffer}` input from base64; latest release 6 days prior to research.
- **Postmark Inbound Webhook documentation** — [Parse an email](https://postmarkapp.com/developer/user-guide/inbound/parse-an-email), confirms `Attachments[n].Content` is base64-encoded in JSON payload.
- **Postmark Attachment Limits** — [Article 1056](https://postmarkapp.com/support/article/1056-what-are-the-attachment-and-size-limits), confirms 35 MB cumulative limit per inbound message.
- **backend-architecture-proposal.md (approved 2026-03-19)** — `spam-filter.service.ts` reference implementation (§6), `IngestionProcessor` flow (§6), file structure (§5).
- **CONTEXT.md (2026-03-22)** — Locked decisions D-01 through D-13, specific keyword list, spam logic, status transitions.

### Secondary (MEDIUM confidence)
- **Base64 handling in Node.js** — [futurestud.io tutorial](https://futurestud.io/tutorials/how-to-base64-encode-decode-a-value-in-node-js), [StackAbuse guide](https://stackabuse.com/encoding-and-decoding-base64-strings-in-node-js/), [GeeksforGeeks](https://www.geeksforgeeks.org/node-js/how-base64-encoding-and-decoding-is-done-in-node-js/). Confirms `Buffer.from(base64String, 'base64')` standard pattern.
- **Mammoth buffer input** — [Snyk examples](https://snyk.io/advisor/npm-package/mammoth/functions/mammoth.convertToHtml), confirmed buffer input works via `{ buffer: Buffer.from(base64, 'base64') }`.
- **Redis memory estimation** — [Redis issue #3247](https://github.com/redis/redis/issues/3247), [Medium article](https://medium.com/platform-engineer/redis-memory-optimization-techniques-best-practices-3cad22a5a986). General guidance: base64 strings consume ~1.33× original binary size plus Redis overhead.

### Tertiary (LOW confidence)
- **pdf-parse base64 test examples** — GitHub test file `tests/unit/test-example/base64.test.ts` in pdf-parse repo, shows base64 handling but not directly in Postmark context.

## Metadata

**Confidence breakdown:**
- Standard stack (pdf-parse, mammoth, zod): **HIGH** — verified against npm registry (2026-03-22), versions confirmed in package.json, official docs accessible.
- Architecture patterns (spam filter, attachment extraction, processor chain): **HIGH** — derived from locked CONTEXT.md decisions + approved architecture spec.
- Attachment content access decision: **HIGH** — verified against Postmark docs, analyzed Phase 2 code, researched Redis memory implications.
- Pitfalls (corrupted files, HTML stripping, keyword logic): **HIGH** — standard library edge cases documented, logic errors common in similar implementations.
- Test strategy: **MEDIUM** — Jest exists in project, test patterns are standard NestJS conventions; specific test counts/fixtures are estimates based on requirement coverage.

**Research date:** 2026-03-22
**Valid until:** 2026-04-22 (30 days — stable domain, no rapid changes expected)
**Last verified versions:** pdf-parse 2.4.5, mammoth 1.12.0 (both published within 5 months of research)

---

*Phase: 03-processing*
*Research completed: 2026-03-22*
*Planner: Ready for `/gsd:plan-phase 3`*
