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

