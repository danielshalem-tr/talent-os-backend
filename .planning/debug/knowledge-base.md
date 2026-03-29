# GSD Debug Knowledge Base

Resolved debug sessions. Used by `gsd-debugger` to surface known-pattern hypotheses at the start of new investigations.

---

## job-edit-constraint — PostgreSQL constraint definition mismatch with API specification
- **Date:** 2026-03-25
- **Error patterns:** constraint violation, jobs_status_check, check constraint violated, status field
- **Root cause:** PostgreSQL constraint was defined with 4 values ['active', 'draft', 'closed', 'paused'] but API_PROTOCOL_MVP.md specifies only 3 values ['draft', 'open', 'closed']. Application code correctly implements the API spec. When UI sends status='open', Prisma validation passes but database rejects with constraint violation.
- **Fix:** Migration 20260325090000_fix_job_status_constraint converts 'active' rows to 'open' and corrects the constraint to match API spec.
- **Files changed:** prisma/migrations/20260325090000_fix_job_status_constraint/migration.sql
---

## candidate-persistence-silent-failure — Phase 6 transaction errors swallowed by catch block preventing BullMQ retries
- **Date:** 2026-03-29
- **Error patterns:** extracted candidate data, no persistence, job reprocessed 3x, silent failure, no error logged, phase 6 transaction, catch block
- **Root cause:** Phase 6 transaction catch block at ingestion.processor.ts line 198-209 was catching database errors (constraint violations, connection losses, etc.) but returning early without re-throwing. This prevented BullMQ from detecting the failure and retrying. The job appeared successful to BullMQ even though candidate INSERT failed, so no automatic retry occurred through normal error propagation (though stalled job logic might have caused retries).
- **Fix:** Changed line 208 from `return;` to `throw err;` to re-throw transaction errors. Updated comment to clarify that transaction errors may be transient and BullMQ should retry.
- **Files changed:** src/ingestion/ingestion.processor.ts (line 208, re-throw transaction error; comment update)
---

