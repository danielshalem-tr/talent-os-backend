---
phase: 13-implement-kanban-board-with-candidate-hiring-stage-tracking
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - prisma/schema.prisma
  - prisma/migrations/20260326_add_hiring_stage_to_candidate/migration.sql
  - src/candidates/candidates.service.ts
  - src/candidates/candidates.controller.ts
  - src/candidates/dto/candidate-response.dto.ts
autonomous: true
requirements: [KANBAN-01, KANBAN-02, KANBAN-03, KANBAN-04, KANBAN-05]
user_setup: []

must_haves:
  truths:
    - "Candidate with job_id automatically assigned to first hiring stage on creation"
    - "GET /api/candidates includes job_id and hiring_stage_id in response"
    - "Candidates can be visually organized by hiring stage in Kanban board columns"
    - "Existing candidates with job_id backfilled with first stage (by position order)"
    - "No stageless candidates exist after migration (data integrity)"
  artifacts:
    - path: "prisma/schema.prisma"
      provides: "Candidate model with hiring_stage_id FK and relation to JobStage"
      min_lines: 5
    - path: "prisma/migrations/20260326_add_hiring_stage_to_candidate/migration.sql"
      provides: "Three-step migration: add column, backfill data, add constraint"
      exports: ["ALTER TABLE", "UPDATE"]
    - path: "src/candidates/candidates.service.ts"
      provides: "CandidatesService.createCandidate() with auto-stage assignment; findAll() includes stage data"
      exports: ["createCandidate", "findAll"]
    - path: "src/candidates/dto/candidate-response.dto.ts"
      provides: "CandidateResponse interface with job_id, hiring_stage_id, hiring_stage_name"
      exports: ["CandidateResponse"]
  key_links:
    - from: "src/candidates/candidates.service.ts"
      to: "prisma/schema.prisma (Candidate.hiringStageId)"
      via: "CandidatesService.createCandidate() queries JobStage for first stage"
      pattern: "jobStage.findFirst.*orderBy.*order.*asc"
    - from: "src/candidates/candidates.service.ts"
      to: "prisma/schema.prisma (CandidateResponse)"
      via: "findAll() maps candidate.hiringStage to response.hiring_stage_name"
      pattern: "hiringStage.*select.*name"
    - from: "src/candidates/candidates.controller.ts"
      to: "src/candidates/candidates.service.ts"
      via: "GET /api/candidates calls findAll(), response includes stage fields"
      pattern: "return.*findAll"
---

<objective>
Track candidates' current hiring stage directly on the Candidate entity, auto-assign the first stage when a candidate is created, and expose stage information in API responses for Kanban board UI rendering.

Purpose: Enable recruiter UI to organize and move candidates across hiring stages (columns) within a Kanban board, using direct tracking on the Candidate model as an MVP simplification (bypassing the complex Application entity).

Output:
- Prisma schema updated with `hiring_stage_id` FK on Candidate
- Prisma migration with 3-step backfill strategy
- CandidatesService.createCandidate() auto-assigns first stage
- GET /api/candidates response includes job_id, hiring_stage_id, hiring_stage_name
- All existing tests passing; no breaking changes to API contract
</objective>

<execution_context>
@/Users/danielshalem/triolla/telent-os-backend/.claude/get-shit-done/workflows/execute-plan.md
@/Users/danielshalem/triolla/telent-os-backend/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/phases/13-implement-kanban-board-with-candidate-hiring-stage-tracking/13-CONTEXT.md
@.planning/phases/13-implement-kanban-board-with-candidate-hiring-stage-tracking/13-RESEARCH.md
@prisma/schema.prisma
@src/candidates/candidates.service.ts
@src/candidates/candidates.controller.ts

<interfaces>
From prisma/schema.prisma (Candidate model):
```prisma
model Candidate {
  id              String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  tenantId        String   @map("tenant_id") @db.Uuid
  jobId           String?  @map("job_id") @db.Uuid
  fullName        String   @map("full_name") @db.Text
  email           String?  @db.Text
  phone           String?  @db.Text
  currentRole     String?  @map("current_role") @db.Text
  location        String?  @db.Text
  yearsExperience Int?     @map("years_experience") @db.SmallInt
  skills          String[] @default([])
  cvText          String?  @map("cv_text") @db.Text
  cvFileUrl       String?  @map("cv_file_url") @db.Text
  source          String   @db.Text
  createdAt       DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt       DateTime @updatedAt @map("updated_at") @db.Timestamptz
  // ... other fields ...
}
```

From prisma/schema.prisma (JobStage model):
```prisma
model JobStage {
  id        String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  tenantId  String   @map("tenant_id") @db.Uuid
  jobId     String   @map("job_id") @db.Uuid
  name      String   @db.Text
  order     Int      @db.SmallInt       // 1-based ordering (Application Review=1, Screening=2, etc.)
  isEnabled Boolean  @default(true)     @map("is_enabled")
  color     String   @default("bg-zinc-400")
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt DateTime @updatedAt @map("updated_at") @db.Timestamptz
  // relations ...
}
```

From src/candidates/candidates.service.ts (CandidateResponse interface):
```typescript
export interface CandidateResponse {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  current_role: string | null;
  location: string | null;
  cv_file_url: string | null;
  source: string;
  created_at: Date;
  ai_score: number | null;
  is_duplicate: boolean;
  skills: string[];
}
```

From src/candidates/candidates.service.ts (createCandidate signature):
```typescript
async createCandidate(
  tenantId: string,
  dto: CreateCandidateDto,
  file?: Express.Multer.File
): Promise<CandidateResponse & { application_id?: string; tenant_id?: string; hiring_stage_id?: string }>
```
</interfaces>

</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Update Prisma schema — add hiring_stage_id FK to Candidate</name>
  <files>prisma/schema.prisma</files>
  <behavior>
    - Candidate model includes `hiringStageId` field (nullable initially, UUID type)
    - Candidate model includes `hiringStage` relation pointing to JobStage (optional)
    - JobStage model includes `candidates` inverse relation
    - New index on (tenantId, jobId, hiringStageId) created for Kanban board queries
    - No breaking changes to existing Candidate fields or relations
  </behavior>
  <action>
Open prisma/schema.prisma. Find the Candidate model (lines 65-99).

1. After line 68 (jobId field), add new fields:
```prisma
  hiringStageId  String?  @map("hiring_stage_id") @db.Uuid
```

2. After line 88 (existing job relation), add:
```prisma
  hiringStage    JobStage? @relation("CandidateHiringStage", fields: [hiringStageId], references: [id], onDelete: SetNull)
```

3. Replace the existing index at line 95 with:
```prisma
  @@index([tenantId, jobId], name: "idx_candidates_tenant_job")
  @@index([tenantId, jobId, hiringStageId], name: "idx_candidates_tenant_job_stage")
```

4. Find the JobStage model (around line 195). After existing relations, add:
```prisma
  candidates     Candidate[]  @relation("CandidateHiringStage")
```

5. Save file. Verify schema.prisma is syntactically valid:
```bash
npx prisma validate
```

Verify: No errors from prisma validate command.
  </action>
  <verify>
    <automated>npx prisma validate && grep -n "hiringStageId.*@map.*hiring_stage_id" prisma/schema.prisma</automated>
  </verify>
  <done>Candidate model has hiring_stage_id FK field and relation to JobStage; JobStage has inverse relation; new index created; schema validates</done>
</task>

<task type="auto">
  <name>Task 2: Create Prisma migration with 3-step backfill</name>
  <files>prisma/migrations/20260326_add_hiring_stage_to_candidate/migration.sql</files>
  <action>
Run prisma migration create command to generate migration file:
```bash
npx prisma migrate create --name add_hiring_stage_to_candidate
```

This creates `.../prisma/migrations/{timestamp}_add_hiring_stage_to_candidate/migration.sql`.

Open the generated file and replace contents with the following 3-step strategy (per RESEARCH.md lines 152-219):

**Step 1: Add nullable column + FK constraint**
```sql
-- Add hiring_stage_id column (nullable for data migration)
ALTER TABLE "candidates" ADD COLUMN "hiring_stage_id" UUID;

-- Add FK constraint to job_stages
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_hiring_stage_id_fkey"
  FOREIGN KEY ("hiring_stage_id") REFERENCES "job_stages"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Create index for Kanban board queries
CREATE INDEX "idx_candidates_tenant_job_stage"
  ON "candidates"("tenant_id", "job_id", "hiring_stage_id");
```

**Step 2: Backfill existing data (non-blocking)**
```sql
-- Assign first stage (lowest order) to candidates with job_id
UPDATE "candidates" c
SET "hiring_stage_id" = (
  SELECT id FROM "job_stages" js
  WHERE js."job_id" = c."job_id"
  ORDER BY js."order" ASC
  LIMIT 1
)
WHERE c."job_id" IS NOT NULL
  AND c."hiring_stage_id" IS NULL;
```

**Step 3: Add CHECK constraint (data integrity)**
```sql
-- Enforce: if job_id is NOT NULL, then hiring_stage_id must also be NOT NULL
ALTER TABLE "candidates"
ADD CONSTRAINT "check_hiring_stage_when_job_assigned"
CHECK (("job_id" IS NULL) OR ("hiring_stage_id" IS NOT NULL));
```

Save the migration file. Verify it contains all 3 SQL blocks.
  </action>
  <verify>
    <automated>ls -la prisma/migrations/ | grep add_hiring_stage && wc -l prisma/migrations/20260326*/migration.sql | grep " [0-9]"</automated>
  </verify>
  <done>Migration file exists with 3 SQL steps (add column/FK/index, backfill data, add CHECK constraint)</done>
</task>

<task type="auto">
  <name>Task 3: Run migration and verify backfill</name>
  <files>prisma/migrations/20260326_add_hiring_stage_to_candidate/migration.sql</files>
  <action>
Run prisma db push to apply migration:
```bash
npx prisma db push
```

After migration completes successfully, verify backfill results:

1. Check that column exists and index is created:
```bash
psql $DATABASE_URL -c "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'candidates' AND column_name = 'hiring_stage_id';"
```

2. Verify index created:
```bash
psql $DATABASE_URL -c "SELECT indexname FROM pg_indexes WHERE tablename = 'candidates' AND indexname = 'idx_candidates_tenant_job_stage';"
```

3. Count candidates assigned stages:
```bash
psql $DATABASE_URL -c "SELECT COUNT(*) FROM candidates WHERE job_id IS NOT NULL AND hiring_stage_id IS NOT NULL;"
```

4. Verify CHECK constraint exists:
```bash
psql $DATABASE_URL -c "SELECT constraint_name FROM information_schema.table_constraints WHERE table_name = 'candidates' AND constraint_name = 'check_hiring_stage_when_job_assigned';"
```

Expected: All queries return results (column exists, index created, candidates assigned, constraint exists).

Prisma Client types updated automatically via `@prisma/client` generation.
  </action>
  <verify>
    <automated>npx prisma db push 2>&1 | grep -i "success\|applied" && echo "Migration successful"</automated>
  </verify>
  <done>Migration applied successfully; hiring_stage_id column exists; backfill completed; CHECK constraint enforced; Prisma Client updated</done>
</task>

<task type="auto" tdd="true">
  <name>Task 4: Create candidate-response.dto.ts with new fields</name>
  <files>src/candidates/dto/candidate-response.dto.ts</files>
  <behavior>
    - CandidateResponse interface exported from new file
    - Includes all existing fields (id, full_name, email, phone, current_role, location, cv_file_url, source, created_at, ai_score, is_duplicate, skills)
    - Adds 3 new fields: job_id (string | null), hiring_stage_id (string | null), hiring_stage_name (string | null)
    - Interface used by findAll() and in controller response documentation
  </behavior>
  <action>
Create new file `src/candidates/dto/candidate-response.dto.ts`:

```typescript
/**
 * DTO for GET /api/candidates response
 * Includes hiring stage information for Kanban board rendering
 */
export interface CandidateResponse {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  current_role: string | null;
  location: string | null;
  cv_file_url: string | null;
  source: string;
  created_at: Date;
  ai_score: number | null;
  is_duplicate: boolean;
  skills: string[];

  // NEW: Kanban board stage tracking
  job_id: string | null;
  hiring_stage_id: string | null;
  hiring_stage_name: string | null;
}
```

Then update `src/candidates/candidates.service.ts`:

1. At top, import the new DTO:
```typescript
import { CandidateResponse } from './dto/candidate-response.dto';
```

2. Remove the existing `export interface CandidateResponse` definition (lines 16-29) — now imported from DTO file instead.

Save both files.
  </action>
  <verify>
    <automated>grep -n "export interface CandidateResponse" src/candidates/dto/candidate-response.dto.ts && grep -n "import.*CandidateResponse.*from.*candidate-response.dto" src/candidates/candidates.service.ts</automated>
  </verify>
  <done>candidate-response.dto.ts created with all fields including job_id, hiring_stage_id, hiring_stage_name; imported in candidates.service.ts; old interface definition removed from service file</done>
</task>

<task type="auto" tdd="true">
  <name>Task 5: Update CandidatesService.findAll() to include hiring stage data</name>
  <files>src/candidates/candidates.service.ts</files>
  <behavior>
    - findAll() SELECT clause includes jobId, hiringStageId, hiringStage.name
    - Response mapping includes job_id, hiring_stage_id, hiring_stage_name (all can be null)
    - No change to existing filtering or ordering logic
    - Performance: 1 additional LEFT JOIN to job_stages table (covered by existing index)
  </behavior>
  <action>
Open `src/candidates/candidates.service.ts` and locate `async findAll()` method (starting around line 39).

In the `select` clause (lines 74-95), add new fields after `skills`:
```typescript
      skills: true,
      jobId: true,                      // NEW
      hiringStageId: true,              // NEW
      hiringStage: {                    // NEW (for hiring_stage_name)
        select: { name: true },
      },
```

Then in the response mapping loop (after line 99), update the map function to include new fields:

Find the section that builds the response object (around lines 100-120). Locate where it returns the mapped candidate and add:
```typescript
const result: CandidateResponse[] = candidates.map((c) => {
  const maxScore = c.applications.length > 0
    ? Math.max(...c.applications.flatMap(app => app.scores.map(s => s.score)))
    : null;

  return {
    id: c.id,
    full_name: c.fullName,
    email: c.email,
    phone: c.phone,
    current_role: c.currentRole,
    location: c.location,
    cv_file_url: c.cvFileUrl,
    source: c.source,
    created_at: c.createdAt,
    ai_score: maxScore,
    is_duplicate: c.duplicateFlags.length > 0,
    skills: c.skills,

    // NEW: Kanban board fields
    job_id: c.jobId,
    hiring_stage_id: c.hiringStageId,
    hiring_stage_name: c.hiringStage?.name ?? null,
  };
});

return { candidates: result, total: result.length };
```

Save file. Run TypeScript compiler to check for type errors:
```bash
npx tsc --noEmit
```

Expected: No TypeScript errors.
  </action>
  <verify>
    <automated>npx tsc --noEmit 2>&1 | grep -v "node_modules" && echo "TypeScript check passed"</automated>
  </verify>
  <done>findAll() SELECT includes jobId, hiringStageId, hiringStage.name; response mapping adds job_id, hiring_stage_id, hiring_stage_name to returned objects; no TypeScript errors</done>
</task>

<task type="auto" tdd="true">
  <name>Task 6: Update CandidatesService.createCandidate() with auto-stage assignment</name>
  <files>src/candidates/candidates.service.ts</files>
  <behavior>
    - createCandidate() pre-fetches first JobStage for job_id BEFORE transaction (if job_id provided)
    - Candidate created with hiringStageId set to first stage id
    - If no job_id provided, hiringStageId set to null
    - If job_id provided but no first stage exists, hiringStageId set to null + warning logged
    - Response includes hiring_stage_id field
    - All existing logic (storage, validation, application creation) preserved
  </behavior>
  <action>
Open `src/candidates/candidates.service.ts` and locate the `async createCandidate()` method (around line 131).

**Step 1: Add logger import** (if not present)
At top of file, add:
```typescript
import { Logger } from '@nestjs/common';
```

And in constructor, add:
```typescript
private readonly logger = new Logger(CandidatesService.name);
```

**Step 2: Pre-fetch first stage BEFORE transaction**
After line 131 (start of createCandidate function), add this code right before the transaction starts (around line 180):

```typescript
  // Pre-fetch first hiring stage if job_id is provided
  let firstStageId: string | null = null;
  if (dto.job_id) {
    const firstStage = await this.prisma.jobStage.findFirst({
      where: {
        jobId: dto.job_id,
        tenantId,
      },
      orderBy: { order: 'asc' },
      select: { id: true },
    });

    if (firstStage) {
      firstStageId = firstStage.id;
    } else {
      this.logger.warn(
        `Candidate created with job_id ${dto.job_id} but no hiring stages found. ` +
        `Candidate will have hiringStageId=null.`,
      );
    }
  }
```

**Step 3: Update candidate.create() call inside transaction**
Find the `await tx.candidate.create()` call (around line 190). In the data object, add after `jobId`:

```typescript
      const candidate = await tx.candidate.create({
        data: {
          id: candidateId,
          tenantId,
          jobId: dto.job_id,
          hiringStageId: firstStageId,  // AUTO-ASSIGN FIRST STAGE
          fullName: dto.full_name,
          // ... rest of existing fields ...
```

**Step 4: Update response to include hiring_stage_id**
Find the return statement of createCandidate() (around line 240). Update to include new field:

```typescript
      return {
        id: candidate.id,
        tenant_id: tenantId,
        job_id: candidate.jobId,
        hiring_stage_id: candidate.hiringStageId,  // NEW
        full_name: candidate.fullName,
        // ... rest of existing fields ...
        application_id: application.id,
      };
```

Save file. Run TypeScript compiler:
```bash
npx tsc --noEmit
```

Expected: No TypeScript errors.
  </action>
  <verify>
    <automated>npx tsc --noEmit 2>&1 | grep -v "node_modules" && echo "TypeScript check passed" && grep -n "hiringStageId: firstStageId" src/candidates/candidates.service.ts</automated>
  </verify>
  <done>createCandidate() pre-fetches first JobStage before transaction; includes hiringStageId in candidate.create() data; logs warning if no stage exists; response includes hiring_stage_id; TypeScript validates</done>
</task>

<task type="auto">
  <name>Task 7: Update candidates.controller.ts response documentation</name>
  <files>src/candidates/candidates.controller.ts</files>
  <action>
Open `src/candidates/candidates.controller.ts`.

1. Ensure the controller imports CandidateResponse from the DTO:
```typescript
import { CandidateResponse } from './dto/candidate-response.dto';
```

2. Find the GET /candidates endpoint method (typically `@Get()` decorator). Update the return type documentation/JSDoc if present to indicate new fields. For example:

```typescript
/**
 * Retrieve all candidates for the tenant
 * @param q Optional search query (name, email, role)
 * @param filter Optional filter: all, high-score, available, referred, duplicates
 * @returns Candidates with hiring stage info for Kanban board rendering
 */
@Get()
async findAll(
  @Query('q') q?: string,
  @Query('filter') filter?: CandidateFilter,
): Promise<{ candidates: CandidateResponse[]; total: number }> {
  return this.candidatesService.findAll(q, filter);
}
```

3. Find the POST /candidates endpoint. Update response documentation to include hiring_stage_id:

```typescript
/**
 * Create a new candidate with file upload
 * Auto-assigns candidate to the first hiring stage of the specified job
 * @returns Newly created candidate with assigned hiring stage
 */
@Post()
async create(
  @Body() dto: CreateCandidateDto,
  @UploadedFile() file?: Express.Multer.File,
): Promise<CandidateResponse & { application_id?: string; tenant_id?: string; hiring_stage_id?: string }> {
  return this.candidatesService.createCandidate(this.tenantId, dto, file);
}
```

Save file. Verify no syntax errors:
```bash
npx tsc --noEmit
```

Expected: No TypeScript errors.
  </action>
  <verify>
    <automated>npx tsc --noEmit 2>&1 | grep -v "node_modules" && echo "TypeScript check passed"</automated>
  </verify>
  <done>Controller imports CandidateResponse from DTO; GET and POST endpoints documented with new hiring stage fields; TypeScript validates</done>
</task>

<task type="auto">
  <name>Task 8: Run existing tests to verify no regressions</name>
  <files>src/candidates/candidates.service.ts, src/candidates/candidates.controller.ts</files>
  <action>
Run the candidates service and controller tests to ensure no breaking changes:

```bash
npm test -- candidates.service.spec
npm test -- candidates.controller.spec
```

Expected output:
- All existing tests pass (no new failures due to schema/service changes)
- If any test fails, it should be due to expected changes (e.g., response includes new fields)

If tests fail due to missing test data or responses:

1. Check candidates.service.spec.ts — if tests mock the Prisma response, update mocks to include hiring_stage_id: null or a mock UUID
2. Check candidates.controller.spec.ts — if tests check response structure, update expected responses to include the 3 new fields

Example test update for service:
```typescript
const mockCandidate = {
  id: 'cand-uuid-1',
  fullName: 'Jane Doe',
  // ... existing fields ...
  jobId: 'job-uuid-1',
  hiringStageId: 'stage-uuid-1',  // NEW
  hiringStage: { name: 'Application Review' },  // NEW
  // ... other fields ...
};
```

Run tests again. All tests should pass.

**Note:** If tests don't exist for the candidates service/controller, skip this task and note that Wave 1 assumes existing test suite. Tests can be written in a follow-up phase if needed.
  </action>
  <verify>
    <automated>npm test -- candidates.service.spec 2>&1 | grep -E "passed|failed" && npm test -- candidates.controller.spec 2>&1 | grep -E "passed|failed"</automated>
  </verify>
  <done>Existing candidates service and controller tests pass with no regressions; response includes new hiring stage fields</done>
</task>

<task type="auto">
  <name>Task 9: Verify API response with curl test (Kanban board structure)</name>
  <files>src/candidates/candidates.service.ts, src/candidates/candidates.controller.ts</files>
  <action>
Start the application:
```bash
npm run start:dev
```

Wait for "NestJS application successfully started" message.

In a new terminal, test the GET /api/candidates endpoint:
```bash
curl -s http://localhost:3000/api/candidates | jq '.candidates[0]' 2>/dev/null || curl http://localhost:3000/api/candidates
```

Expected response structure (sample):
```json
{
  "candidates": [
    {
      "id": "cand-uuid-1",
      "full_name": "Jane Doe",
      "email": "jane@example.com",
      "phone": "+1234567890",
      "current_role": "Senior Engineer",
      "location": "Tel Aviv",
      "cv_file_url": "https://...",
      "source": "email",
      "created_at": "2026-03-26T10:00:00Z",
      "ai_score": 85,
      "is_duplicate": false,
      "skills": ["TypeScript", "React"],
      "job_id": "job-uuid-1",
      "hiring_stage_id": "stage-uuid-1",
      "hiring_stage_name": "Application Review"
    }
  ],
  "total": 1
}
```

Verify:
- ✓ job_id is present and correct
- ✓ hiring_stage_id is present and is a valid UUID (or null for candidates without jobs)
- ✓ hiring_stage_name is present and matches the stage name (or null)
- ✓ All existing fields still present (full_name, email, etc.)

If response contains `status: 400` or `status: 500`, check logs for error messages.

Stop dev server when done:
```bash
Ctrl+C
```
  </action>
  <verify>
    <automated>curl -s http://localhost:3000/api/candidates 2>/dev/null | jq '.candidates[0].hiring_stage_id' 2>/dev/null || echo "API response verified manually"</automated>
  </verify>
  <done>GET /api/candidates returns response with job_id, hiring_stage_id, hiring_stage_name fields; Kanban board can use these to render candidate columns</done>
</task>

<task type="auto">
  <name>Task 10: Verify POST /api/candidates auto-assigns hiring stage</name>
  <files>src/candidates/candidates.service.ts</files>
  <action>
Ensure the dev server is running:
```bash
npm run start:dev
```

Create a test candidate via POST /api/candidates with a file (if multi-part form upload is supported) or just JSON:

```bash
curl -X POST http://localhost:3000/api/candidates \
  -H "Content-Type: application/json" \
  -d '{
    "full_name": "Test Candidate",
    "email": "test@example.com",
    "phone": "+1234567890",
    "current_role": "Engineer",
    "location": "Tel Aviv",
    "years_experience": 5,
    "skills": ["TypeScript"],
    "job_id": "<existing-job-uuid>",
    "source": "manual",
    "ai_summary": null,
    "source_agency": null
  }'
```

(Replace `<existing-job-uuid>` with a valid job ID from GET /api/jobs response)

Expected response:
```json
{
  "id": "new-cand-uuid",
  "tenant_id": "...",
  "job_id": "job-uuid",
  "hiring_stage_id": "stage-uuid",
  "full_name": "Test Candidate",
  "email": "test@example.com",
  // ... other fields ...
  "application_id": "...",
  "created_at": "2026-03-26T..."
}
```

Verify:
- ✓ hiring_stage_id is NOT null (should be assigned to first stage)
- ✓ hiring_stage_id matches one of the job's stages (from GET /api/jobs/:id response)
- ✓ Response includes all expected fields

If hiring_stage_id is null when it should have a value:
1. Check logs for warning: "Candidate created with job_id X but no hiring stages found"
2. Verify the job has at least one JobStage (GET /api/jobs/:id to check hiring_flow)
3. If job has no stages, this is expected behavior (and documented in RESEARCH.md)

Stop dev server.
  </action>
  <verify>
    <automated>curl -s -X POST http://localhost:3000/api/candidates -H "Content-Type: application/json" -d '{}' 2>/dev/null | jq '.hiring_stage_id' 2>/dev/null || echo "POST verification requires valid job UUID"</automated>
  </verify>
  <done>POST /api/candidates auto-assigns hiring_stage_id to first stage of provided job; response includes hiring_stage_id field</done>
</task>

<task type="auto">
  <name>Task 11: Commit all changes atomically</name>
  <files>prisma/schema.prisma, prisma/migrations/20260326_add_hiring_stage_to_candidate/migration.sql, src/candidates/candidates.service.ts, src/candidates/candidates.controller.ts, src/candidates/dto/candidate-response.dto.ts</files>
  <action>
Stage all modified and new files:
```bash
git add prisma/schema.prisma src/candidates/candidates.service.ts src/candidates/candidates.controller.ts src/candidates/dto/candidate-response.dto.ts prisma/migrations/
```

Verify staged files:
```bash
git status
```

Expected: All files above listed as "staged for commit"

Commit with phase-specific message:
```bash
git commit -m "feat(13): add hiring stage tracking to candidate model

- Add hiring_stage_id FK to Candidate model in schema
- Create 3-step migration: add column, backfill data, add CHECK constraint
- Auto-assign first JobStage to candidates on creation (per job_id)
- Update GET /api/candidates response to include job_id, hiring_stage_id, hiring_stage_name
- Update POST /api/candidates response to include hiring_stage_id
- Move CandidateResponse interface to dedicated DTO file
- All existing tests pass; no breaking changes to API contract
- Enables Kanban board to organize candidates by hiring stage

KANBAN-01: Candidate model with hiring_stage_id FK
KANBAN-02: Auto-assign first stage on creation
KANBAN-03: GET /api/candidates includes stage identifiers
KANBAN-04: Backfill existing candidates with first stage
KANBAN-05: Data integrity — no stageless candidates after migration

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

Verify commit created:
```bash
git log --oneline -1
```

Expected: Commit message appears with phase indicator "feat(13):".
  </action>
  <verify>
    <automated>git log --oneline -1 | grep "feat(13): add hiring stage tracking"</automated>
  </verify>
  <done>All Phase 13 Wave 1 changes committed atomically with clear commit message referencing requirements (KANBAN-01 through KANBAN-05)</done>
</task>

</tasks>

<verification>
Verify Phase 13 Wave 1 completion by checking:

1. **Schema Changes**
   - [ ] `prisma/schema.prisma` contains `hiringStageId` field on Candidate
   - [ ] `prisma/schema.prisma` contains `hiringStage` relation on Candidate pointing to JobStage
   - [ ] `prisma/schema.prisma` contains `candidates` inverse relation on JobStage
   - [ ] Index on (tenantId, jobId, hiringStageId) created

2. **Migration**
   - [ ] Migration file exists: `prisma/migrations/20260326_add_hiring_stage_to_candidate/migration.sql`
   - [ ] Migration applied successfully (verified by `npx prisma db push`)
   - [ ] Existing candidates with job_id have hiring_stage_id assigned (checked via SELECT COUNT)
   - [ ] CHECK constraint enforced in PostgreSQL

3. **Service Logic**
   - [ ] `CandidatesService.createCandidate()` pre-fetches first JobStage before transaction
   - [ ] Candidate created with `hiringStageId` set to first stage (by `order` ASC)
   - [ ] `CandidatesService.findAll()` includes `jobId`, `hiringStageId`, `hiringStage.name` in SELECT
   - [ ] Response mapping includes `job_id`, `hiring_stage_id`, `hiring_stage_name` fields
   - [ ] Logger warns if job_id provided but no first stage exists

4. **API Response**
   - [ ] GET /api/candidates returns candidates with job_id, hiring_stage_id, hiring_stage_name
   - [ ] POST /api/candidates response includes hiring_stage_id
   - [ ] Response structure validates against CandidateResponse interface
   - [ ] Null values handled correctly for candidates without jobs

5. **Tests**
   - [ ] Existing candidates.service.spec tests pass
   - [ ] Existing candidates.controller.spec tests pass
   - [ ] No TypeScript errors in compiled code
   - [ ] No breaking changes to API contract (additive fields only)

6. **Git**
   - [ ] All changes committed atomically
   - [ ] Commit message references Phase 13 and requirement IDs (KANBAN-01 through KANBAN-05)
   - [ ] No uncommitted changes in working directory
</verification>

<success_criteria>
Phase 13 Wave 1 complete when ALL of the following are true:

1. Prisma schema updated with hiring_stage_id FK field on Candidate, relation to JobStage, and new index
2. Prisma migration created and applied (3-step: add column, backfill, add constraint)
3. CandidatesService.createCandidate() automatically assigns first JobStage to new candidates
4. CandidatesService.findAll() includes job_id, hiring_stage_id, hiring_stage_name in response
5. GET /api/candidates response structure includes 3 new fields (all optional/nullable)
6. POST /api/candidates response includes hiring_stage_id
7. All existing tests pass without regressions
8. No TypeScript compilation errors
9. All changes committed with atomic, phase-specific commit message
10. API response tested manually — Kanban board can organize candidates by stage

**Outcome:** Kanban board MVP enabled — candidates tracked by hiring stage, API provides all required data for column-based UI rendering.
</success_criteria>

<output>
After completion, create `.planning/phases/13-implement-kanban-board-with-candidate-hiring-stage-tracking/13-01-SUMMARY.md`

Format (required sections):
- **Date Completed:** 2026-03-26
- **Commits:** List commit SHAs and messages
- **Artifacts Created:** List files modified/created with line counts
- **Tests Passing:** Total count, test suites
- **Known Issues:** None (or list any deviations)
- **Next Wave:** Plan for Wave 2 (if needed) or next phase
</output>
