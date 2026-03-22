# Phase 2: Webhook Intake & Idempotency - Context

**Gathered:** 2026-03-22
**Status:** Ready for planning

<domain>
## Phase Boundary

Accept Postmark inbound webhook POSTs at `POST /webhooks/email`, verify authenticity, check for duplicate deliveries via MessageID, insert an idempotency row in `email_intake_log`, and enqueue to BullMQ. Respond within 100ms. No email parsing, no AI calls, no file storage — those are Phases 3–5.

</domain>

<decisions>
## Implementation Decisions

### Failure atomicity

- **D-01:** If BullMQ enqueue fails after the `email_intake_log` row is already inserted, return 5xx — do NOT silently return 200. Postmark will retry on non-2xx responses.
- **D-02:** On retry, the idempotency check must distinguish between `status=pending` (enqueue previously failed — re-attempt enqueue) and `status=completed/failed/spam` (already processed — silently return 200). A simple `if (existing) return` is wrong; check status before skipping.

### Payload sanitization

- **D-03:** Strip only `Attachments[n].Content` from the raw payload before storing in `email_intake_log.raw_payload`. Keep all other attachment metadata (`Name`, `ContentType`, `ContentLength`, etc.) — downstream phases need it to identify file type and name. Do not strip the full `Attachments` array.

### Tenant resolution

- **D-04:** Single-tenant for Phase 1. `tenantId` always comes from `ConfigService.get('TENANT_ID')` — the env var set to `00000000-0000-0000-0000-000000000001`. No URL-level tenant routing, no per-tenant HMAC tokens yet.

### Health endpoint

- **D-05:** Add `GET /health` in this phase — it's the natural moment since Phase 2 adds the first real routes. Returns HTTP 200 with `{ status: 'ok', db: 'ok', redis: 'ok' }`. Checks Prisma connectivity (`$queryRaw SELECT 1`) and Redis ping. Returns 503 if either dependency is unhealthy.

### Queue job payload

- **D-06:** Enqueue the full sanitized Postmark payload (attachment blobs already stripped) as the BullMQ job data. The worker reads directly from the job — no second DB fetch needed to start processing. Queue name: `ingest-email`. Job name: `ingest-email`. 3 attempts, exponential backoff starting at 5s.

### Claude's Discretion

- HMAC verification implementation — the spec flags that Postmark inbound webhooks may use a different auth mechanism than delivery webhooks; researcher must confirm the exact header and algorithm before implementation
- NestJS module structure (`WebhooksModule`, guard vs service for signature verification)
- DTO shape for `PostmarkPayloadDto`
- Error class for 401 vs NestJS built-in `UnauthorizedException`

</decisions>

<specifics>
## Specific Ideas

- The spec (`spec/backend-architecture-proposal.md` §6) shows `stripAttachmentBlobs()` destructuring `{ Content, ...meta }` — use this exact pattern
- Spec shows the idempotency check using `findUnique` on `messageId`; update to also check `processing_status` per D-02
- The spec explicitly flags HMAC auth for inbound webhooks as uncertain: "Verify the exact auth method for inbound webhooks in Postmark's documentation before implementing verifySignature" — researcher must resolve this

</specifics>

<canonical_refs>

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Webhook intake

- `spec/backend-architecture-proposal.md` §6 — Full webhook intake flow: controller pattern, `verifySignature`, `enqueue`, `stripAttachmentBlobs`, idempotency guard, BullMQ job config
- `spec/backend-architecture-proposal.md` §5 — Directory structure: `src/webhooks/` layout (module, controller, service, DTO)
- `spec/backend-architecture-proposal.md` §10 — `POSTMARK_WEBHOOK_TOKEN` env var (HMAC key)

### Requirements

- `.planning/REQUIREMENTS.md` §Webhook Intake — WBHK-01 through WBHK-06 (endpoint, HMAC, idempotency, intake log insert, BullMQ enqueue, payload strip)

### Schema

- `spec/backend-architecture-proposal.md` §9 — `email_intake_log` table: columns, status values (`pending`, `processing`, `completed`, `failed`, `spam`), UNIQUE `(tenant_id, message_id)`

</canonical_refs>

<code_context>

## Existing Code Insights

### Reusable Assets

- `src/main.ts` — `rawBody: true` already set; ready for HMAC verification using `@RawBody()` decorator
- `src/app.module.ts` — Add `WebhooksModule` import here; ConfigModule and PrismaModule already present globally
- `src/prisma/prisma.service.ts` — Available for idempotency check and intake log insert
- `src/config/env.ts` — `POSTMARK_WEBHOOK_TOKEN` must be added to the Zod env schema here

### Established Patterns

- ConfigModule is global — `ConfigService` injectable anywhere without re-importing
- PrismaModule is global — `PrismaService` injectable anywhere
- Worker entry point (`src/worker.ts`) exists and starts a separate NestJS application context — `WorkerModule` needs `IngestionModule` added in Phase 2

### Integration Points

- `src/webhooks/webhooks.service.ts` → creates `email_intake_log` row and enqueues to BullMQ `ingest-email`
- `src/ingestion/ingestion.processor.ts` → `@Processor('ingest-email')` reads from same queue (stub in Phase 2, real logic in Phase 3+)
- `POSTMARK_WEBHOOK_TOKEN` → new env var; add to `src/config/env.ts` Zod schema and `.env.example`

</code_context>

<deferred>
## Deferred Ideas

- Per-tenant HMAC tokens / URL-based tenant routing — v2 multi-tenant phase
- BullMQ dashboard (OPS-02) — post-Phase 7 operations setup
- Sentry error tracking (OPS-01) — post-Phase 7 operations setup

</deferred>

---

_Phase: 02-webhook_
_Context gathered: 2026-03-22_
