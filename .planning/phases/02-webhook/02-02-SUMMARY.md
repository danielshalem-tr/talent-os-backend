---
phase: 02-webhook
plan: 02
subsystem: api
tags: [nestjs, bullmq, prisma, postmark, webhook, auth, idempotency]

# Dependency graph
requires:
  - phase: 02-01
    provides: "Spec files (guard/service/controller), PostmarkPayloadDto, Prisma schema with emailIntakeLog"
provides:
  - "PostmarkAuthGuard: HTTP Basic Auth guard with timing-safe comparison"
  - "WebhooksService: idempotency check, intake log insert before enqueue, BullMQ enqueue, health check, blob stripping"
  - "WebhooksController: POST /webhooks/email (guarded) and GET /health routes"
  - "WebhooksModule: self-contained NestJS module ready for AppModule import"
affects:
  - 02-03
  - 03-ingestion-worker

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "NestJS guard with @Optional() ConfigService for test DI compatibility"
    - "INSERT before queue.add idempotency pattern (status=pending sentinel for retry detection)"
    - "BullMQ job options: attempts=3, exponential backoff delay=5000ms"
    - "Attachment blob stripping via destructuring: { Content: _content, ...meta }"
    - "Prisma 7 named compound unique: idx_intake_message_id (not tenantId_messageId)"

key-files:
  created:
    - src/webhooks/guards/postmark-auth.guard.ts
    - src/webhooks/webhooks.service.ts
    - src/webhooks/webhooks.controller.ts
    - src/webhooks/webhooks.module.ts
  modified: []

key-decisions:
  - "Used @Optional() on ConfigService in PostmarkAuthGuard so NestJS can resolve guard during test module compilation without ConfigService in providers"
  - "Constructor order in WebhooksService is (prisma, ingestQueue, configService) — matches spec instantiation pattern"
  - "Prisma 7 named @@unique uses explicit name 'idx_intake_message_id' as compound key, not auto-generated tenantId_messageId"
  - "POST /webhooks/email returns HTTP 200 (not 201) via @HttpCode(HttpStatus.OK)"

patterns-established:
  - "Pattern 1: Spec-first constructor ordering — when spec instantiates class directly, constructor order must match spec call site"
  - "Pattern 2: Prisma named compound unique fields — always use the explicit name from @@unique(..., name: ...) not auto-generated camelCase"

requirements-completed: [WBHK-01, WBHK-02, WBHK-03, WBHK-04, WBHK-05, WBHK-06]

# Metrics
duration: 4min
completed: 2026-03-22
---

# Phase 2 Plan 02: Webhook Implementation Summary

**PostmarkAuthGuard (timing-safe Basic Auth), WebhooksService (idempotent enqueue with BullMQ), WebhooksController (POST /webhooks/email + GET /health), and WebhooksModule wired — all 19 spec tests green**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-22T13:59:32Z
- **Completed:** 2026-03-22T14:03:00Z
- **Tasks:** 3
- **Files modified:** 4

## Accomplishments

- PostmarkAuthGuard validates HTTP Basic Auth using `crypto.timingSafeEqual` to prevent timing attacks; rejects missing/wrong credentials with UnauthorizedException
- WebhooksService implements full idempotency lifecycle: INSERT intake_log before queue.add (sentinel), re-enqueue on status=pending, skip on status=completed/failed/spam, 5xx on enqueue fail so Postmark retries
- WebhooksController and WebhooksModule complete the NestJS wiring; module is self-contained and ready for AppModule import in plan 02-03

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement PostmarkAuthGuard** - `e88e126` (feat)
2. **Task 1 fix: @Optional() for test DI** - `5581c87` (fix)
3. **Task 2: Implement WebhooksService** - `7add998` (feat)
4. **Task 3: WebhooksController and WebhooksModule** - `4613356` (feat)
5. **Task 2 fix: Prisma compound unique name** - `4491d33` (fix)

## Files Created/Modified

- `src/webhooks/guards/postmark-auth.guard.ts` - HTTP Basic Auth guard with timing-safe comparison, @Optional() ConfigService
- `src/webhooks/webhooks.service.ts` - Idempotency, intake log, BullMQ enqueue with retry config, health check, blob stripping
- `src/webhooks/webhooks.controller.ts` - POST /webhooks/email (guarded, Zod parse) and GET /health
- `src/webhooks/webhooks.module.ts` - BullModule.registerQueue, WebhooksController, WebhooksService, PostmarkAuthGuard

## Decisions Made

- Used `@Optional()` on `ConfigService` in `PostmarkAuthGuard` so that NestJS testing module can compile the controller (which references the guard via `@UseGuards`) without providing `ConfigService`. Guard still enforces auth at runtime.
- Constructor order `(prisma, ingestQueue, configService)` in `WebhooksService` matches the spec's direct instantiation: `new WebhooksService(mockPrisma, mockQueue, mockConfigService)`.
- Prisma 7 named compound unique: the `@@unique([tenantId, messageId], name: "idx_intake_message_id")` generates `idx_intake_message_id` as the key, not the default `tenantId_messageId`. Fixed after initial TypeScript error.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Added @Optional() to PostmarkAuthGuard ConfigService**
- **Found during:** Task 3 (WebhooksController spec run)
- **Issue:** Controller spec creates testing module with only `WebhooksService` mock; NestJS resolves `@UseGuards(PostmarkAuthGuard)` guard during module compilation and throws "Nest can't resolve ConfigService"
- **Fix:** Added `@Optional()` decorator to `ConfigService` parameter in guard constructor
- **Files modified:** `src/webhooks/guards/postmark-auth.guard.ts`
- **Verification:** All 19 tests pass including guard spec (3 tests)
- **Committed in:** `5581c87`

**2. [Rule 1 - Bug] Fixed Prisma 7 compound unique key name**
- **Found during:** Post-task TypeScript verification (`npx tsc --noEmit`)
- **Issue:** Service used `tenantId_messageId` (Prisma default auto-generated name) but schema has `@@unique([...], name: "idx_intake_message_id")` — Prisma 7 uses explicit name as the key
- **Fix:** Changed `where: { tenantId_messageId: ... }` to `where: { idx_intake_message_id: ... }`
- **Files modified:** `src/webhooks/webhooks.service.ts`
- **Verification:** `npx tsc --noEmit` passes with zero errors; all 19 tests still pass
- **Committed in:** `4491d33`

---

**Total deviations:** 2 auto-fixed (both Rule 1 bugs)
**Impact on plan:** Both fixes required for correctness/compilability. No scope creep.

## Issues Encountered

None beyond the two auto-fixed bugs documented above.

## Next Phase Readiness

- `WebhooksModule` is self-contained and ready to be imported by `AppModule` in plan 02-03
- All 6 WBHK requirements implemented and verified via spec tests
- TypeScript compiles clean; `npx tsc --noEmit` passes
- Established pattern: Prisma named @@unique must use explicit name in `where` clauses

---
*Phase: 02-webhook*
*Completed: 2026-03-22*
