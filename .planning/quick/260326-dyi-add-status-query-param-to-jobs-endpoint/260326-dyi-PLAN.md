---
phase: quick-260326-dyi
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/jobs/jobs.controller.ts
  - src/jobs/jobs.service.ts
  - src/jobs/jobs.controller.spec.ts
  - src/jobs/jobs.service.spec.ts
autonomous: true
requirements: []
must_haves:
  truths:
    - "GET /jobs returns all jobs when no query param supplied"
    - "GET /jobs?status=open returns only jobs with status='open'"
    - "GET /jobs?status=draft returns only jobs with status='draft'"
  artifacts:
    - path: "src/jobs/jobs.controller.ts"
      provides: "Query param extraction for optional status filter"
      contains: "@Query"
    - path: "src/jobs/jobs.service.ts"
      provides: "findAll() accepts optional status filter, passes it to Prisma where clause"
  key_links:
    - from: "src/jobs/jobs.controller.ts"
      to: "src/jobs/jobs.service.ts"
      via: "findAll(status?)"
      pattern: "findAll\\(.*status"
---

<objective>
Add an optional `status` query parameter to GET /jobs so callers can filter by job status (e.g. `?status=open`).

Purpose: Frontend needs to list only open roles without fetching and filtering on the client.
Output: Controller accepts `?status`, passes it to service, service adds a Prisma `where` condition when provided.
</objective>

<execution_context>
@/Users/danielshalem/triolla/telent-os-backend/.claude/get-shit-done/workflows/execute-plan.md
@/Users/danielshalem/triolla/telent-os-backend/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@/Users/danielshalem/triolla/telent-os-backend/src/jobs/jobs.controller.ts
@/Users/danielshalem/triolla/telent-os-backend/src/jobs/jobs.service.ts
@/Users/danielshalem/triolla/telent-os-backend/src/jobs/jobs.controller.spec.ts
@/Users/danielshalem/triolla/telent-os-backend/src/jobs/jobs.service.spec.ts

<interfaces>
<!-- Job model: status is a text field, default "draft", indexed on (tenantId, status) -->
<!-- findAll() currently: async findAll(): Promise<{ jobs: any[]; total: number }> -->
<!-- No Query decorator imported yet in jobs.controller.ts -->
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Add status query param to controller and service</name>
  <files>src/jobs/jobs.controller.ts, src/jobs/jobs.service.ts, src/jobs/jobs.controller.spec.ts, src/jobs/jobs.service.spec.ts</files>
  <behavior>
    - Service findAll(status?: string): when status provided, Prisma where includes { status }; when omitted, no status filter
    - Controller GET /jobs: extracts optional ?status via @Query('status'), passes to service
    - GET /jobs (no param) returns all jobs regardless of status
    - GET /jobs?status=open returns only jobs where status='open'
  </behavior>
  <action>
    1. In src/jobs/jobs.service.ts — update findAll() signature to `findAll(status?: string)`. Add `...(status ? { status } : {})` to the Prisma where clause alongside `tenantId`.

    2. In src/jobs/jobs.controller.ts — import `Query` from @nestjs/common. Update findAll handler to `async findAll(@Query('status') status?: string)` and call `this.jobsService.findAll(status)`.

    3. In src/jobs/jobs.service.spec.ts — add two test cases to the findAll describe block:
       - "passes status filter to Prisma when provided": mock findMany, call findAll('open'), assert where includes { status: 'open' }
       - "omits status filter when not provided": call findAll(), assert where does NOT include status key

    4. In src/jobs/jobs.controller.spec.ts — add two test cases:
       - "passes status param to service": mock jobsService.findAll, call GET /jobs?status=open, assert service called with 'open'
       - "calls service with undefined when no status param": call GET /jobs, assert service called with undefined

    Do NOT add Zod validation on status — it is a pass-through string filter, invalid values simply return 0 results (consistent with existing pattern).
  </action>
  <verify>
    <automated>cd /Users/danielshalem/triolla/telent-os-backend && npx jest --testPathPattern="jobs\.(controller|service)\.spec" --no-coverage 2>&1 | tail -20</automated>
  </verify>
  <done>All existing tests still pass, 4 new tests pass (2 in service spec, 2 in controller spec). GET /jobs?status=open filters correctly in manual smoke test.</done>
</task>

</tasks>

<verification>
Run full test suite to confirm no regressions:

```bash
cd /Users/danielshalem/triolla/telent-os-backend && npx jest --no-coverage 2>&1 | tail -10
```

Expected: all previously passing tests (195) still pass, +4 new tests.
</verification>

<success_criteria>
- GET /jobs returns all jobs (unchanged behaviour)
- GET /jobs?status=open returns only open jobs
- GET /jobs?status=draft returns only draft jobs
- 4 new tests added and passing
- Zero regressions in existing suite
</success_criteria>

<output>
After completion, create `.planning/quick/260326-dyi-add-status-query-param-to-jobs-endpoint/260326-dyi-SUMMARY.md`
</output>
