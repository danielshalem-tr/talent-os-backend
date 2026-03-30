---
phase: quick-260330-idw
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/jobs/jobs.service.ts
  - src/jobs/jobs.controller.ts
  - src/jobs/jobs.service.spec.ts
  - src/jobs/jobs.controller.spec.ts
autonomous: true
requirements: [GET-JOBS-ID]

must_haves:
  truths:
    - "GET /jobs/:id returns a single job with hiring_flow and screening_questions"
    - "Returns 404 with standard error shape when job not found or belongs to different tenant"
    - "Response shape is identical to a single item in GET /jobs list response"
  artifacts:
    - path: "src/jobs/jobs.service.ts"
      provides: "findOne(id) method"
      contains: "findOne"
    - path: "src/jobs/jobs.controller.ts"
      provides: "GET ':id' route placed before ':id/hard'"
      contains: "@Get(':id')"
  key_links:
    - from: "src/jobs/jobs.controller.ts"
      to: "src/jobs/jobs.service.ts"
      via: "this.jobsService.findOne(id)"
      pattern: "findOne"
---

<objective>
Add GET /jobs/:id endpoint that returns a single job by ID, including hiring_flow (JobStage array) and screening_questions, matching the exact response shape of a single item from GET /jobs.

Purpose: The frontend kanban board and job detail views need to fetch a specific job without loading all jobs.
Output: findOne() in JobsService, @Get(':id') route in JobsController placed before ':id/hard', unit tests for both.
</objective>

<execution_context>
@/Users/danielshalem/triolla/telent-os-backend/.claude/get-shit-done/workflows/execute-plan.md
@/Users/danielshalem/triolla/telent-os-backend/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@/Users/danielshalem/triolla/telent-os-backend/.planning/STATE.md
@/Users/danielshalem/triolla/telent-os-backend/src/jobs/jobs.service.ts
@/Users/danielshalem/triolla/telent-os-backend/src/jobs/jobs.controller.ts

<interfaces>
<!-- Key patterns from existing code — use these directly -->

JobsService._formatJobResponse(job: any) — already exists, returns:
{
  id, title, department, location, job_type, status, hiring_manager,
  candidate_count, created_at, updated_at, description, responsibilities,
  what_we_offer, salary_range, must_have_skills, nice_to_have_skills,
  min_experience, max_experience, selected_org_types,
  screening_questions: [{ id, text, type, expected_answer }],
  hiring_flow: [{ id, name, is_enabled, interviewer, color, is_custom, order }]
}

Prisma include pattern used by findAll():
{
  hiringStages: { orderBy: { order: 'asc' } },
  screeningQuestions: { orderBy: { order: 'asc' } },
  _count: { select: { candidates: true } },
}

Standard 404 error shape (match existing pattern):
throw new NotFoundException({
  error: { code: 'NOT_FOUND', message: 'Job not found' }
})

Controller route ordering: GET ':id' MUST be declared BEFORE @Delete(':id/hard') to
ensure NestJS resolves the literal segment 'hard' before the param ':id'.
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Add findOne() to JobsService and @Get(':id') to JobsController</name>
  <files>
    src/jobs/jobs.service.ts,
    src/jobs/jobs.controller.ts,
    src/jobs/jobs.service.spec.ts,
    src/jobs/jobs.controller.spec.ts
  </files>
  <behavior>
    - findOne('existing-id') → returns formatted job object (same shape as _formatJobResponse)
    - findOne('nonexistent-id') → throws NotFoundException with { error: { code: 'NOT_FOUND', message: 'Job not found' } }
    - findOne('other-tenant-id') → throws NotFoundException (tenant isolation via tenantId filter)
    - Controller GET ':id' → calls jobsService.findOne(id) and returns result
    - Controller GET ':id' with missing job → propagates NotFoundException (returns 404)
  </behavior>
  <action>
**jobs.service.ts** — add findOne() method after findAll():

```typescript
async findOne(id: string): Promise<any> {
  const tenantId = this.configService.get<string>('TENANT_ID')!;

  const job = await this.prisma.job.findFirst({
    where: { id, tenantId },
    include: {
      hiringStages: { orderBy: { order: 'asc' } },
      screeningQuestions: { orderBy: { order: 'asc' } },
      _count: { select: { candidates: true } },
    },
  });

  if (!job) {
    throw new NotFoundException({
      error: { code: 'NOT_FOUND', message: 'Job not found' },
    });
  }

  return this._formatJobResponse(job);
}
```

**jobs.controller.ts** — add @Get(':id') route BEFORE @Delete(':id/hard'). Insert after the existing @Get('list') route and before @Post():

```typescript
@Get(':id')
async findOne(@Param('id') id: string) {
  return this.jobsService.findOne(id);
}
```

IMPORTANT: The @Get(':id') decorator must appear in the source file BEFORE @Delete(':id/hard'). NestJS registers routes in declaration order — placing ':id' after ':id/hard' would shadow the hard-delete route.

**jobs.service.spec.ts** — add describe block for findOne() alongside existing tests. Use the existing mockPrismaService.job.findFirst mock pattern. Add tests:
1. Returns formatted job when found (mock findFirst to return a job with hiringStages, screeningQuestions, _count)
2. Throws NotFoundException when findFirst returns null

**jobs.controller.spec.ts** — add findOne mock to mockJobsService, add describe block for 'GET /jobs/:id':
1. Calls jobsService.findOne(id) and returns result
2. When service throws NotFoundException, controller propagates it
  </action>
  <verify>
    <automated>cd /Users/danielshalem/triolla/telent-os-backend && npx jest --testPathPattern="jobs.service.spec|jobs.controller.spec" --no-coverage 2>&1 | tail -20</automated>
  </verify>
  <done>
    - findOne() exists in JobsService, uses findFirst with tenantId + id, throws NotFoundException when null
    - @Get(':id') route declared before @Delete(':id/hard') in JobsController source
    - All jobs.service.spec.ts and jobs.controller.spec.ts tests pass (no regressions + new tests green)
  </done>
</task>

</tasks>

<verification>
Run full jobs test suite to confirm no regressions:

```bash
cd /Users/danielshalem/triolla/telent-os-backend && npx jest --testPathPattern="src/jobs" --no-coverage
```

Smoke test with seeded data (if Docker running):

```bash
curl -s http://localhost:3000/jobs | jq '.jobs[0].id' | xargs -I{} curl -s http://localhost:3000/jobs/{} | jq '{id, title, hiring_flow_count: (.hiring_flow | length), sq_count: (.screening_questions | length)}'
```
</verification>

<success_criteria>
- GET /jobs/:id returns 200 with full job object matching GET /jobs list item shape (id, title, hiring_flow array, screening_questions array, all other fields)
- GET /jobs/:id returns 404 with { error: { code: 'NOT_FOUND', message: 'Job not found' } } for unknown or cross-tenant IDs
- @Get(':id') is declared before @Delete(':id/hard') in jobs.controller.ts
- All existing tests continue to pass (no regressions)
- New unit tests cover happy path and 404 for both service and controller layers
</success_criteria>

<output>
After completion, create `/Users/danielshalem/triolla/telent-os-backend/.planning/quick/260330-idw-add-get-jobs-id-endpoint-to-fetch-single/260330-idw-SUMMARY.md` and update `/Users/danielshalem/triolla/telent-os-backend/.planning/STATE.md` quick tasks table.
</output>
