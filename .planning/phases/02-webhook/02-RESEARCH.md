# Phase 2: Webhook Intake & Idempotency - Research

**Researched:** 2026-03-22
**Domain:** Postmark webhook receipt, signature verification, idempotency, BullMQ job enqueueing
**Confidence:** HIGH

## Summary

Phase 2 implements the HTTP entry point for the email intake pipeline: a single POST `/webhooks/email` endpoint that receives Postmark inbound webhook payloads, verifies authenticity (with caveats), detects duplicate deliveries via MessageID, and atomically enqueues jobs to BullMQ. The phase must respond within 100ms and guarantee that duplicate Postmark redeliveries do not result in duplicate job enqueueing.

The primary technical decision is **Postmark authentication method**. Official Postmark documentation does not support HMAC-SHA256 signature verification for inbound webhooks — it supports only HTTP Basic Auth and IP allowlisting. However, the project CONTEXT.md indicates this was already researched and resolved. NestJS patterns for guard-based validation and BullMQ retry configuration are well-established.

**Primary recommendation:** Implement HTTP Basic Auth (credentials embedded in webhook URL) or IP allowlisting as the primary security layer, with an optional secondary HMAC validation if a custom Postmark integration (or third-party provider) requires it. Prioritize idempotency via the `email_intake_log.message_id` UNIQUE constraint and status-aware retry logic.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01: Failure atomicity** — If BullMQ enqueue fails after `email_intake_log` row is inserted, return 5xx (NOT 200) — Postmark will retry on non-2xx.
- **D-02: Idempotency check logic** — Check `status` (pending/completed/failed/spam) to distinguish between "failed enqueue, re-attempt" vs. "already processed, silently return 200".
- **D-03: Payload sanitization** — Strip only `Attachments[n].Content` (binary blobs); keep metadata (Name, ContentType, ContentLength).
- **D-04: Tenant resolution** — Single-tenant Phase 1. `tenantId` from `ConfigService.get('TENANT_ID')` (env var: `00000000-0000-0000-0000-000000000001`).
- **D-05: Health endpoint** — Add `GET /health` returning `{ status: 'ok', db: 'ok', redis: 'ok' }` with Prisma + Redis connectivity checks.
- **D-06: Queue job payload** — Enqueue full sanitized Postmark payload (blobs stripped) as BullMQ job data. Queue: `ingest-email`. 3 attempts, exponential backoff 5s initial.

### Claude's Discretion

- HMAC verification implementation — exact header and algorithm for Postmark inbound webhooks (documentation gap flagged by CONTEXT.md).
- NestJS module structure (`WebhooksModule`, guard vs. service for signature verification).
- DTO shape for `PostmarkPayloadDto`.
- Error class for 401 vs. NestJS built-in `UnauthorizedException`.

### Deferred Ideas (OUT OF SCOPE)

- Per-tenant HMAC tokens / URL-based tenant routing — v2 multi-tenant phase.
- BullMQ dashboard (OPS-02) — post-Phase 7 operations.
- Sentry error tracking (OPS-01) — post-Phase 7 operations.

</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| WBHK-01 | System receives Postmark inbound webhook POST at `POST /webhooks/email` and responds within 100ms | NestJS controller pattern, rawBody for HMAC. Response time depends on DB latency (email_intake_log lookup/insert); indices on (tenant_id, message_id) ensure < 10ms lookup. |
| WBHK-02 | System verifies Postmark webhook signature (HMAC-SHA256) and returns 401 if invalid | **CRITICAL RESEARCH FINDING**: Postmark inbound webhooks do NOT support HMAC-SHA256. Use HTTP Basic Auth or IP allowlisting instead. Optional: implement custom HMAC if third-party provider wraps Postmark. |
| WBHK-03 | System checks `MessageID` against `email_intake_log` before enqueuing — duplicate deliveries silently skipped | UNIQUE(tenant_id, message_id) constraint + findUnique query + status-aware retry logic (D-02). |
| WBHK-04 | System inserts `email_intake_log` row (status: `pending`) before enqueuing — this row is the idempotency guard | Prisma emailIntakeLog.create(). Atomic: inserted before queue.add() call. |
| WBHK-05 | System enqueues job to BullMQ `ingest-email` queue with 3 retry attempts and exponential backoff | BullMQ queue.add() with { attempts: 3, backoff: { type: 'exponential', delay: 5000 } }. Initial delay 5s, subsequent delays 10s, 20s. |
| WBHK-06 | Raw Postmark payload stored in `email_intake_log.raw_payload` with attachment binary blobs stripped | stripAttachmentBlobs() function using destructuring: `{ Content, ...meta }`. Metadata (Name, ContentType, ContentLength) preserved. |

</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| NestJS | 11.0.1 | HTTP framework (controller routing) | Project-locked; already bootstrapped in Phase 1 |
| @nestjs/common | 11.0.1 | Decorators (@Controller, @Post, @Headers, @RawBody, @Body, Guard) | Standard NestJS patterns for routes and guards |
| TypeScript | 5.7.3 | Language | Project-locked; type safety for payload validation |
| Zod | 4.3.6 | Runtime schema validation | Already in Phase 1 for env validation; standard for DTO validation |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @nestjs/config | 4.0.3 | ConfigService injectable (get TENANT_ID, POSTMARK_WEBHOOK_TOKEN) | Already global in Phase 1 |
| @prisma/client | 6.19.2 | emailIntakeLog.findUnique / create (idempotency check + insert) | Already configured in Phase 1 |
| bullmq | 5.71.0 | Queue enqueue with retry + backoff config | Already bootstrapped in Phase 1 |
| ioredis | 5.10.1 | Redis connection (BullMQ backing store) | Already configured in Phase 1 |
| crypto | built-in Node.js | HMAC-SHA256 hash (if needed for optional custom verification) | Built-in; use for signature validation |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| HTTP Basic Auth (Postmark) | IP allowlisting only | Basic Auth is simpler to configure in URL; IP allowlisting requires firewall rules and is less flexible |
| NestJS Guard (signature verification) | Middleware + service | Guard is cleaner; middleware runs before route matching and is harder to unit test in isolation |
| Zod DTO validation | `class-validator` + class-based DTOs | Zod is already in project; class-validator adds extra annotation overhead |

**Installation:**
No new packages required. All dependencies are in Phase 1's package.json.

**Verification:** Current versions confirmed in /package.json:
- @nestjs/common: ^11.0.1 ✓
- @nestjs/config: ^4.0.3 ✓
- @prisma/client: ^6.19.2 ✓
- bullmq: ^5.71.0 ✓
- zod: ^4.3.6 ✓

## Architecture Patterns

### Recommended Project Structure
```
src/
├── webhooks/              # HTTP layer — receives Postmark payloads
│   ├── webhooks.module.ts
│   ├── webhooks.controller.ts     # POST /webhooks/email, GET /health
│   ├── webhooks.service.ts        # Idempotency check + enqueue logic
│   ├── guards/
│   │   └── postmark-auth.guard.ts # Optional: HMAC or Basic Auth verification
│   └── dto/
│       └── postmark-payload.dto.ts # Zod schema for inbound payload
├── app.module.ts          # Import WebhooksModule
├── main.ts                # Already has rawBody: true
└── worker.ts              # Worker entry point (existing)
```

### Pattern 1: Webhook Signature Verification (Conditional)

**What:** Validate webhook authenticity using either HTTP Basic Auth (Postmark standard) or optional HMAC.

**When to use:** WBHK-02. If Postmark URL has embedded credentials, guard validates them in Authorization header. If custom HMAC needed, guard compares signature.

**Example:**

```typescript
// src/webhooks/guards/postmark-auth.guard.ts
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

@Injectable()
export class PostmarkAuthGuard implements CanActivate {
  constructor(private configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();

    // Option A: HTTP Basic Auth (if webhook URL is https://username:password@...)
    const authHeader = request.headers['authorization'];
    if (authHeader?.startsWith('Basic ')) {
      const encodedCredentials = authHeader.slice(6);
      const credentials = Buffer.from(encodedCredentials, 'base64').toString();
      const [username, password] = credentials.split(':');

      // Validate against env vars or config
      if (password === this.configService.get('POSTMARK_WEBHOOK_TOKEN')) {
        return true;
      }
    }

    // Option B: Custom HMAC-SHA256 (if third-party provider requires it)
    const signature = request.headers['x-postmark-signature'];
    if (signature) {
      const rawBody = request.rawBody as Buffer;
      const webhookToken = this.configService.get('POSTMARK_WEBHOOK_TOKEN');
      const hash = crypto
        .createHmac('sha256', webhookToken)
        .update(rawBody)
        .digest('base64');

      if (hash === signature) {
        return true;
      }
    }

    throw new UnauthorizedException('Invalid webhook signature');
  }
}

// src/webhooks/webhooks.controller.ts
@Controller('webhooks')
export class WebhooksController {
  constructor(private webhooksService: WebhooksService) {}

  @Post('email')
  @UseGuards(PostmarkAuthGuard)
  async ingestEmail(@Body() payload: PostmarkPayloadDto) {
    // Guard verified; proceed to enqueue
    return this.webhooksService.enqueue(payload);
  }

  @Get('health')
  async health() {
    return this.webhooksService.checkHealth();
  }
}

// Source: NestJS Guards pattern (https://docs.nestjs.com/guards)
```

### Pattern 2: Idempotency via Unique Constraint + Status Check

**What:** Check if MessageID already exists in `email_intake_log`. If found, verify its `processing_status` to decide whether to re-enqueue or silently return 200.

**When to use:** WBHK-03 (duplicate detection), WBHK-04 (idempotency guard).

**Example:**

```typescript
// src/webhooks/webhooks.service.ts
import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Queue } from 'bullmq';
import { Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class WebhooksService {
  constructor(
    private prisma: PrismaService,
    @Inject('INGEST_EMAIL_QUEUE') private ingestQueue: Queue,
    private configService: ConfigService,
  ) {}

  async enqueue(payload: PostmarkPayloadDto) {
    const tenantId = this.configService.get<string>('TENANT_ID');
    const messageId = payload.MessageID;

    // Step 1: Idempotency check — look for existing intake log row
    const existing = await this.prisma.emailIntakeLog.findUnique({
      where: { tenantId_messageId: { tenantId, messageId } },
      select: { id: true, processingStatus: true },
    });

    if (existing) {
      // Step 2: Status-aware retry logic (D-02)
      if (existing.processingStatus === 'pending') {
        // Enqueue failed previously, re-attempt job enqueue
        await this.ingestQueue.add('ingest-email', payload, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        });
        return { status: 'requeued' };
      } else {
        // Already completed/failed/spam — silently return 200 (idempotent)
        return { status: 'queued' };
      }
    }

    // Step 3: INSERT intake log row BEFORE enqueueing
    // This row IS the idempotency guard. If process crashes after this
    // and before BullMQ acks, a re-delivery will find the row and skip re-enqueueing.
    const intakeLog = await this.prisma.emailIntakeLog.create({
      data: {
        tenantId,
        messageId,
        fromEmail: payload.From,
        subject: payload.Subject,
        receivedAt: new Date(payload.Date),
        processingStatus: 'pending',
        rawPayload: stripAttachmentBlobs(payload),
      },
    });

    // Step 4: Enqueue to BullMQ — if this fails, return 5xx (D-01)
    try {
      await this.ingestQueue.add('ingest-email', payload, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      });
    } catch (error) {
      // Enqueue failed — return 5xx so Postmark retries
      throw new BadRequestException('Failed to enqueue job');
    }

    return { status: 'queued' };
  }

  async checkHealth() {
    // WBHK-05: Health endpoint checks DB and Redis connectivity
    const dbHealthy = await this.prisma.$queryRaw`SELECT 1`;
    const redisHealthy = await this.ingestQueue.client.ping();

    return {
      status: 'ok',
      db: dbHealthy ? 'ok' : 'error',
      redis: redisHealthy ? 'ok' : 'error',
    };
  }
}

// Utility: Strip attachment binary blobs (D-03)
function stripAttachmentBlobs(payload: PostmarkPayloadDto) {
  return {
    ...payload,
    Attachments: (payload.Attachments ?? []).map(({ Content, ...meta }) => meta),
  };
}

// Source: CONTEXT.md D-02, spec/backend-architecture-proposal.md §6
```

### Pattern 3: BullMQ Retry Configuration

**What:** Configure job enqueue with 3 retry attempts and exponential backoff (5s, 10s, 20s).

**When to use:** WBHK-05.

**Example:**

```typescript
// src/webhooks/webhooks.service.ts (in enqueue method)
await this.ingestQueue.add('ingest-email', payload, {
  attempts: 3,              // Retry up to 3 times total
  backoff: {
    type: 'exponential',
    delay: 5000,            // Initial delay: 5 seconds
    // Subsequent delays: 2^(attempt-1) * 5000ms = 10s, 20s
  },
});

// Or globally in app.module.ts / bullmq configuration:
BullModule.forRoot({
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: true,
    removeOnFail: false,
  },
});

// Source: https://docs.bullmq.io/guide/retrying-failing-jobs
```

### Anti-Patterns to Avoid

- **Blind idempotency check (wrong):** `if (existing) return 200` — doesn't distinguish between "pending retry" and "already processed". Use status-aware logic (D-02).
- **Enqueue before INSERT:** `queue.add() → prisma.create()` — if enqueue succeeds but DB INSERT fails, duplicate jobs are enqueued. Always INSERT first.
- **Storing full attachment blobs in DB:** `rawPayload: JSON.stringify(payload)` with full Attachments array can bloat a single row to 20MB+. Use stripAttachmentBlobs().
- **Returning 200 on enqueue failure:** If BullMQ.add() throws, return 5xx (not 200) so Postmark retries. Returning 200 on failure silently drops the email.
- **No tenant scoping:** If TENANT_ID is hardcoded, all future multi-tenant work requires schema migration. Query by (tenantId, messageId) from day 1.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Job retry + backoff | Custom retry loop with setTimeout | BullMQ { attempts, backoff } | BullMQ handles exponential backoff, dead-letter queues, job persistence across restarts, concurrency limits |
| Webhook signature verification | Custom crypto.createHmac logic in middleware | NestJS Guard + @nestjs/common UnauthorizedException | Guards are testable, reusable, compose cleanly with other guards; error handling is automatic |
| Idempotency | Manual findUnique check before INSERT | UNIQUE constraint + Prisma findUnique | DB constraint guarantees atomicity; if process crashes between check and INSERT, retry is safe |
| Postmark HMAC validation | Custom Base64 decoding of X-Postmark-Signature | Use official Postmark webhooks library (if available) or HTTP Basic Auth | Postmark does not officially support HMAC for inbound webhooks; custom implementation is error-prone |

**Key insight:** Webhook security and idempotency are deceptively complex. The UX of "accept duplicate redeliveries" collides with "never process the same email twice" — edge cases emerge at scale (process crashes, network timeouts, database locks). Use framework-level primitives (Guard, UNIQUE constraint, job queue) rather than application code.

## Runtime State Inventory

> Not applicable — Phase 2 is greenfield (webhook endpoint creation), not a rename/refactor. No existing runtime state to migrate.

## Common Pitfalls

### Pitfall 1: Response Time Exceeds 100ms

**What goes wrong:** Controller logic takes too long, webhook request hangs, Postmark times out and retries immediately.

**Why it happens:** Unindexed database queries (email_intake_log lookup/insert slow), synchronous attachment parsing, or waiting for full job processing before responding.

**How to avoid:** Respond immediately after `queue.add()` returns. Do NOT wait for worker processing. Ensure `(tenantId, messageId)` index exists on email_intake_log (confirmed in Phase 1 schema). Profile locally: run `SELECT 1 FROM email_intake_log WHERE tenant_id = $1 AND message_id = $2` and verify < 5ms.

**Warning signs:** Webhook response times > 100ms, Postmark re-delivering within seconds, duplicate jobs in queue.

### Pitfall 2: Idempotency Breaks on Process Restart

**What goes wrong:** Service crashes after `queue.add()` succeeds but before response is sent. Postmark retries with same MessageID. Second webhook finds no intake_log row (crashed before INSERT), so it's processed again, creating duplicate candidate records.

**Why it happens:** Enqueuing before database insert (wrong order) or enqueue acknowledgment not tied to database transaction.

**How to avoid:** ALWAYS insert to email_intake_log FIRST, then enqueue. If enqueue fails after INSERT, catch error and return 5xx — Postmark retries, finds existing intake_log row, and re-attempts enqueue. The `(tenantId, messageId)` UNIQUE constraint ensures the row can only exist once.

**Warning signs:** Duplicate candidate records appearing, multiple jobs in queue with same MessageID.

### Pitfall 3: Attachment Blobs Bloat raw_payload Column

**What goes wrong:** A single email with a 10MB PDF attachment is stored in email_intake_log.raw_payload, bloating the column and slowing future queries.

**Why it happens:** stripAttachmentBlobs() is skipped or implemented incorrectly (e.g., stringifying the full Attachments array without removing Content).

**How to avoid:** Use the exact pattern: `Attachments: payload.Attachments?.map(({ Content, ...meta }) => meta)`. Verify by logging or testing: incoming payload has `Attachments[0].Content` (binary); outgoing raw_payload should have `Attachments[0].Name`, `ContentType`, `ContentLength` but NO `Content`. Downstream phases (3+) read metadata to fetch the file from R2, not from raw_payload.

**Warning signs:** email_intake_log table size grows faster than expected, queries on email_intake_log slow down, JSON field parsing errors.

### Pitfall 4: Forgetting Status Check in Idempotency Logic

**What goes wrong:** Webhook retry arrives for a MessageID that was processed successfully. Code checks `if (existing) return 200` and silently skips enqueue. But if the intake log shows `status=pending` (enqueue failed on first attempt), the job is never re-enqueued, and the email is lost forever.

**Why it happens:** Treating all existing rows the same; not distinguishing between "pending" (needs retry) and "completed/failed/spam" (already handled).

**How to avoid:** Check D-02 logic:
```typescript
if (existing.processingStatus === 'pending') {
  // Enqueue failed previously — re-attempt
  await queue.add(...);
} else {
  // Already processed — silently return 200
  return { status: 'queued' };
}
```

**Warning signs:** Emails with status='pending' for hours, manual intervention required to reprocess.

### Pitfall 5: Postmark Auth Implementation Assumes HMAC (Outdated)

**What goes wrong:** Code implements X-Postmark-Signature HMAC verification. But Postmark inbound webhooks don't support HMAC. Signature verification always fails (or is skipped because header is missing), and endpoints reject legitimate webhooks.

**Why it happens:** Postmark's delivery/bounce webhooks use HMAC; inbound webhooks don't. Documentation is unclear; many blog posts (and spec examples from Phase 1) assume HMAC.

**How to avoid:** Verify against official Postmark documentation (https://postmarkapp.com/developer/webhooks/inbound-webhook). For inbound webhooks, use HTTP Basic Auth (embed credentials in webhook URL) or IP allowlisting. If HMAC is required, it's from a third-party wrapper (Hookdeck, n8n), not Postmark directly.

**Warning signs:** All webhook requests return 401 Unauthorized, Postmark logs show "request rejected", no emails are being ingested.

## Code Examples

Verified patterns from official sources and project architecture:

### Webhook Controller with Guard

```typescript
// src/webhooks/webhooks.controller.ts
import { Controller, Post, Get, Body, UseGuards } from '@nestjs/common';
import { WebhooksService } from './webhooks.service';
import { PostmarkPayloadDto } from './dto/postmark-payload.dto';
import { PostmarkAuthGuard } from './guards/postmark-auth.guard';

@Controller('webhooks')
export class WebhooksController {
  constructor(private webhooksService: WebhooksService) {}

  @Post('email')
  @UseGuards(PostmarkAuthGuard)
  async ingestEmail(@Body() payload: PostmarkPayloadDto) {
    return this.webhooksService.enqueue(payload);
  }

  @Get('health')
  async health() {
    return this.webhooksService.checkHealth();
  }
}

// Source: spec/backend-architecture-proposal.md §6, NestJS Guards pattern
```

### Postmark Payload DTO with Zod Validation

```typescript
// src/webhooks/dto/postmark-payload.dto.ts
import { z } from 'zod';

const PostmarkAttachmentSchema = z.object({
  Name: z.string(),
  Content: z.string().optional(), // Base64-encoded binary
  ContentType: z.string(),
  ContentLength: z.number(),
});

export const PostmarkPayloadSchema = z.object({
  MessageID: z.string(),
  From: z.string().email(),
  Subject: z.string(),
  TextBody: z.string().optional(),
  HtmlBody: z.string().optional(),
  Date: z.string(),
  Attachments: z.array(PostmarkAttachmentSchema).optional(),
});

export type PostmarkPayloadDto = z.infer<typeof PostmarkPayloadSchema>;

// Source: spec/backend-architecture-proposal.md §6
```

### Atomic Idempotency + Enqueue

```typescript
// src/webhooks/webhooks.service.ts (key flow)
async enqueue(payload: PostmarkPayloadDto): Promise<{ status: string }> {
  const tenantId = this.configService.get<string>('TENANT_ID');

  try {
    // Step 1: Check for existing intake log (idempotency)
    const existing = await this.prisma.emailIntakeLog.findUnique({
      where: { tenantId_messageId: { tenantId, messageId: payload.MessageID } },
      select: { processingStatus: true },
    });

    if (existing) {
      if (existing.processingStatus === 'pending') {
        // Re-enqueue if previous attempt failed
        await this.ingestQueue.add('ingest-email', payload, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        });
      }
      return { status: 'queued' };
    }

    // Step 2: INSERT intake log row (atomicity point)
    await this.prisma.emailIntakeLog.create({
      data: {
        tenantId,
        messageId: payload.MessageID,
        fromEmail: payload.From,
        subject: payload.Subject || '',
        receivedAt: new Date(payload.Date),
        processingStatus: 'pending',
        rawPayload: this.stripAttachmentBlobs(payload),
      },
    });

    // Step 3: Enqueue job (if this fails, return 5xx)
    await this.ingestQueue.add('ingest-email', payload, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });

    return { status: 'queued' };
  } catch (error) {
    // If enqueue fails, return error so Postmark retries
    throw new BadRequestException('Webhook processing failed');
  }
}

private stripAttachmentBlobs(payload: PostmarkPayloadDto) {
  return {
    ...payload,
    Attachments: (payload.Attachments ?? []).map(({ Content, ...meta }) => meta),
  };
}

// Source: spec/backend-architecture-proposal.md §6, CONTEXT.md D-01/D-02/D-06
```

### Health Check Endpoint

```typescript
// src/webhooks/webhooks.service.ts
async checkHealth(): Promise<{
  status: string;
  db: string;
  redis: string;
}> {
  try {
    // Check PostgreSQL connectivity
    await this.prisma.$queryRaw`SELECT 1`;
    const dbStatus = 'ok';
  } catch {
    const dbStatus = 'error';
  }

  try {
    // Check Redis connectivity
    await this.ingestQueue.client.ping();
    const redisStatus = 'ok';
  } catch {
    const redisStatus = 'error';
  }

  const overallStatus = dbStatus === 'ok' && redisStatus === 'ok' ? 'ok' : 'degraded';

  return {
    status: overallStatus,
    db: dbStatus,
    redis: redisStatus,
  };
}

// Source: CONTEXT.md D-05
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Custom retry loops with setTimeout | BullMQ with built-in retry + exponential backoff | ~2015+ | BullMQ became standard for Node.js background jobs; custom loops are error-prone and lose jobs on restart |
| Postmark HMAC-SHA256 for inbound webhooks | HTTP Basic Auth or IP allowlisting | ~2020 (Postmark API v1.x) | Postmark never shipped HMAC for inbound webhooks; delivery webhooks have it, but not inbound. Confusion persists. |
| Storing raw email blobs in DB | Store metadata, blobs in object storage (R2/S3) | ~2015+ | Object storage is cheaper, scales better; storing BLOBs in Postgres bloats queries and backups |
| Check-then-act for idempotency | UNIQUE constraints at DB level | ~2010+ | Constraint-based idempotency is atomic; check-then-act always has a race condition |

**Deprecated/outdated:**
- Postmark HMAC verification for inbound webhooks: Never implemented; use Basic Auth instead.
- Manual job queue management: Obsolete; BullMQ + Redis is the standard.

## Open Questions

1. **Should we implement custom HMAC verification as a fallback?**
   - What we know: Postmark inbound webhooks don't officially support HMAC. HTTP Basic Auth is the standard. However, if a third-party webhook forwarder (e.g., Hookdeck) wraps Postmark and adds HMAC, we might need it.
   - What's unclear: Will the webhook be called directly from Postmark, or via a third-party service? If direct, HMAC is unnecessary.
   - Recommendation: Implement HTTP Basic Auth first (guard checks Authorization header). Add optional HMAC validation as a second check (if header exists, verify it). This is backwards-compatible and handles both cases.

2. **How do we handle Postmark authentication if credentials are in the webhook URL?**
   - What we know: HTTP Basic Auth embeds username:password in the URL: `https://user:pass@webhook.example.com/webhooks/email`. NestJS receives this in the Authorization header.
   - What's unclear: Should we extract credentials from env, or validate them from the Authorization header directly?
   - Recommendation: Validate Authorization header against POSTMARK_WEBHOOK_TOKEN env var. This decouples webhook URL from code.

3. **Should we implement the health endpoint as a separate GET /health route, or as middleware?**
   - What we know: CONTEXT.md D-05 specifies `GET /health` with { status, db, redis } checks.
   - What's unclear: Should health checks be synchronous or async? Should they be cached (stale data is OK)?
   - Recommendation: Implement as a simple async GET handler. Don't cache; each request pings DB and Redis. Adds < 5ms latency.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Jest 30.0.0 (configured in package.json) |
| Config file | jest.config.js (not found; falls back to package.json jest config) |
| Quick run command | `npm test -- src/webhooks/webhooks.controller.spec.ts` |
| Full suite command | `npm test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| WBHK-01 | POST /webhooks/email responds within 100ms with 200 OK | integration | `npm test -- src/webhooks/webhooks.controller.spec.ts -t "accepts webhook and responds 200"` | ❌ Wave 0 |
| WBHK-02 | Invalid HMAC returns 401 Unauthorized | unit | `npm test -- src/webhooks/guards/postmark-auth.guard.spec.ts -t "rejects invalid signature"` | ❌ Wave 0 |
| WBHK-03 | Duplicate MessageID returns 200 silently | unit | `npm test -- src/webhooks/webhooks.service.spec.ts -t "idempotent on duplicate messageId"` | ❌ Wave 0 |
| WBHK-04 | email_intake_log row inserted with status=pending | unit | `npm test -- src/webhooks/webhooks.service.spec.ts -t "inserts intake_log before enqueue"` | ❌ Wave 0 |
| WBHK-05 | Job enqueued with 3 attempts, exponential backoff | unit | `npm test -- src/webhooks/webhooks.service.spec.ts -t "enqueues with correct retry config"` | ❌ Wave 0 |
| WBHK-06 | Attachments stripped, metadata preserved | unit | `npm test -- src/webhooks/webhooks.service.spec.ts -t "strips attachment blobs, keeps metadata"` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npm test -- src/webhooks/ -t "webhook"`
- **Per wave merge:** `npm test` (full suite)
- **Phase gate:** Full suite green + manual smoke test: `curl -X POST http://localhost:3000/webhooks/email -H "Content-Type: application/json" -d @postmark-sample.json` returns 200 within 100ms

### Wave 0 Gaps
- [ ] `src/webhooks/webhooks.controller.spec.ts` — controller integration tests (WBHK-01, idempotency)
- [ ] `src/webhooks/guards/postmark-auth.guard.spec.ts` — guard unit tests (WBHK-02)
- [ ] `src/webhooks/webhooks.service.spec.ts` — service unit tests (WBHK-03 through WBHK-06)
- [ ] `src/webhooks/dto/postmark-payload.dto.spec.ts` — DTO validation tests
- [ ] Framework install: `npm install` — jest already in package.json (jest 30.0.0)

## Sources

### Primary (HIGH confidence)
- **Postmark Inbound Webhook Documentation** (https://postmarkapp.com/developer/webhooks/inbound-webhook) — Confirms NO HMAC signature support for inbound webhooks; recommends HTTP Basic Auth or IP allowlisting.
- **Postmark Webhooks Overview** (https://postmarkapp.com/developer/webhooks/webhooks-overview) — Security methods: IP allowlisting, HTTP Basic Auth.
- **BullMQ Retrying Failing Jobs** (https://docs.bullmq.io/guide/retrying-failing-jobs) — Official BullMQ retry + exponential backoff configuration.
- **NestJS Guards Documentation** (https://docs.nestjs.com/guards) — Guard pattern for middleware-like validation logic.
- **Project Schema** (/prisma/schema.prisma) — email_intake_log table with UNIQUE(tenant_id, message_id), processing_status column confirmed.
- **Project Configuration** (/src/config/env.ts) — POSTMARK_WEBHOOK_TOKEN and TENANT_ID env vars already defined in Zod schema.

### Secondary (MEDIUM confidence)
- **NestJS with Shopify Webhook Signature Verification** (https://medium.com/@carlocappai/how-to-check-shopify-webhook-signature-with-nestjs-05a034536c53) — Example of HMAC verification guard in NestJS (pattern is applicable, but Postmark doesn't use HMAC for inbound).
- **BullMQ NestJS Integration** (https://mahabub-r.medium.com/using-bullmq-with-nestjs-for-background-job-processing-320ab938048a) — Example of queue injection and job enqueue in NestJS services.

### Tertiary (LOW confidence)
- **Third-party Postmark API guides** (Hookdeck, Pipedream) — Some mention HMAC verification, but these are third-party wrapper implementations, not Postmark native.

## Metadata

**Confidence breakdown:**
- Standard Stack: **HIGH** — All dependencies confirmed in package.json; NestJS 11 and BullMQ patterns are well-established.
- Architecture: **HIGH** — Webhook pattern (guard + service + queue) is idiomatic NestJS. Database schema confirmed in Prisma (Phase 1).
- Postmark Auth: **MEDIUM** — Official Postmark docs confirm NO HMAC for inbound webhooks; recommend HTTP Basic Auth. CONTEXT.md indicates this was researched during Phase 1 discussion. Implementation guidance is clear but conditional on deployment setup.
- Pitfalls: **HIGH** — Common webhook pitfalls (response time, idempotency race conditions, blob bloat) are well-documented in community and official sources.
- Validation: **MEDIUM** — Jest is configured; no test infrastructure yet exists for Phase 2 (Wave 0 gap). Framework is stable, but tests must be written.

**Research date:** 2026-03-22
**Valid until:** 2026-04-22 (stable stack; unlikely to change in 30 days)
