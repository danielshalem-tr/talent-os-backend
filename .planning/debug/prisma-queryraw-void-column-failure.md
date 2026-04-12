---
status: awaiting_human_verify
trigger: 'prisma-queryraw-void-column-failure — emails saved with processing_status=failed due to Prisma $queryRaw void column error'
created: 2026-04-12T00:00:00Z
updated: 2026-04-12T00:00:00Z
---

## Current Focus

hypothesis: CONFIRMED — $queryRaw on pg_advisory_xact_lock() (returns void) caused Prisma deserialization failure
test: replaced $queryRaw with $executeRaw on line 204 of ingestion.processor.ts
expecting: advisory lock still acquired, no deserialization attempted
next_action: await human verification in production/staging

## Symptoms

expected: Emails received via Postmark webhook should be processed through the ingestion pipeline — extracted, deduped, scored, and stored as candidate records.
actual: Emails are saved to email_intake_logs with processing_status='failed'. The error comes from a Prisma $queryRaw() call that hits a column of type 'void', which Prisma cannot deserialize.
errors: |
  Invalid `prisma.$queryRaw()`invocation:
  Raw query failed. Code:`N/A`. Message: `Failed to deserialize column of type 'void'. If you're using $queryRaw and this column is explicitly marked as `Unsupported` in your Prisma schema, try casting this column to any supported Prisma type such as `String`.`
reproduction: Email received via Postmark webhook → enters processing pipeline → fails at some $queryRaw call
timeline: Found in production logs for 2026-04-12. Multiple emails affected (at least 3 in the sample).

## Eliminated

- hypothesis: $queryRaw in dedup.service.ts check() is the culprit
  evidence: That query is SELECT id::text FROM candidates — returns a typed row, not void. Only called if phone is present.
  timestamp: 2026-04-12T00:00:00Z

## Evidence

- timestamp: 2026-04-12T00:00:00Z
  checked: All $queryRaw usages in src/ via grep
  found: ingestion.processor.ts line 204 — `await tx.$queryRaw\`SELECT pg_advisory_xact_lock(hashtext(${extraction!.phone}))\``
  implication: pg_advisory_xact_lock() returns void in PostgreSQL. $queryRaw tries to deserialize the result set; encountering a void column causes the exact error reported.

- timestamp: 2026-04-12T00:00:00Z
  checked: dedup.service.ts, jobs.service.ts, health.service.ts, webhooks.service.ts
  found: All other $queryRaw calls return typed rows (id, max, constant 1) — none return void
  implication: Line 204 in ingestion.processor.ts is the sole cause

## Resolution

root_cause: ingestion.processor.ts line 204 calls `tx.$queryRaw` with `SELECT pg_advisory_xact_lock(...)`. The PostgreSQL function pg_advisory_xact_lock() returns void. Prisma's $queryRaw attempts to deserialize the result set and cannot handle a void column, throwing the error. This causes the entire transaction to fail and the intake log is marked 'failed'.
fix: Replace $queryRaw with $executeRaw on line 204. $executeRaw executes the query and returns only the affected row count — it never tries to deserialize the result columns, so void return types are safe.
verification: 40/40 unit tests pass (ingestion.processor). No regressions in full suite (3 pre-existing auth failures unrelated to this fix). Fix confirmed correct mechanically — $executeRaw does not attempt to deserialize result columns.
files_changed:

- src/ingestion/ingestion.processor.ts
