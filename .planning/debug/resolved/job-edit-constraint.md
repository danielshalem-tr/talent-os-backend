---
status: resolved
trigger: "job-edit-constraint-violation: When editing a job from the UI, 500 error due to PostgreSQL constraint violation on jobs_status_check"
created: 2026-03-25T00:00:00Z
updated: 2026-03-25T10:31:00Z
---

## Current Focus

hypothesis: CONFIRMED - Database constraint is wrong, not application code. Constraint allows 'active' and 'paused' but API spec documents only 'draft', 'open', 'closed'
test: Checked API_PROTOCOL_MVP.md Job Status section, found spec defines only 3 values: draft, open, closed
expecting: Database constraint should match API spec (draft, open, closed), not the extra values (active, paused)
next_action: Create migration to fix constraint definition from ['active', 'draft', 'closed', 'paused'] to ['draft', 'open', 'closed']

## Symptoms

expected: Job edit should update successfully in the database
actual: 500 error, PostgreSQL constraint violation on jobs_status_check
errors: |
  postgres-1  | 2026-03-25 10:25:05.741 UTC [10291] ERROR:  new row for relation "jobs" violates check constraint "jobs_status_check"
  postgres-1  | 2026-03-25 10:25:05.741 UTC [10291] DETAIL:  Failing row contains (6a169065-ffb9-47f9-95b9-a9b9f0c83f54, 00000000-0000-0000-0000-000000000001, Senior Backend Engineer, Engineering, null, full_time, open, Sum Senior Backend Engineer desc, {}, null, N/A, 2026-03-24 08:24:02.51+00, 2026-03-25 10:25:05.739+00, 3, 0, {nodejs,nestjs,php}, {nice,to,have}, {Agency,Startup}, null, null, null).

  api-1       | [Nest] 326  - 03/25/2026, 12:25:05 PM   ERROR [ExceptionsHandler] DriverAdapterError: new row for relation "jobs" violates check constraint "jobs_status_check"
reproduction: Edit a job via the UI
timeline: Just occurred (2026-03-25)

## Eliminated

(none yet)

## Evidence

- timestamp: 2026-03-25T12:00:00Z
  checked: migration.sql (20260322110817_init)
  found: Line 194 defines constraint 'jobs_status_check' CHECK (status IN ('active', 'draft', 'closed', 'paused'))
  implication: Constraint allows only: active, draft, closed, paused — BUT error message shows status="open" in failing row

- timestamp: 2026-03-25T12:01:00Z
  checked: error detail from logs
  found: Failing row contains status="open" which is NOT in the allowed constraint values
  implication: Application code is trying to set status to "open" which violates the constraint

- timestamp: 2026-03-25T12:02:00Z
  checked: src/jobs/dto/create-job.dto.ts line 31
  found: CreateJobSchema defines status enum as ['draft', 'open', 'closed'] - allows 'open'
  implication: Schema validation accepts 'open' but database constraint only accepts ['active', 'draft', 'closed', 'paused']

- timestamp: 2026-03-25T12:03:00Z
  checked: jobs.controller.ts PUT endpoint
  found: Update endpoint (line 42-69) uses CreateJobSchema.safeParse() - same schema as create endpoint
  implication: Update endpoint has same validation gap - both create and update allow invalid 'open' status

- timestamp: 2026-03-25T12:04:00Z
  checked: test files for references to 'open' status
  found: Multiple test cases use status='open' in mock data and payloads (jobs.integration.spec.ts lines 27, 217, 311, 393, 405, 478)
  implication: Tests confirm 'open' is intentional and should be valid (not a typo)

- timestamp: 2026-03-25T12:05:00Z
  checked: spec/API_PROTOCOL_MVP.md Job Status section (lines 17-20)
  found: API specification explicitly documents Job Status as only 3 values: 'draft', 'open', 'closed' (NOT 'active' or 'paused')
  implication: Database constraint was created incorrectly with 4 values ['active', 'draft', 'closed', 'paused']. The API code and tests are correct. The constraint definition needs to be fixed.

## Resolution

root_cause: PostgreSQL constraint jobs_status_check was incorrectly defined with 4 values ['active', 'draft', 'closed', 'paused'] in initial migration. However, API_PROTOCOL_MVP.md spec defines Job Status as only 3 values: ['draft', 'open', 'closed']. The application code correctly implements the API spec, using 'open' for active jobs. When the UI sends status='open' to update endpoint, Prisma passes it through validation but database rejects with constraint violation.

fix: Created migration 20260325090000_fix_job_status_constraint to: (1) Convert existing 'active' status rows to 'open', (2) Drop incorrect constraint, (3) Create corrected constraint matching API spec: CHECK (status IN ('draft', 'open', 'closed'))

verification: All 39 jobs integration tests pass, including tests that use status='open'. Database constraint now allows the correct status values per API spec. Job edit and create endpoints can now accept status='open' without constraint violation.

files_changed: [prisma/migrations/20260325090000_fix_job_status_constraint/migration.sql]
