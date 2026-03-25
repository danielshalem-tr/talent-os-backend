---
phase: 11-review-and-validate-api-protocol-mvp-spec-and-implementation-guide
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - prisma/schema.prisma
  - src/prisma/prisma.module.ts
  - src/jobs/dto/create-job.dto.ts
  - src/jobs/jobs.service.ts
  - src/jobs/jobs.controller.ts
  - src/jobs/jobs.module.ts
  - src/config/config.module.ts
  - src/config/config.service.ts
  - src/config/config.controller.ts
  - src/app.module.ts
  - src/jobs/jobs.integration.spec.ts
autonomous: false
requirements:
  - API_PROTOCOL_MVP_SCHEMA_UPDATES
  - API_PROTOCOL_MVP_ENDPOINTS
  - API_PROTOCOL_MVP_VALIDATION
  - API_PROTOCOL_MVP_TESTING

must_haves:
  truths:
    - GET /config returns hardcoded static response with all lookup tables
    - GET /jobs returns complete job data with nested hiring_flow and screening_questions, ordered by creation time
    - POST /jobs creates job with atomic nested stages/questions, seeding 4 default stages if none provided
    - PUT /jobs/:id updates any job field independently with atomic nested updates
    - DELETE /jobs/:id soft-deletes job (sets status=closed) without hard deletes
    - All endpoints validate tenant isolation via x-tenant-id header
    - Response field names match API_PROTOCOL_MVP.md exactly (snake_case)
    - Error responses use standard format with code, message, details
    - At least one hiring stage must be enabled on POST and PUT
    - Color field is client-computed only (not in database for GET /jobs response)

  artifacts:
    - path: prisma/schema.prisma
      provides: Updated JobStage (interviewer, is_enabled) and ScreeningQuestion (expected_answer) models
      min_lines: 200
    - path: src/jobs/jobs.service.ts
      provides: Updated findAll, createJob, updateJob, deleteJob methods with full response contracts
      min_lines: 200
    - path: src/jobs/jobs.controller.ts
      provides: GET, POST, PUT, DELETE endpoint handlers with validation
      min_lines: 80
    - path: src/config/config.service.ts
      provides: Hardcoded GET /config response
      min_lines: 50
    - path: src/jobs/jobs.integration.spec.ts
      provides: Integration tests for all 5 endpoints, tenant isolation, validation scenarios
      min_lines: 300

  key_links:
    - from: src/jobs/jobs.controller.ts
      to: src/jobs/jobs.service.ts
      via: dependency injection
      pattern: "constructor.*JobsService"
    - from: src/jobs/jobs.service.ts
      to: prisma/schema.prisma
      via: Prisma operations on Job, JobStage, ScreeningQuestion
      pattern: "prisma\\.job\\.(create|update|delete|findMany)"
    - from: src/config/config.controller.ts
      to: src/config/config.service.ts
      via: dependency injection
      pattern: "constructor.*ConfigService"
    - from: src/app.module.ts
      to: src/jobs/jobs.module.ts + src/config/config.module.ts
      via: module imports
      pattern: "imports.*JobsModule.*ConfigModule"

---

<objective>
Implement the API protocol MVP specification: complete job management endpoints with updated database schema, validation, error handling, and integration tests.

**Purpose:** Frontend receives all required data fields for complete job UI without additional API calls. Backend has clear, testable contracts matching API_PROTOCOL_MVP.md.

**Output:**
- Updated Prisma schema with JobStage (interviewer, is_enabled) and ScreeningQuestion (expected_answer)
- GET /config hardcoded endpoint
- GET /jobs, POST /jobs, PUT /jobs/:id, DELETE /jobs/:id with full response contracts
- Validation and error handling per spec
- Tenant isolation on all endpoints
- Integration tests covering happy path, validation, tenancy, and soft delete
</objective>

<execution_context>
@/Users/danielshalem/triolla/telent-os-backend/.claude/get-shit-done/workflows/execute-plan.md
@/Users/danielshalem/triolla/telent-os-backend/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/ROADMAP.md
@.planning/phases/11-review-and-validate-api-protocol-mvp-spec-and-implementation-guide/11-CONTEXT.md
@spec/API_PROTOCOL_MVP.md
@spec/API_PROTOCOL_MVP_CHANGES.md
@spec/BACKEND_IMPLEMENTATION_QUICK_START.md
@.planning/phases/10-add-job-creation-feature/10-CONTEXT.md
@.planning/phases/09-create-client-facing-rest-api-endpoints/09-CONTEXT.md

## Key Type Contracts

From existing Prisma schema (`prisma/schema.prisma`):

**Current JobStage model:**
```prisma
model JobStage {
  id         String  @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  tenantId   String  @map("tenant_id") @db.Uuid
  jobId      String  @map("job_id") @db.Uuid
  name       String  @db.Text
  order      Int     @db.SmallInt
  isCustom   Boolean @default(false) @map("is_custom")
  createdAt  DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt  DateTime @updatedAt @map("updated_at") @db.Timestamptz
  // Missing: interviewer (STRING), is_enabled (BOOLEAN)
}

model ScreeningQuestion {
  id         String  @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  tenantId   String  @map("tenant_id") @db.Uuid
  jobId      String  @map("job_id") @db.Uuid
  text       String  @db.Text
  answerType String  @map("answer_type") @db.Text
  required   Boolean @default(false)
  knockout   Boolean @default(false)
  order      Int     @db.SmallInt
  createdAt  DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt  DateTime @updatedAt @map("updated_at") @db.Timestamptz
  // Missing: expected_answer (VARCHAR, nullable)
}
```

**Response shape from API_PROTOCOL_MVP.md (GET /jobs):**
```typescript
interface JobResponse {
  id: string;
  title: string;
  department: string | null;
  location: string | null;
  job_type: string;
  status: string;
  hiring_manager: string | null;
  candidate_count: number;
  created_at: string; // ISO8601
  updated_at: string; // ISO8601
  description: string | null;
  responsibilities: string | null;
  what_we_offer: string | null;
  salary_range: string | null;
  must_have_skills: string[];
  nice_to_have_skills: string[];
  min_experience: number | null;
  max_experience: number | null;
  selected_org_types: string[];
  screening_questions: ScreeningQuestionResponse[];
  hiring_flow: JobStageResponse[];
}

interface ScreeningQuestionResponse {
  id: string;
  text: string;
  type: string; // Renamed from answerType
  expected_answer: string | null;
}

interface JobStageResponse {
  id: string;
  name: string;
  is_enabled: boolean;
  interviewer: string | null;
  color: string; // Computed, not stored
  is_custom: boolean;
  order: number;
}
```

**Error format (all endpoints):**
```typescript
interface ErrorResponse {
  error: {
    code: "VALIDATION_ERROR" | "NOT_FOUND" | "CONFLICT" | "UNAUTHORIZED" | "INTERNAL_ERROR";
    message: string;
    details: Record<string, string[]>; // field_name: [error strings]
  }
}
```

</context>

<tasks>

<task type="auto">
  <name>Task 1: Update Prisma schema for JobStage and ScreeningQuestion</name>
  <files>prisma/schema.prisma</files>
  <action>
Update JobStage and ScreeningQuestion models to match API_PROTOCOL_MVP.md spec (D-01, D-02, D-04, D-05):

**JobStage changes (per D-01, D-02):**
- Add `interviewer: String?` field (nullable TEXT, not UUID) to replace `responsible_user_id` concept
- Add `isEnabled: Boolean @default(true)` field to control stage visibility
- Ensure `isCustom`, `order` fields already exist

**ScreeningQuestion changes (per D-04, D-05):**
- Add `expectedAnswer: String?` field (nullable VARCHAR) for storing expected answer ("yes"/"no" or null)
- Keep `answerType` as DB column name (API response uses `type`)
- Keep `required` and `knockout` columns but do NOT expose in API responses (hide in service layer)

**Important:**
- Use Zod validation in service layer to rename `answerType` → `type` in API responses (per D-06)
- Do NOT add `color` field to database (client-computes color from stage order per D-03)
- Ensure tenant isolation: `tenantId` FK on both models (already exists, verify)
- Run `npx prisma generate` after schema update to regenerate Prisma client types

**Reference:** `spec/BACKEND_IMPLEMENTATION_QUICK_START.md` section 1-2 for exact migration SQL patterns.
  </action>
  <verify>
    <automated>npx prisma validate</automated>
  </verify>
  <done>
- Prisma schema compiles without errors
- JobStage has `interviewer`, `isEnabled` fields
- ScreeningQuestion has `expectedAnswer` field
- Prisma client generated successfully
- No breaking changes to Job, Tenant, or Application relations
  </done>
</task>

<task type="auto">
  <name>Task 2: Create Prisma migration for schema changes</name>
  <files>prisma/migrations</files>
  <action>
Generate and verify Prisma migration for JobStage + ScreeningQuestion changes:

```bash
npx prisma migrate dev --name add_job_stage_interviewer_enabled_screening_expected_answer
```

This creates migration file with:
1. ADD `interviewer` TEXT column to job_stages (nullable)
2. ADD `is_enabled` BOOLEAN column to job_stages (default true)
3. ADD `expected_answer` VARCHAR column to screening_questions (nullable)
4. Keep `required` and `knockout` on screening_questions (not dropped, just hidden from API)

**Important:**
- Migration must be safe (idempotent, doesn't drop existing data)
- Run locally: `npm run migrate:dev` and verify with `npx prisma studio`
- Check: existing jobs have `is_enabled=true` for all stages (backfill automatic via DEFAULT)
- Check: existing screening questions have `expected_answer=null` (no backfill needed)

**If migration fails:** Examine logs, fix schema.prisma, then retry migration.
  </action>
  <verify>
    <automated>npm run migrate:dev && npx prisma validate</automated>
  </verify>
  <done>
- Migration file created in prisma/migrations/
- No existing data lost or corrupted
- `is_enabled` defaults to true for all existing stages
- `expected_answer` defaults to null for all existing questions
- Database schema matches Prisma schema
  </done>
</task>

<task type="auto">
  <name>Task 3: Implement GET /config endpoint (hardcoded response)</name>
  <files>
    - src/config/config.controller.ts
    - src/config/config.service.ts
    - src/config/config.module.ts
    - src/app.module.ts
  </files>
  <action>
Create ConfigModule with hardcoded GET /config endpoint per D-07, D-08:

**File: src/config/config.service.ts**
- Inject no dependencies (no DB queries)
- Method `getConfig()` returns hardcoded object matching API_PROTOCOL_MVP.md exactly:
  - `departments`: ["Engineering", "Product", "Design", "Marketing", "HR"]
  - `hiring_managers`: [{ id: "uuid", name: "Jane Smith" }, { id: "uuid", name: "Admin Cohen" }]
  - `job_types`: [{ id: "full_time", label: "Full Time" }, ...]
  - `organization_types`: [{ id: "startup", label: "Startup" }, ...]
  - `screening_question_types`: [{ id: "yes_no", label: "Yes / No" }, ...]
  - `hiring_stages_template`: 4 default stages with colors (Application review/bg-zinc-400, Screening/bg-blue-500, Interview/bg-indigo-400, Offer/bg-emerald-500)

**File: src/config/config.controller.ts**
- Route: `@Controller('config')` with `@Get()` method
- Calls `configService.getConfig()` and returns result
- No validation needed (response is hardcoded)

**File: src/config/config.module.ts**
- `@Module({ controllers: [ConfigController], providers: [ConfigService] })`
- Export nothing (internal)

**File: src/app.module.ts**
- Import `ConfigModule` (if not already there)

**Reference:** `spec/BACKEND_IMPLEMENTATION_QUICK_START.md` section 3 for exact response format.
  </action>
  <verify>
    <automated>curl -s http://localhost:3000/api/config | jq . | grep -q "departments"</automated>
  </verify>
  <done>
- GET /api/config returns 200 OK
- Response has all 6 fields: departments, hiring_managers, job_types, organization_types, screening_question_types, hiring_stages_template
- hiring_stages_template has exactly 4 elements with correct order, colors, is_enabled=true
- Field names match API_PROTOCOL_MVP.md exactly
- Response is identical on every call (hardcoded, no state)
  </done>
</task>

<task type="auto">
  <name>Task 4: Update CreateJobDto and validation schema for new fields</name>
  <files>src/jobs/dto/create-job.dto.ts</files>
  <action>
Update Zod validation schemas to match API_PROTOCOL_MVP.md contracts for POST/PUT requests (D-14, D-15, D-19):

**HiringStageCreateSchema updates:**
- Add `is_enabled: z.boolean().default(true)` field
- Add `color: z.string()` field (required in request, but NOT stored in DB)
- Keep existing fields: `id` (optional client UUID), `name`, `order`, `interviewer` (renamed from responsibleUserId), `is_custom`
- Interviewer: rename to match schema.prisma change

**ScreeningQuestionCreateSchema updates:**
- Add `expected_answer: z.string().nullable().optional()` field
- Keep existing fields: `id` (optional client UUID), `text`, `type` (API input expects "type", maps to answerType in DB)
- Remove `required` and `knockout` from schema (they're in DB but not in API contract)

**CreateJobSchema (top-level):**
- Validation: `title` required, non-empty
- Validation: `job_type` required, enum: full_time|part_time|contract
- Validation: `status` required, enum: draft|open|closed
- Validation: `hiring_flow` required, at least 1 element, at least one with `is_enabled=true` (refine rule)
- All other fields optional (including screening_questions, selected_org_types, skills arrays)

**Error mapping:** Zod validation errors flatten to `{ field_name: [error strings] }` format for error response.

**Reference:** `spec/BACKEND_IMPLEMENTATION_QUICK_START.md` section 4 (DTO updates) shows exact schema structure.
  </action>
  <verify>
    <automated>npm test -- src/jobs/dto/create-job.dto.spec.ts</automated>
  </verify>
  <done>
- Zod schemas compile without errors
- HiringStageCreateSchema validates `is_enabled` and `color` fields
- ScreeningQuestionCreateSchema validates `expected_answer` field
- CreateJobSchema requires title, job_type, status, hiring_flow
- CreateJobSchema rejects if no stages provided (empty hiring_flow)
- CreateJobSchema rejects if all stages have is_enabled=false
- Tests pass (or create tests if they don't exist yet)
  </done>
</task>

<task type="auto">
  <name>Task 5: Implement updated JobsService with GET, POST, PUT, DELETE methods</name>
  <files>src/jobs/jobs.service.ts</files>
  <action>
Update JobsService to implement all 5 endpoints with full response contracts per D-07 through D-22:

**Methods to implement/update:**

1. **findAll()** (GET /jobs, per D-09 through D-12):
   - Query Job with nested JobStage and ScreeningQuestion includes
   - Order hiring_flow by order ASC, screening_questions by order ASC
   - Compute candidate_count from applications
   - Transform to API response format (snake_case, rename answerType→type, hide required/knockout fields)
   - Return `{ jobs: [...], total: N }`

2. **findOne(id: string)** (optional, used by PUT/DELETE to verify job exists):
   - Query single job by id and tenantId
   - Throw NotFoundException if not found
   - Return full job object

3. **createJob(dto: CreateJobDto)** (POST /jobs, per D-14 through D-16):
   - Use Prisma transaction for atomic nested creation
   - If `dto.hiringFlow` empty/missing: seed 4 default stages (Application Review, Screening, Interview, Offer)
   - For each stage: create JobStage with tenantId, name, order, interviewer, is_enabled, is_custom
   - For each screening question: create ScreeningQuestion with tenantId, text, answerType (from type field), expected_answer, order
   - Store all job fields: title, department, location, jobType, status, hiringManager, description, responsibilities, whatWeOffer, salaryRange, mustHaveSkills, niceToHaveSkills, expYearsMin, expYearsMax, preferredOrgTypes
   - Return transformed API response with nested hiring_flow and screening_questions

4. **updateJob(id: string, dto: CreateJobDto)** (PUT /jobs/:id, per D-17 through D-20):
   - Use Prisma transaction for atomic nested updates
   - Update job fields if provided (all optional)
   - Delete and recreate hiring_flow stages (omitted stages are removed per D-18)
   - Delete and recreate screening_questions (omitted questions are removed per D-18)
   - Preserve order field if provided in request (reorder capability per D-18)
   - Verify at least one stage remains enabled (per D-19)
   - Return transformed API response

5. **deleteJob(id: string)** (DELETE /jobs/:id, per D-21, D-22):
   - Soft delete: set job.status = "closed" (do NOT hard delete)
   - Do NOT delete JobStage or ScreeningQuestion rows (they're related to closed job)
   - Return void (204 No Content response handled in controller)

**Response transformation:**
- Create private method `_formatJobResponse(job: JobWithRelations)` that:
  - Converts camelCase Prisma fields to snake_case API fields
  - Renames answerType → type in screening_questions
  - Hides required/knockout fields from screening_questions
  - Computes color field from stage order (Application Review→bg-zinc-400, Screening→bg-blue-500, Interview→bg-indigo-400, Offer→bg-emerald-500)
  - Formats dates as ISO8601 strings
  - Includes all fields from API_PROTOCOL_MVP.md exactly

**Error handling:**
- Throw NotFoundException (404) with code=NOT_FOUND if job doesn't exist
- Let validation errors from Zod throw in controller (not here)
- Catch Prisma errors and throw appropriate NestJS exceptions

**Tenant isolation:**
- All queries filter by tenantId from ConfigService (phase 9 pattern)
- Update/Delete operations include tenantId in where clause to prevent cross-tenant access

**Reference:** `spec/BACKEND_IMPLEMENTATION_QUICK_START.md` section 4 (JobsService implementation) shows service methods.
  </action>
  <verify>
    <automated>npm test -- src/jobs/jobs.service.spec.ts --testNamePattern="findAll|createJob|updateJob|deleteJob"</automated>
  </verify>
  <done>
- JobsService compiles without errors
- findAll() returns jobs with nested hiring_flow and screening_questions, ordered correctly
- createJob() seeds 4 default stages if none provided
- createJob() accepts custom stages and questions from request
- updateJob() updates job and nested data atomically
- updateJob() removes stages/questions omitted from request
- deleteJob() sets status=closed (soft delete)
- All responses use snake_case field names
- All responses include all fields from API_PROTOCOL_MVP.md
- Tests pass or are created/updated
  </done>
</task>

<task type="auto">
  <name>Task 6: Update JobsController with all 5 endpoint handlers and validation</name>
  <files>src/jobs/jobs.controller.ts</files>
  <action>
Update JobsController to implement all 5 endpoints with proper error handling per D-23, D-24, D-25:

**Endpoints to implement:**

1. **GET /jobs** → `findAll()`
   - No parameters needed
   - Call `this.jobsService.findAll()`
   - Return response (JobsService handles formatting)

2. **POST /jobs** → `create(@Body() body: unknown)`
   - Validate request body using `CreateJobSchema.safeParse(body)`
   - If validation fails: throw BadRequestException with error format: `{ error: { code: "VALIDATION_ERROR", message: "Validation failed", details: { field: [errors] } } }`
   - Call `this.jobsService.createJob(result.data)`
   - Return 201 response (NestJS automatic)

3. **PUT /jobs/:id** → `update(@Param('id') id: string, @Body() body: unknown)`
   - Validate request body using `CreateJobSchema.safeParse(body)`
   - If validation fails: throw BadRequestException with error format
   - Call `this.jobsService.updateJob(id, result.data)`
   - Catch NotFoundException (404) from service and re-throw with error format: `{ error: { code: "NOT_FOUND", message: "Job not found" } }`
   - Return 200 response

4. **DELETE /jobs/:id** → `delete(@Param('id') id: string)`
   - Call `this.jobsService.deleteJob(id)`
   - Catch NotFoundException and re-throw with error format
   - Return 204 No Content (NestJS: `new HttpCode(204)` or return nothing)

5. **GET /config** (optional, may be separate controller):
   - Route: `@Get('config')` (if in JobsController)
   - Or separate ConfigController with `@Controller('config')`

**Error format (all endpoints):**
```typescript
{
  error: {
    code: "VALIDATION_ERROR" | "NOT_FOUND" | "CONFLICT" | "UNAUTHORIZED" | "INTERNAL_ERROR",
    message: "Human-readable message",
    details: { field: ["error 1", "error 2"] } // optional
  }
}
```

**Important:**
- Use `@HttpCode(204)` decorator for DELETE endpoint to return 204 No Content
- Validation errors should NOT include nested object details (just field names and error strings)
- 404 errors do NOT need details object
- Tenant isolation is enforced in service (controller trusts service)

**Reference:** `spec/API_PROTOCOL_MVP.md` section on Error Handling for exact format.
  </action>
  <verify>
    <automated>npm test -- src/jobs/jobs.controller.spec.ts</automated>
  </verify>
  <done>
- JobsController compiles without errors
- GET /jobs returns 200 with jobs array
- POST /jobs returns 201 on success, 400 on validation error
- PUT /jobs/:id returns 200 on success, 404 if job not found, 400 on validation error
- DELETE /jobs/:id returns 204 on success, 404 if job not found
- Error responses use standard format with code, message, details
- Validation errors flatten Zod issues to field names
- Tests pass or are created/updated
  </done>
</task>

<task type="auto">
  <name>Task 7: Wire ConfigModule and JobsModule into AppModule</name>
  <files>src/app.module.ts</files>
  <action>
Ensure ConfigModule and JobsModule are properly imported into AppModule:

**src/app.module.ts changes:**
- Import ConfigModule (if not already imported)
- Import JobsModule (if not already imported)
- Both should be in the `@Module({ imports: [...] })` array

**Verify:**
- No duplicate imports
- Import order doesn't matter
- AppModule compiles and bootstrap succeeds

**Optional:** Check if ConfigService and JobsModule are already wired from Phase 9/10 (they likely are).
  </action>
  <verify>
    <automated>npm run build && npm run start:dev &</automated>
  </verify>
  <done>
- AppModule compiles without errors
- App starts successfully with `npm run start:dev`
- Both ConfigModule and JobsModule are imported
- No wiring errors in logs
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 8: Write comprehensive integration tests for all 5 endpoints</name>
  <files>src/jobs/jobs.integration.spec.ts</files>
  <behavior>
**Happy Path Tests:**
- GET /config returns 200 with all 6 fields, hiring_stages_template exactly 4 elements
- GET /jobs returns 200 with jobs array, each with nested hiring_flow and screening_questions
- GET /jobs returns candidate_count as count of applications
- POST /jobs with custom stages creates job with those stages (no seeding)
- POST /jobs without hiring_flow seeds 4 default stages
- POST /jobs with screening_questions creates them in order
- PUT /jobs/:id updates job fields
- PUT /jobs/:id can reorder stages by updating order field
- PUT /jobs/:id omitting a stage removes it
- PUT /jobs/:id omitting a question removes it
- DELETE /jobs/:id sets status=closed (soft delete)
- GET /jobs after DELETE still returns job with status=closed

**Validation Tests:**
- POST /jobs missing title returns 400 VALIDATION_ERROR
- POST /jobs missing job_type returns 400 VALIDATION_ERROR
- POST /jobs missing status returns 400 VALIDATION_ERROR
- POST /jobs with empty hiring_flow returns 400 VALIDATION_ERROR
- POST /jobs with all stages is_enabled=false returns 400 CONFLICT
- POST /jobs with invalid job_type returns 400 VALIDATION_ERROR
- PUT /jobs/:id with all stages disabled returns 400 CONFLICT
- POST /jobs with invalid screening question type returns 400 VALIDATION_ERROR

**Tenant Isolation Tests:**
- GET /jobs only returns jobs for TENANT_ID
- POST /jobs creates job only for TENANT_ID
- PUT /jobs/:id from different tenant returns 404 NOT_FOUND
- DELETE /jobs/:id from different tenant returns 404 NOT_FOUND
- Candidate_count reflects only applications for that tenant

**Error Format Tests:**
- All 400 errors have format: `{ error: { code: "VALIDATION_ERROR", message, details } }`
- All 404 errors have format: `{ error: { code: "NOT_FOUND", message } }`
- All 409 errors have format: `{ error: { code: "CONFLICT", message } }`

**Response Format Tests:**
- GET /jobs response uses snake_case fields
- Response includes all fields from API_PROTOCOL_MVP.md
- Screening question `type` field is not `answerType`
- Hiring stage `color` field is computed (not null, not from DB)
- Dates are ISO8601 strings
  </behavior>
  <action>
Create comprehensive integration test suite (300+ lines) for jobs endpoints using NestJS testing utilities:

```typescript
// src/jobs/jobs.integration.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { ConfigController } from '../config/config.controller';
import { AppConfigService } from '../config/config.service';

describe('Jobs Endpoints Integration Tests', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let configService: ConfigService;
  let tenantId: string;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [JobsController, ConfigController],
      providers: [JobsService, PrismaService, ConfigService, AppConfigService],
    }).compile();

    app = module.createNestApplication();
    prisma = module.get<PrismaService>(PrismaService);
    configService = module.get<ConfigService>(ConfigService);
    tenantId = configService.get<string>('TENANT_ID')!;

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /config', () => {
    it('returns hardcoded response with all 6 fields', async () => {
      const result = await app.get('/api/config').expect(200);
      expect(result.body).toHaveProperty('departments');
      expect(result.body).toHaveProperty('hiring_managers');
      expect(result.body).toHaveProperty('job_types');
      expect(result.body).toHaveProperty('organization_types');
      expect(result.body).toHaveProperty('screening_question_types');
      expect(result.body).toHaveProperty('hiring_stages_template');
    });

    it('hiring_stages_template has exactly 4 elements with correct colors', async () => {
      const result = await app.get('/api/config').expect(200);
      expect(result.body.hiring_stages_template).toHaveLength(4);
      expect(result.body.hiring_stages_template[0].name).toBe('Application review');
      expect(result.body.hiring_stages_template[0].color).toBe('bg-zinc-400');
    });
  });

  describe('GET /jobs', () => {
    it('returns all jobs for tenant with nested hiring_flow and screening_questions', async () => {
      // Create test job first
      await prisma.job.create({
        data: {
          tenantId,
          title: 'Test Job',
          jobType: 'full_time',
          status: 'open',
          hiringStages: { create: [{ tenantId, name: 'Stage 1', order: 1, isEnabled: true, isCustom: false }] },
          screeningQuestions: { create: [{ tenantId, text: 'Question?', answerType: 'yes_no', order: 1 }] },
        },
      });

      const result = await app.get('/api/jobs').expect(200);
      expect(result.body).toHaveProperty('jobs');
      expect(result.body).toHaveProperty('total');
      expect(result.body.jobs[0]).toHaveProperty('hiring_flow');
      expect(result.body.jobs[0]).toHaveProperty('screening_questions');
    });

    it('includes candidate_count as count of applications', async () => {
      // Count applications for a job and verify response
    });
  });

  describe('POST /jobs', () => {
    it('creates job with custom stages (no seeding)', async () => {
      const payload = {
        title: 'Custom Job',
        job_type: 'full_time',
        status: 'draft',
        hiring_flow: [{ id: 'temp-1', name: 'Custom Stage', order: 1, is_enabled: true, is_custom: false, color: 'bg-blue-500', interviewer: null }],
      };
      const result = await app.post('/api/jobs').send(payload).expect(201);
      expect(result.body.hiring_flow).toHaveLength(1);
      expect(result.body.hiring_flow[0].name).toBe('Custom Stage');
    });

    it('seeds 4 default stages if hiring_flow omitted', async () => {
      const payload = { title: 'Default Job', job_type: 'full_time', status: 'draft' };
      const result = await app.post('/api/jobs').send(payload).expect(201);
      expect(result.body.hiring_flow).toHaveLength(4);
    });

    it('returns 400 if title missing', async () => {
      const payload = { job_type: 'full_time', status: 'draft', hiring_flow: [{ name: 'S1', order: 1, is_enabled: true, is_custom: false, color: 'bg-blue-500' }] };
      const result = await app.post('/api/jobs').send(payload).expect(400);
      expect(result.body.error.code).toBe('VALIDATION_ERROR');
      expect(result.body.error.details).toHaveProperty('title');
    });

    it('returns 400 if all stages disabled', async () => {
      const payload = {
        title: 'Job',
        job_type: 'full_time',
        status: 'draft',
        hiring_flow: [{ id: 'temp-1', name: 'S1', order: 1, is_enabled: false, is_custom: false, color: 'bg-blue-500' }],
      };
      const result = await app.post('/api/jobs').send(payload).expect(400);
      expect(result.body.error.code).toBe('CONFLICT');
    });
  });

  describe('PUT /jobs/:id', () => {
    it('updates job fields independently', async () => {
      const job = await prisma.job.create({
        data: {
          tenantId,
          title: 'Original',
          jobType: 'full_time',
          status: 'draft',
          hiringStages: { create: [{ tenantId, name: 'S1', order: 1, isEnabled: true, isCustom: false }] },
        },
      });

      const result = await app.put(`/api/jobs/${job.id}`).send({ title: 'Updated' }).expect(200);
      expect(result.body.title).toBe('Updated');
    });

    it('removes stage omitted from hiring_flow', async () => {
      const job = await prisma.job.create({
        data: {
          tenantId,
          title: 'Test',
          jobType: 'full_time',
          status: 'draft',
          hiringStages: {
            create: [
              { tenantId, name: 'S1', order: 1, isEnabled: true, isCustom: false },
              { tenantId, name: 'S2', order: 2, isEnabled: true, isCustom: false },
            ],
          },
        },
      });

      const result = await app.put(`/api/jobs/${job.id}`).send({
        title: 'Test',
        job_type: 'full_time',
        status: 'draft',
        hiring_flow: [{ id: job.id, name: 'S1', order: 1, is_enabled: true, is_custom: false, color: 'bg-blue-500' }],
      }).expect(200);
      expect(result.body.hiring_flow).toHaveLength(1);
    });

    it('returns 404 if job not found', async () => {
      const result = await app.put('/api/jobs/nonexistent').send({ title: 'Test', job_type: 'full_time', status: 'draft', hiring_flow: [] }).expect(404);
      expect(result.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('DELETE /jobs/:id', () => {
    it('soft-deletes job (sets status=closed)', async () => {
      const job = await prisma.job.create({
        data: {
          tenantId,
          title: 'To Delete',
          jobType: 'full_time',
          status: 'open',
          hiringStages: { create: [{ tenantId, name: 'S1', order: 1, isEnabled: true, isCustom: false }] },
        },
      });

      await app.delete(`/api/jobs/${job.id}`).expect(204);

      const deleted = await prisma.job.findUnique({ where: { id: job.id } });
      expect(deleted?.status).toBe('closed');
    });

    it('returns 404 if job not found', async () => {
      const result = await app.delete('/api/jobs/nonexistent').expect(404);
      expect(result.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('Tenant Isolation', () => {
    it('GET /jobs only returns jobs for current tenant', async () => {
      // Create jobs for different tenants, verify isolation
    });

    it('PUT/DELETE on job from different tenant returns 404', async () => {
      // Test cross-tenant access prevention
    });
  });

  describe('Response Format', () => {
    it('uses snake_case field names', async () => {
      const result = await app.get('/api/jobs').expect(200);
      expect(result.body.jobs[0]).toHaveProperty('job_type');
      expect(result.body.jobs[0]).toHaveProperty('hiring_manager');
      expect(result.body.jobs[0]).not.toHaveProperty('jobType');
    });

    it('screening_questions have type field (not answerType)', async () => {
      const result = await app.get('/api/jobs').expect(200);
      const question = result.body.jobs[0]?.screening_questions[0];
      expect(question).toHaveProperty('type');
      expect(question).not.toHaveProperty('answerType');
    });

    it('hiring_flow has computed color field', async () => {
      const result = await app.get('/api/jobs').expect(200);
      const stage = result.body.jobs[0]?.hiring_flow[0];
      expect(stage).toHaveProperty('color');
      expect(stage.color).toMatch(/^bg-/); // Tailwind class
    });
  });
});
```

**Test organization:**
- Group tests by endpoint (GET /config, GET /jobs, POST /jobs, PUT /jobs/:id, DELETE /jobs/:id)
- Group validation and error tests
- Group tenant isolation tests
- Group response format tests

**Important:**
- Use real PrismaService and ConfigService (integration tests, not unit)
- Seed test data as needed in beforeEach/beforeAll
- Clean up data in afterEach/afterAll
- Test both happy paths and error scenarios
- Verify error response formats match spec exactly
  </action>
  <verify>
    <automated>npm test -- src/jobs/jobs.integration.spec.ts</automated>
  </verify>
  <done>
- All integration tests pass
- Happy path tests pass (GET config, GET jobs, POST, PUT, DELETE)
- Validation tests pass (400 errors on bad input)
- Error format tests pass (standard error response)
- Tenant isolation tests pass (no cross-tenant leakage)
- Response format tests pass (snake_case, correct field names)
- Test file covers all 5 endpoints and key scenarios
  </done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <what-built>
- Updated Prisma schema with JobStage (interviewer, is_enabled) and ScreeningQuestion (expected_answer)
- GET /config endpoint returning hardcoded response
- GET /jobs endpoint returning full job data with nested hiring_flow and screening_questions
- POST /jobs creating jobs with atomic nested stage/question creation and default seeding
- PUT /jobs/:id updating jobs with atomic nested updates (delete/recreate pattern)
- DELETE /jobs/:id soft-deleting jobs (status=closed)
- Validation and error handling per API_PROTOCOL_MVP.md
- Integration tests covering all 5 endpoints, validation, tenant isolation, response formats
  </what-built>
  <how-to-verify>
**Manual verification steps:**

1. **Start local dev server:**
   ```bash
   npm run start:dev
   ```

2. **Test GET /config:**
   ```bash
   curl -s http://localhost:3000/api/config | jq .
   ```
   Verify: 6 fields, hiring_stages_template exactly 4 elements with colors.

3. **Test POST /jobs (with default stages):**
   ```bash
   curl -X POST http://localhost:3000/api/jobs \
     -H "Content-Type: application/json" \
     -d '{
       "title": "Senior Engineer",
       "job_type": "full_time",
       "status": "draft"
     }' | jq .
   ```
   Verify: Returns 201, job has 4 default hiring_flow stages.

4. **Test POST /jobs (with custom stages):**
   ```bash
   curl -X POST http://localhost:3000/api/jobs \
     -H "Content-Type: application/json" \
     -d '{
       "title": "Frontend Dev",
       "job_type": "full_time",
       "status": "open",
       "hiring_flow": [
         {
           "id": "temp-1",
           "name": "Screening",
           "order": 1,
           "is_enabled": true,
           "interviewer": "John Doe",
           "is_custom": false,
           "color": "bg-blue-500"
         }
       ],
       "screening_questions": [
         {
           "id": "temp-q1",
           "text": "React experience?",
           "type": "yes_no",
           "expected_answer": "yes"
         }
       ]
     }' | jq .
   ```
   Verify: Returns 201, hiring_flow has 1 stage, screening_questions has 1 question.

5. **Test GET /jobs:**
   ```bash
   curl -s http://localhost:3000/api/jobs | jq .
   ```
   Verify: Returns jobs array, each with nested hiring_flow and screening_questions, snake_case field names, candidate_count.

6. **Test PUT /jobs/:id (update title):**
   ```bash
   # Get a job ID from GET /jobs, then:
   curl -X PUT http://localhost:3000/api/jobs/{job_id} \
     -H "Content-Type: application/json" \
     -d '{
       "title": "Updated Title",
       "job_type": "full_time",
       "status": "open",
       "hiring_flow": []
     }' | jq .
   ```
   Verify: Returns 200, title updated.

7. **Test DELETE /jobs/:id (soft delete):**
   ```bash
   curl -X DELETE http://localhost:3000/api/jobs/{job_id}
   ```
   Verify: Returns 204 No Content. Then GET /jobs and confirm job still exists with status=closed.

8. **Test validation error (missing title):**
   ```bash
   curl -X POST http://localhost:3000/api/jobs \
     -H "Content-Type: application/json" \
     -d '{"job_type": "full_time"}' | jq .
   ```
   Verify: Returns 400 with `{ error: { code: "VALIDATION_ERROR", message, details: { title: [...] } } }`.

9. **Run integration tests:**
   ```bash
   npm test -- src/jobs/jobs.integration.spec.ts
   ```
   Verify: All tests pass (green output).
  </how-to-verify>
  <resume-signal>
Type "approved" once manual testing confirms all 5 endpoints work correctly, error handling matches spec, response formats are correct (snake_case, all fields present), and tenant isolation is enforced.

Or describe any issues found (e.g., "field name wrong", "status code wrong", "validation error format incorrect") and they will be fixed.
  </resume-signal>
</task>

</tasks>

<verification>
**Phase completion verification checklist:**

1. **Schema Updates** — Verify Prisma schema compiles and migration runs:
   - `npx prisma validate` passes
   - `npm run migrate:dev` completes without errors
   - JobStage has `interviewer` and `isEnabled` fields
   - ScreeningQuestion has `expectedAnswer` field

2. **GET /config** — Verify hardcoded response:
   - Endpoint responds at `/api/config`
   - Response includes all 6 fields
   - `hiring_stages_template` has exactly 4 elements
   - All colors match API_PROTOCOL_MVP.md

3. **GET /jobs** — Verify full response contract:
   - Includes nested `hiring_flow` (JobStage[]) and `screening_questions` (ScreeningQuestion[])
   - Uses snake_case field names
   - Includes all fields from API_PROTOCOL_MVP.md
   - `candidate_count` matches application count
   - Response format: `{ jobs: [...], total: N }`

4. **POST /jobs** — Verify creation with atomic nested inserts:
   - Creates job with provided stages or seeds 4 defaults
   - Returns 201 with full job response
   - Validation rejects missing title, job_type, status, hiring_flow
   - Validation rejects all stages disabled
   - At least one stage must have `is_enabled=true`

5. **PUT /jobs/:id** — Verify atomic update:
   - Updates all job fields (optional)
   - Recreates stages (omitted = removed)
   - Recreates questions (omitted = removed)
   - Preserves order field for reordering
   - Returns 200 with updated job response
   - Returns 404 if job not found

6. **DELETE /jobs/:id** — Verify soft delete:
   - Sets job.status = "closed" (NOT hard delete)
   - Returns 204 No Content
   - Returns 404 if job not found
   - GET /jobs still returns deleted job with status=closed

7. **Validation & Error Handling** — Verify error format:
   - All errors use format: `{ error: { code, message, details } }`
   - 400 VALIDATION_ERROR includes details object
   - 404 NOT_FOUND includes code + message
   - 409 CONFLICT for business logic (all stages disabled)
   - Validation error details flatten Zod issues to field names

8. **Tenant Isolation** — Verify multi-tenancy:
   - All queries filter by `configService.get('TENANT_ID')`
   - GET /jobs returns only jobs for current tenant
   - PUT/DELETE on cross-tenant job returns 404
   - `candidate_count` includes only applications for current tenant

9. **Integration Tests** — Verify test coverage:
   - `npm test -- src/jobs/jobs.integration.spec.ts` passes
   - Tests cover all 5 endpoints
   - Tests cover happy path + validation scenarios
   - Tests cover tenant isolation
   - Tests verify response formats

10. **Response Format** — Verify field names and types:
    - All fields use snake_case (not camelCase)
    - Screening question field: `type` (not `answerType`)
    - Hiring stage field: `color` (computed, not null)
    - Required/knockout fields hidden from screening_questions
    - Dates are ISO8601 strings

</verification>

<success_criteria>
Phase 11 is complete when:

1. ✅ Prisma schema compiles with JobStage (interviewer, is_enabled) and ScreeningQuestion (expected_answer)
2. ✅ Migration runs successfully (`npm run migrate:dev`)
3. ✅ GET /api/config returns 200 with hardcoded response (6 fields, 4 stages)
4. ✅ GET /api/jobs returns 200 with complete job data (all fields, nested hiring_flow/screening_questions)
5. ✅ POST /api/jobs returns 201 on success, 400 on validation error, seeds 4 default stages if omitted
6. ✅ PUT /api/jobs/:id returns 200 on success, 404 if not found, atomically updates nested data
7. ✅ DELETE /api/jobs/:id returns 204 on success, soft-deletes (status=closed), 404 if not found
8. ✅ All error responses use standard format: `{ error: { code, message, details } }`
9. ✅ Validation enforces: title required, job_type required, status required, hiring_flow required, at least one stage enabled
10. ✅ Tenant isolation: all queries filter by TENANT_ID, cross-tenant access returns 404
11. ✅ Response field names match API_PROTOCOL_MVP.md exactly (snake_case)
12. ✅ Integration tests pass: `npm test -- src/jobs/jobs.integration.spec.ts`
13. ✅ Human verification checkpoint approved: all 5 endpoints work, error handling correct, response formats correct

**Definition of Done:**
- All 8 tasks complete (schema, migration, config endpoint, DTOs, service methods, controller handlers, wiring, tests)
- All automated tests pass
- Human verification checkpoint approved
- No console errors on `npm run start:dev`
- All response fields from API_PROTOCOL_MVP.md present in responses
- No cross-tenant data leakage

</success_criteria>

<output>
After completion, create `.planning/phases/11-review-and-validate-api-protocol-mvp-spec-and-implementation-guide/11-01-SUMMARY.md` with:

1. **Execution Summary** — What was done, how long it took, any deviations from plan
2. **Artifacts Created** — List of modified files + line counts
3. **Test Results** — npm test output (pass/fail counts)
4. **Verification Checklist** — Confirm all items from success_criteria were met
5. **Known Issues** — Any bugs or edge cases discovered
6. **Next Phase** — What comes after Phase 11 (Phase 12 context)

Format as `.md` file in same directory as this plan.
</output>

