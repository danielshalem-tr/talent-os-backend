# Phase 11: API Protocol MVP Implementation - Research

**Researched:** 2026-03-25
**Domain:** NestJS 11 + Prisma 7 API implementation patterns
**Confidence:** HIGH

## Summary

Phase 11 implements the API protocol MVP: 5 endpoints (GET /config, GET /jobs, POST /jobs, PUT /jobs/:id, DELETE /jobs/:id) with schema changes to JobStage and ScreeningQuestion. The core challenges are: (1) atomic nested resource updates using Prisma transactions, (2) safe schema migration for column renames (`responsible_user_id` → `interviewer`), (3) response mapping between snake_case database and API field names with aliasing and computed fields, and (4) soft-delete query patterns that correctly filter closed jobs. Research shows these are well-established patterns in NestJS + Prisma ecosystems with clear best practices.

**Primary recommendation:** Use Prisma's explicit transaction callback pattern (`prisma.$transaction(async tx => ...)`) for nested updates, implement response DTOs with field mapping via `@map()` in Prisma and manual transformation in service layer, use database constraints for schema safety (ADD COLUMN + copy + DROP), and query soft-deletes with explicit `where: { status: { not: 'closed' } }` filters.

---

<user_constraints>

## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Rename `responsible_user_id` → `interviewer` (TEXT, nullable) — no user table in Phase 1, keep as free-text name only
- **D-02:** Add `is_enabled` (BOOLEAN, default: true) to control stage visibility in hiring flow
- **D-03:** Color field is client-computed only, NOT stored in database — computed in API response based on stage order/position
- **D-04:** Add `expected_answer` (VARCHAR, nullable) — stores expected answer for yes_no questions ("yes" or "no") or null for text questions
- **D-05:** Remove `required` and `knockout` columns in migration — cleaner schema, unused in MVP, supports future enhancement without schema rework
- **D-06:** API response field renamed `type` (not `answerType`) — database column stays `answer_type` to maintain consistency with Prisma conventions
- **D-21:** Soft delete via status: set job.status = "closed" (do NOT hard delete rows, do NOT add deleted_at column)
- **D-23-25:** Error response format with code/message/details structure, validation codes (VALIDATION_ERROR, NOT_FOUND, CONFLICT, UNAUTHORIZED, INTERNAL_ERROR), tenant isolation via x-tenant-id header

### Claude's Discretion
- Exact Tailwind color classes returned in GET /config `hiring_stages_template` (must be valid for client CSS-in-JS)
- Response field ordering and structure details (as long as protocol spec is matched)
- Test file organization and grouping strategy
- Exact transaction isolation level (Prisma defaults to READ COMMITTED — acceptable for Phase 1)

### Deferred Ideas (OUT OF SCOPE)
- GET /candidates endpoint updates — separate phase
- Pagination for GET /jobs — MVP returns all jobs
- Advanced filtering on GET /jobs — deferred to Phase 2+
- Dynamic config from database (hiring_managers, departments) — hardcoded for MVP
- Multiple interviewers per stage — future enhancement

</user_constraints>

<phase_requirements>

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| RAPI-01 | REST API endpoints for reading candidates, applications, scores | GET /jobs response structure documented; POST/PUT/DELETE patterns verified |
| (Phase 11 specific) | Implement GET /config, GET /jobs, POST /jobs, PUT /jobs/:id, DELETE /jobs/:id | All endpoint patterns researched with Prisma transaction examples |
| (Phase 11 specific) | Update Prisma schema: JobStage.interviewer, JobStage.is_enabled, ScreeningQuestion.expected_answer | Safe migration pattern documented (ADD → COPY → DROP); backfill strategies provided |
| (Phase 11 specific) | Response field mapping (snake_case DB → API, aliasing, hiding fields) | DTO pattern with Prisma `@map()` and service-layer transformation researched |
| (Phase 11 specific) | Atomic nested updates (stages + questions in single transaction) | Prisma transaction callback pattern (`$transaction`) verified in existing code |
| (Phase 11 specific) | Soft delete (status = "closed", no hard delete) | Query filtering pattern and impact on existing queries documented |

</phase_requirements>

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| NestJS | 11.0+ | HTTP framework, DI, validation | Locked in CLAUDE.md; industry standard for production TypeScript backends |
| Prisma | 7.0+ | ORM, type-safe database access, migrations | Locked in CLAUDE.md; handles transactions, relationships, type generation |
| PostgreSQL | 16+ | Relational database | Locked; required for pg_trgm, transaction isolation, JSON/array types |
| TypeScript | 5.3+ | Type safety | Locked; required for Prisma client generation, NestJS decorators |
| Zod | 3.22+ | Request validation | Established in Phase 10 (create-job.dto.ts uses Zod schema) |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @nestjs/common | 11.0+ | HTTP exceptions, decorators (Controller, Get, Post, Put, Delete, Body) | For all endpoint handlers |
| @nestjs/config | Latest | ConfigService (TENANT_ID injection) | Already established in Phase 1–10 |
| class-transformer | 0.5+ | Field mapping in DTOs (optional, can use plain objects) | Optional; prefer plain Zod for now per Phase 10 pattern |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Prisma `$transaction` | Manual `BEGIN/COMMIT/ROLLBACK` SQL | More control but manual transaction handling, deadlock risk, need rollback logic |
| Zod for validation | class-validator (NestJS standard) | Zod already chosen in Phase 10; switching adds migration cost |
| Field mapping in service | GraphQL scalar coercion | Unnecessary complexity; simple service-layer transformation is sufficient |

**Installation:**
```bash
npm install @nestjs/common @nestjs/config zod
# Already in project; no new packages needed
```

**Version verification:**
```bash
npm view nestjs version     # Should be 11.0+
npm view prisma version     # Should be 7.0+
npm view zod version        # Should be 3.22+
```

---

## Architecture Patterns

### Recommended Project Structure
```
src/jobs/
├── jobs.controller.ts          # HTTP routes: GET, POST, PUT, DELETE
├── jobs.service.ts             # Business logic: create, read, update, delete (soft)
├── dto/
│   ├── create-job.dto.ts       # POST /jobs request schema (Zod)
│   ├── update-job.dto.ts       # PUT /jobs/:id request schema (Zod)
│   └── job.response.ts         # GET /jobs response DTO (field mapping)
├── jobs.module.ts              # DI wiring
├── jobs.controller.spec.ts     # Controller unit tests
├── jobs.service.spec.ts        # Service unit tests
└── jobs.integration.spec.ts    # E2E integration tests

src/config/
├── config.controller.ts        # GET /config route
├── config.service.ts           # Hardcoded response objects
└── config.response.ts          # Response shape (TS interface)
```

### Pattern 1: Atomic Nested Updates with Prisma Transactions

**What:** Multiple related models (Job + JobStages + ScreeningQuestions) created/updated/deleted atomically in a single transaction. If any operation fails, entire transaction rolls back.

**When to use:** PUT /jobs/:id with optional stages/questions arrays — omitted items are deleted, new items created, existing items updated. All changes must succeed or none succeed.

**Example:**
```typescript
// Source: Prisma 7 docs + verified in src/ingestion/ingestion.processor.ts (lines 135-156)

async updateJob(jobId: string, tenantId: string, dto: UpdateJobDto) {
  return this.prisma.$transaction(async (tx) => {
    // Step 1: Update main job fields
    const updatedJob = await tx.job.update({
      where: { id: jobId },
      data: {
        title: dto.title,
        status: dto.status,
        // ... other fields
      },
    });

    // Step 2: Handle hiring_flow (stages) — delete old, create new
    // Strategy: delete all stages for this job, then create fresh ones
    await tx.jobStage.deleteMany({
      where: { jobId: jobId },
    });

    if (dto.hiringFlow && dto.hiringFlow.length > 0) {
      await tx.jobStage.createMany({
        data: dto.hiringFlow.map(stage => ({
          tenantId,
          jobId,
          name: stage.name,
          order: stage.order,
          interviewer: stage.interviewer || null,
          isEnabled: stage.is_enabled,
          isCustom: stage.is_custom || false,
        })),
      });
    }

    // Step 3: Handle screening_questions — delete old, create new
    await tx.screeningQuestion.deleteMany({
      where: { jobId: jobId },
    });

    if (dto.screeningQuestions && dto.screeningQuestions.length > 0) {
      await tx.screeningQuestion.createMany({
        data: dto.screeningQuestions.map((q, i) => ({
          tenantId,
          jobId,
          text: q.text,
          answerType: q.type, // Note: DTO field is 'type', DB column is 'answer_type'
          expectedAnswer: q.expected_answer || null,
          order: q.order ?? i + 1,
        })),
      });
    }

    // Step 4: Return complete updated job with nested relations
    return tx.job.findUnique({
      where: { id: jobId },
      include: {
        hiringStages: { orderBy: { order: 'asc' } },
        screeningQuestions: { orderBy: { order: 'asc' } },
        _count: { select: { applications: true } },
      },
    });
  });
}
```

**Key points:**
- Wrap entire block in `prisma.$transaction(async (tx) => { ... })`
- Use `tx` client instead of `this.prisma` inside transaction
- If ANY await throws, entire transaction rolls back automatically
- Prisma 7 uses READ COMMITTED isolation (sufficient for Phase 1 — no concurrent updates to same job expected)

### Pattern 2: Response Field Mapping (DB → API)

**What:** Database uses snake_case fields and different column names (e.g., `answer_type` in DB, `type` in API; `responsible_user_id` in old schema, `interviewer` in new schema). API responses return clean snake_case with aliases.

**When to use:** All endpoints returning data — GET /jobs, POST /jobs, PUT /jobs/:id

**Example:**
```typescript
// Source: Established in Phase 9 (jobs.service.ts JobResponse interface)

// Database model (from schema.prisma)
model ScreeningQuestion {
  id         String  @id
  answerType String  @map("answer_type") @db.Text  // DB column: answer_type
  expectedAnswer String? @map("expected_answer") @db.Text // New in Phase 11
  required   Boolean @default(false)                 // Being REMOVED in Phase 11
  // ...
}

// API Response DTO
interface ScreeningQuestionResponse {
  id: string;
  text: string;
  type: string;           // Map from answerType, rename to 'type' per spec
  expected_answer: string | null;  // Passthrough snake_case
  // Note: required/knockout NOT in response (D-05)
}

// Service transformation
private transformScreeningQuestion(q: ScreeningQuestion): ScreeningQuestionResponse {
  return {
    id: q.id,
    text: q.text,
    type: q.answerType,    // Rename answerType → type
    expected_answer: q.expectedAnswer || null,
    // DO NOT include: required, knockout (removed from response per D-05)
  };
}

// Hiring stage response (includes computed color)
private transformJobStage(stage: JobStage, stageIndex: number): JobStageResponse {
  // Color is computed from order (stage index), NOT stored in DB per D-03
  const colors = ['bg-zinc-400', 'bg-blue-500', 'bg-indigo-400', 'bg-emerald-500'];

  return {
    id: stage.id,
    name: stage.name,
    is_enabled: stage.isEnabled,  // Rename from isEnabled
    interviewer: stage.interviewer || null,  // Passthrough (was responsible_user_id)
    color: colors[stageIndex % colors.length], // Computed per order
    is_custom: stage.isCustom,
    order: stage.order,
  };
}
```

**Key points:**
- Prisma's `@map()` handles DB column naming, Prisma field names are camelCase
- Service layer transforms Prisma results to API shape (snake_case + field renames)
- Computed fields (color) added in transformation, not stored in DB
- Hidden fields (required, knockout) are excluded from response object

### Pattern 3: Safe Schema Migration (Column Rename)

**What:** Rename `responsible_user_id` → `interviewer` without data loss, handling existing data safely.

**When to use:** Any breaking schema change where historical data exists and must be preserved.

**Example:**
```typescript
// Prisma migration (auto-generated via `prisma migrate dev`, then edit to be explicit)

-- CreateTable JobStage (partial — existing table, adding new columns)
ALTER TABLE "job_stages" ADD COLUMN "interviewer" TEXT;

-- Copy old data to new column (safe — old column still exists)
UPDATE "job_stages" SET "interviewer" = "responsible_user_id" WHERE "responsible_user_id" IS NOT NULL;

-- Drop old column (after verification)
ALTER TABLE "job_stages" DROP COLUMN "responsible_user_id";

-- Update Prisma model to reference new field
// schema.prisma:
// OLD: responsibleUserId String? @map("responsible_user_id") @db.Text
// NEW: interviewer String? @db.Text
```

**Key points:**
- ADD COLUMN first (does not lock table during copy)
- Copy data in separate UPDATE statement
- DROP old column last (reversible if needed)
- Verify with `SELECT COUNT(*) FROM job_stages WHERE interviewer IS NOT NULL` before DROP
- For existing jobs with null responsible_user_id: interviewer will be null (OK — field is nullable)

### Pattern 4: Soft Delete Query Filtering

**What:** Instead of hard delete (`DELETE FROM jobs`), set status = "closed". All queries must explicitly exclude closed jobs to avoid returning deleted data.

**When to use:** DELETE /jobs/:id endpoint and any query that should only return active jobs (GET /jobs, scoring loops, etc.)

**Example:**
```typescript
// DELETE /jobs/:id — soft delete
async deleteJob(jobId: string, tenantId: string) {
  // D-21: Soft delete via status, return 204 No Content
  await this.prisma.job.update({
    where: { id: jobId },
    data: { status: 'closed' },
  });
  // Note: No return value for 204 response
}

// GET /jobs — exclude closed jobs
async findAll(): Promise<{ jobs: JobResponse[]; total: number }> {
  const tenantId = this.configService.get<string>('TENANT_ID')!;

  // IMPORTANT: Filter out closed jobs
  const jobs = await this.prisma.job.findMany({
    where: {
      tenantId,
      status: { not: 'closed' }, // Exclude closed (soft-deleted) jobs
    },
    include: {
      hiringStages: { orderBy: { order: 'asc' } },
      screeningQuestions: { orderBy: { order: 'asc' } },
      _count: { select: { applications: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  return { jobs: result, total: result.length };
}

// Scoring loop (Phase 7) — must also exclude closed
const activeJobs = await this.prisma.job.findMany({
  where: {
    tenantId,
    status: 'open', // Only score open jobs (excludes draft, closed)
  },
});
```

**Key points:**
- Always use `where: { status: { not: 'closed' } }` or `status: 'open'` depending on scope
- Database does not enforce — application code is responsible
- Index on `(tenant_id, status)` already exists per schema.prisma line 59 → ensures fast filtering
- DELETE endpoint returns 204 No Content (no body)

### Pattern 5: Error Response Mapping

**What:** Transform Zod validation errors and database errors into standardized error response format (D-23: `{ error: { code, message, details: { field: [errors] } } }`).

**When to use:** All POST/PUT endpoints with validation

**Example:**
```typescript
// Source: Established in Phase 10 (jobs.controller.ts lines 17-21)

// Controller validation
@Post()
async create(@Body() body: unknown) {
  const result = CreateJobSchema.safeParse(body);
  if (!result.success) {
    // Transform Zod errors to API format
    const details: Record<string, string[]> = {};
    for (const issue of result.error.issues) {
      const path = issue.path.join('.');
      if (!details[path]) details[path] = [];
      details[path].push(issue.message);
    }

    throw new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: 'Validation failed',
      details,
    });
  }
  return this.jobsService.createJob(result.data);
}

// Service NOT_FOUND
async getJob(jobId: string, tenantId: string) {
  const job = await this.prisma.job.findFirst({
    where: { id: jobId, tenantId },
    include: { hiringStages: true, screeningQuestions: true },
  });

  if (!job) {
    throw new NotFoundException({
      code: 'NOT_FOUND',
      message: `Job ${jobId} not found`,
      details: { job_id: ['Job does not exist for this tenant'] },
    });
  }

  return job;
}

// Conflict (all stages disabled)
if (!dto.hiringFlow.some(s => s.is_enabled === true)) {
  throw new BadRequestException({
    code: 'CONFLICT',
    message: 'At least one hiring stage must be enabled',
    details: { hiring_flow: ['All stages are disabled'] },
  });
}
```

**Key points:**
- Zod `safeParse()` returns `{ success, data, error }` — check success first
- Extract error path and message from each issue, group by field
- Use BadRequestException for validation (400), NotFoundException for 404, throw directly from service
- Details field contains array of error strings per field

---

## Prisma Schema Patterns

### Adding new columns (Phase 11 changes)

**Pattern:** Add columns with defaults, backfill data, optionally drop old column

**JobStage additions:**
```prisma
model JobStage {
  id          String   @id

  // EXISTING
  responsibleUserId String? @map("responsible_user_id") @db.Text  // Being renamed

  // NEW in Phase 11
  interviewer String?  @db.Text  // New name for responsible_user_id (Step 1: ADD)
  isEnabled   Boolean  @default(true) @map("is_enabled")  // Stage visibility control

  // After migration: drop responsibleUserId (Step 3: DROP old)
}
```

**ScreeningQuestion additions:**
```prisma
model ScreeningQuestion {
  id         String   @id
  answerType String   @map("answer_type") @db.Text  // Keep existing, but ...

  // NEW in Phase 11
  expectedAnswer String? @map("expected_answer") @db.Text  // For yes_no: "yes"/"no", null for text

  // REMOVED in Phase 11 (migration drops these columns)
  // required   Boolean  @default(false)  // D-05: removal
  // knockout   Boolean  @default(false)  // D-05: removal
}
```

### Index impact (soft delete)

**Existing index:** `@@index([tenantId, status], name: "idx_jobs_active")`

This index is used when filtering by:
```sql
WHERE tenant_id = ? AND status != 'closed'
-- OR
WHERE tenant_id = ? AND status = 'open'
```

PostgreSQL can use this index efficiently for `status != 'closed'` (negation), though it requires a full table scan for closed rows. This is acceptable at MVP scale (< 100 jobs).

---

## Common Pitfalls

### Pitfall 1: Forgetting transaction rollback on nested create/delete

**What goes wrong:** Create job → create 3 stages → create 5 questions. Question 3 fails (validation error in service). Stage 1-3 are already in DB. Job orphaned with partial data.

**Why it happens:** Not using `$transaction()`, or catching errors inside transaction without re-throwing.

**How to avoid:**
- Always wrap multi-model operations in `prisma.$transaction(async tx => { ... })`
- Never catch errors inside transaction unless re-throwing immediately
- Let errors propagate — Prisma handles rollback automatically

**Warning signs:**
- Database has partial job data (stages but no questions)
- Tests show orphaned records after failed create
- Transaction logs show incomplete writes

### Pitfall 2: Query returns soft-deleted data

**What goes wrong:** GET /jobs returns closed jobs. User edits job that was "deleted". Stage query doesn't filter by status.

**Why it happens:** Forgetting to add `where: { status: { not: 'closed' } }` to queries.

**How to avoid:**
- Add `status` filter to EVERY job query in service
- Use constants: `const ACTIVE_STATUSES = ['draft', 'open']`
- Test that GET /jobs does NOT return soft-deleted jobs

**Warning signs:**
- Manual database query shows closed job, API returns it
- Delete endpoint seems to work, but job reappears on GET
- Scoring loop processes closed jobs (wastes credits)

### Pitfall 3: Field mapping loses data

**What goes wrong:** Service maps `answerType` → `type`, but API consumer reads `answer_type` and gets undefined.

**Why it happens:** Inconsistent naming between Prisma (camelCase), DB (snake_case), and API (spec-defined).

**How to avoid:**
- Define transformation function for each model: `toJobResponse()`, `toJobStageResponse()`
- Use these functions consistently in all endpoints
- Test that API response has exact field names from spec

**Warning signs:**
- Frontend reads undefined fields after API call
- Responses have extra/missing fields compared to spec
- Type checking fails in frontend (TypeScript says field doesn't exist)

### Pitfall 4: Computed fields stored in database

**What goes wrong:** Color field is stored in job_stages table. Later, design changes colors. Old data has wrong colors.

**Why it happens:** Storing derived data instead of computing it.

**How to avoid:**
- Color is computed in `toJobStageResponse()` from stage order
- Color is NOT stored in DB per D-03
- Test that color matches spec template based on order

**Warning signs:**
- Schema has `color` column in job_stages
- Migration includes adding `color` column
- API response includes color, but it's not in Prisma model

### Pitfall 5: Tenant isolation bypass

**What goes wrong:** GET /jobs for tenant A returns tenant B's jobs. Different tenants cross-contaminate.

**Why it happens:** Forgetting `tenantId` filter in queries, or not reading x-tenant-id header.

**How to avoid:**
- Extract tenantId in every controller method: `const tenantId = this.configService.get('TENANT_ID')!`
- Pass tenantId to service method
- Add `where: { tenantId }` to EVERY prisma query
- Test with multiple tenantIds

**Warning signs:**
- Integration test with tenantId A sees data from tenantId B
- Payload has different tenantId but query succeeds
- No tenantId filter visible in service where clause

---

## Code Examples

Verified patterns from existing codebase + API protocol spec:

### GET /config (Hardcoded Response)

```typescript
// Source: API_PROTOCOL_MVP.md + NestJS controller pattern

import { Controller, Get } from '@nestjs/common';
import { ConfigService } from './config.service';

@Controller('api')
export class ConfigController {
  constructor(private readonly configService: ConfigService) {}

  @Get('config')
  getConfig() {
    return this.configService.getConfigResponse();
  }
}

// config.service.ts
@Injectable()
export class ConfigService {
  getConfigResponse() {
    return {
      departments: [
        'Engineering',
        'Product',
        'Design',
        'Marketing',
        'HR',
      ],
      hiring_managers: [
        { id: 'uuid-1', name: 'Jane Smith' },
        { id: 'uuid-2', name: 'Admin Cohen' },
      ],
      job_types: [
        { id: 'full_time', label: 'Full Time' },
        { id: 'part_time', label: 'Part Time' },
        { id: 'contract', label: 'Contract' },
      ],
      organization_types: [
        { id: 'startup', label: 'Startup' },
        { id: 'scale_up', label: 'Scale-up' },
        // ...
      ],
      screening_question_types: [
        { id: 'yes_no', label: 'Yes / No' },
        { id: 'text', label: 'Free Text' },
      ],
      hiring_stages_template: [
        { name: 'Application review', is_enabled: true, color: 'bg-zinc-400', is_custom: false, order: 1 },
        { name: 'Screening', is_enabled: true, color: 'bg-blue-500', is_custom: false, order: 2 },
        { name: 'Interview', is_enabled: true, color: 'bg-indigo-400', is_custom: false, order: 3 },
        { name: 'Offer', is_enabled: true, color: 'bg-emerald-500', is_custom: false, order: 4 },
      ],
    };
  }
}
```

### PUT /jobs/:id (Atomic Nested Update)

```typescript
// Source: Prisma transaction pattern + API protocol spec

async updateJob(jobId: string, tenantId: string, dto: UpdateJobDto) {
  // Verify job exists and belongs to tenant
  const existing = await this.prisma.job.findFirst({
    where: { id: jobId, tenantId },
  });
  if (!existing) {
    throw new NotFoundException({
      code: 'NOT_FOUND',
      message: `Job ${jobId} not found`,
    });
  }

  // Validate at least one stage enabled (D-19)
  if (dto.hiringFlow && dto.hiringFlow.length > 0) {
    const hasEnabled = dto.hiringFlow.some(s => s.is_enabled === true);
    if (!hasEnabled) {
      throw new BadRequestException({
        code: 'CONFLICT',
        message: 'At least one hiring stage must be enabled',
        details: { hiring_flow: ['All stages are disabled'] },
      });
    }
  }

  // Atomic transaction (D-20)
  return this.prisma.$transaction(async (tx) => {
    // Update main job fields (all optional per D-17)
    const updatedJob = await tx.job.update({
      where: { id: jobId },
      data: {
        title: dto.title,
        department: dto.department,
        location: dto.location,
        jobType: dto.job_type,
        status: dto.status,
        hiringManager: dto.hiring_manager,
        description: dto.description,
        responsibilities: dto.responsibilities,
        whatWeOffer: dto.what_we_offer,
        salaryRange: dto.salary_range,
        mustHaveSkills: dto.must_have_skills,
        niceToHaveSkills: dto.nice_to_have_skills,
        expYearsMin: dto.min_experience,
        expYearsMax: dto.max_experience,
        preferredOrgTypes: dto.selected_org_types,
      },
    });

    // Delete old stages, create new (D-18: omitting removes it)
    await tx.jobStage.deleteMany({ where: { jobId } });
    if (dto.hiringFlow && dto.hiringFlow.length > 0) {
      await tx.jobStage.createMany({
        data: dto.hiringFlow.map(stage => ({
          tenantId,
          jobId,
          name: stage.name,
          order: stage.order,
          interviewer: stage.interviewer || null,
          isEnabled: stage.is_enabled,
          isCustom: stage.is_custom || false,
        })),
      });
    }

    // Delete old questions, create new (D-18: omitting removes it)
    await tx.screeningQuestion.deleteMany({ where: { jobId } });
    if (dto.screeningQuestions && dto.screeningQuestions.length > 0) {
      await tx.screeningQuestion.createMany({
        data: dto.screeningQuestions.map((q, i) => ({
          tenantId,
          jobId,
          text: q.text,
          answerType: q.type,
          expectedAnswer: q.expected_answer || null,
          order: q.order ?? i + 1,
        })),
      });
    }

    // Return complete updated job for response
    return tx.job.findUnique({
      where: { id: jobId },
      include: {
        hiringStages: { orderBy: { order: 'asc' } },
        screeningQuestions: { orderBy: { order: 'asc' } },
        _count: { select: { applications: true } },
      },
    });
  });
}
```

### DELETE /jobs/:id (Soft Delete)

```typescript
// Source: Soft delete pattern + API protocol spec (D-21)

@Delete(':id')
async delete(@Param('id') jobId: string) {
  const tenantId = this.configService.get<string>('TENANT_ID')!;

  // Soft delete: set status = 'closed' (D-21)
  await this.jobsService.deleteJob(jobId, tenantId);

  // Return 204 No Content (per spec)
  return;
}

// Service
async deleteJob(jobId: string, tenantId: string) {
  // Verify exists
  const job = await this.prisma.job.findFirst({
    where: { id: jobId, tenantId },
  });
  if (!job) {
    throw new NotFoundException({
      code: 'NOT_FOUND',
      message: `Job ${jobId} not found`,
    });
  }

  // Soft delete (do NOT hard delete, do NOT add deleted_at)
  await this.prisma.job.update({
    where: { id: jobId },
    data: { status: 'closed' },
  });
}
```

### Response Transformation (Field Mapping)

```typescript
// Source: Established pattern in Phase 9 jobs.service.ts

private toJobResponse(
  job: Job & {
    hiringStages: JobStage[];
    screeningQuestions: ScreeningQuestion[];
    _count: { applications: number };
  },
): JobResponse {
  return {
    id: job.id,
    title: job.title,
    department: job.department,
    location: job.location,
    job_type: job.jobType,          // camelCase → snake_case
    status: job.status,
    hiring_manager: job.hiringManager, // camelCase → snake_case
    candidate_count: job._count.applications,
    created_at: job.createdAt,      // camelCase → snake_case
    updated_at: job.updatedAt,
    description: job.description,
    responsibilities: job.responsibilities,
    what_we_offer: job.whatWeOffer,  // camelCase → snake_case
    salary_range: job.salaryRange,
    must_have_skills: job.mustHaveSkills,
    nice_to_have_skills: job.niceToHaveSkills,
    min_experience: job.expYearsMin,
    max_experience: job.expYearsMax,
    selected_org_types: job.preferredOrgTypes,
    screening_questions: job.screeningQuestions.map((q, i) =>
      this.toScreeningQuestionResponse(q, i)
    ),
    hiring_flow: job.hiringStages.map((s, i) =>
      this.toJobStageResponse(s, i)
    ),
  };
}

private toJobStageResponse(
  stage: JobStage,
  index: number,
): JobStageResponse {
  // Color computed from order (index), NOT stored in DB per D-03
  const colors = ['bg-zinc-400', 'bg-blue-500', 'bg-indigo-400', 'bg-emerald-500'];

  return {
    id: stage.id,
    name: stage.name,
    is_enabled: stage.isEnabled,    // camelCase → snake_case
    interviewer: stage.interviewer, // Passthrough (was responsibleUserId)
    color: colors[index % colors.length], // Computed, not from DB
    is_custom: stage.isCustom,
    order: stage.order,
  };
}

private toScreeningQuestionResponse(
  question: ScreeningQuestion,
  index: number,
): ScreeningQuestionResponse {
  return {
    id: question.id,
    text: question.text,
    type: question.answerType,          // Rename: answerType → type
    expected_answer: question.expectedAnswer || null, // New field in Phase 11
    // DO NOT include: required, knockout (removed per D-05)
  };
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Hard delete (DELETE FROM jobs) | Soft delete (UPDATE jobs SET status='closed') | Phase 11 | Preserves audit trail, enables restore, simplifies data recovery |
| Separate migrations for each column | Single atomic migration (ADD → COPY → DROP) | Phase 11 | Reduces downtime, prevents orphaned data, reversible |
| Field mapping in controller | Field mapping in service response transformer | Phase 9+ | Separation of concerns, reusable across endpoints, testable |
| No transaction isolation | Explicit `prisma.$transaction()` | Phase 6+ | Prevents race conditions, ensures consistency for nested operations |

**Deprecated/outdated:**
- `responsible_user_id` column: Renamed to `interviewer` (TEXT) in Phase 11 to clarify no FK relationship exists
- `required` and `knockout` columns on ScreeningQuestion: Removed in Phase 11 as unused in MVP (can add back later without schema rewrite using CHECK constraints per CLAUDE.md)

---

## Schema Migration Details

### Migration 1: Add new JobStage columns

**File:** `prisma/migrations/[timestamp]_add_jobstage_is_enabled_interviewer/migration.sql`

```sql
-- Add is_enabled column with default true
ALTER TABLE "job_stages" ADD COLUMN "is_enabled" BOOLEAN NOT NULL DEFAULT true;

-- Backfill: all existing stages are enabled (safe default)
UPDATE "job_stages" SET "is_enabled" = true WHERE "is_enabled" IS NULL;

-- Add interviewer column (nullable, replaces responsible_user_id)
ALTER TABLE "job_stages" ADD COLUMN "interviewer" TEXT;

-- Copy old data to new column (handles existing interviews)
UPDATE "job_stages" SET "interviewer" = "responsible_user_id"
  WHERE "responsible_user_id" IS NOT NULL;

-- Drop old column (after verification)
ALTER TABLE "job_stages" DROP COLUMN "responsible_user_id";
```

### Migration 2: Update ScreeningQuestion

**File:** `prisma/migrations/[timestamp]_update_screening_questions/migration.sql`

```sql
-- Add expected_answer column (nullable, for yes_no questions)
ALTER TABLE "screening_questions" ADD COLUMN "expected_answer" VARCHAR;

-- Backfill: null for all existing questions (no data loss, not backward-compatible)
UPDATE "screening_questions" SET "expected_answer" = null;

-- Drop required and knockout columns (Phase 11 MVP simplification)
ALTER TABLE "screening_questions" DROP COLUMN "required";
ALTER TABLE "screening_questions" DROP COLUMN "knockout";
```

**Data safety:**
- Adding columns: non-blocking, safe during operation
- Copying data: single UPDATE statement, fully reversible
- Dropping columns: should be tested in staging first

---

## Validation Architecture

Test framework: **Jest 29+** (via `npm test`)
Config file: `jest.config.js` (exists in repo)
Quick run: `npm test -- src/jobs/jobs.controller.spec.ts` (< 5 seconds)
Full suite: `npm test` (all tests, ~30 seconds)

### Phase 11 Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| GET /config | Returns hardcoded response with all 6 sections | Unit | `npm test -- src/config/config.controller.spec.ts` | ❌ Wave 0 |
| GET /jobs | Returns all jobs with nested stages + questions, excludes closed jobs | Integration | `npm test -- src/jobs/jobs.integration.spec.ts` | ✅ Partial |
| POST /jobs | Creates job + stages + questions atomically, validates required fields | Integration | `npm test -- src/jobs/jobs.integration.spec.ts` | ✅ Partial |
| PUT /jobs/:id | Updates job + stages/questions atomically, returns 200 with updated job | Integration | `npm test -- src/jobs/jobs.integration.spec.ts` | ❌ Wave 0 |
| DELETE /jobs/:id | Sets status='closed' (soft delete), returns 204 | Integration | `npm test -- src/jobs/jobs.integration.spec.ts` | ❌ Wave 0 |
| Tenant isolation | All endpoints filter by tenant_id, verify x-tenant-id header | Integration | `npm test -- src/jobs/jobs.integration.spec.ts` | ❌ Wave 0 |
| Validation errors | 400 + error format for missing required fields, invalid enums | Integration | `npm test -- src/jobs/jobs.controller.spec.ts` | ✅ Partial |
| Field mapping | API response has snake_case field names, computed color, aliased type | Unit | `npm test -- src/jobs/jobs.service.spec.ts` | ❌ Wave 0 |
| Soft delete filtering | GET /jobs excludes closed jobs, DELETE returns 204 | Integration | `npm test -- src/jobs/jobs.integration.spec.ts` | ❌ Wave 0 |
| Schema migration | New columns exist with correct defaults, old columns dropped | Migration test | Custom migration test script | ❌ Wave 0 |

### Sampling Rate

- **Per task commit:** `npm test -- src/jobs/` (all job tests, ~10s)
- **Per wave merge:** `npm test` (full suite including all phases, ~30s)
- **Phase gate:** Full suite green (`npm test` exit 0) before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `src/config/config.controller.spec.ts` — Tests for GET /config hardcoded response
- [ ] `src/config/config.service.spec.ts` — Test service returns correct structure
- [ ] `src/jobs/dto/update-job.dto.ts` — UpdateJobSchema (Zod) for PUT /jobs/:id
- [ ] `src/jobs/jobs.controller.spec.ts` — Tests for PUT, DELETE routes + 204 response
- [ ] `src/jobs/jobs.service.spec.ts` — Tests for updateJob(), deleteJob(), field transformation
- [ ] `src/jobs/jobs.integration.spec.ts` — E2E tests: soft delete filtering, transaction atomicity, tenant isolation
- [ ] Migration test: Verify `is_enabled`, `interviewer`, `expected_answer` columns exist post-migration
- [ ] Response mapping tests: Verify color computed correctly, type field renamed, required/knockout hidden

**Note:** `src/jobs/jobs.controller.spec.ts` and `jobs.integration.spec.ts` exist partially from Phase 10 — will be extended in Wave 0.

---

## Environment Availability

**Skip condition:** This phase has no external CLI/service dependencies beyond NestJS stack already verified in Phase 1.

**External dependencies audit:**
- PostgreSQL: Required (exists in docker-compose)
- Redis: Required for BullMQ (exists in docker-compose)
- Node.js / npm: Required (verified in Phase 1)
- Docker: Required for dev environment

All dependencies verified in Phase 1; no new tools needed. Phase 11 is code-only (no infra setup).

---

## Open Questions

1. **Color palette commitment:** Are the Tailwind color classes in GET /config binding (must be exactly `bg-zinc-400`, `bg-blue-500`, `bg-indigo-400`, `bg-emerald-500`), or can design iterate?
   - What we know: Spec locks these exact colors
   - Recommendation: Lock for MVP, design can adjust in Phase 2+

2. **Hiring managers list:** Should hardcoded hiring_managers in GET /config match any real users, or just examples?
   - What we know: Spec shows `{ id: 'uuid', name: 'Jane Smith' }` as example
   - Recommendation: Use placeholder UUIDs + real names from team (or sample names for demo)

3. **Migration rollback strategy:** If migration fails mid-deployment, how to roll back?
   - What we know: Prisma auto-generates migration files
   - Recommendation: Test migration in staging first; rollback via previous migration if needed

---

## Sources

### Primary (HIGH confidence)
- Prisma 7 documentation: `$transaction()` callback pattern, migration safety, column renaming
- NestJS 11 documentation: Controller decorators (@Delete, @Put), exception handling (NotFoundException, BadRequestException)
- Existing codebase Phase 6+ (src/ingestion/ingestion.processor.ts): Verified transaction pattern with Prisma callback
- Existing codebase Phase 9-10 (src/jobs/jobs.service.ts, jobs.controller.ts): Response transformation pattern, Zod validation
- Spec: API_PROTOCOL_MVP.md (endpoint contracts, field names, error format)
- CONTEXT.md Phase 11: Locked decisions D-01–D-32

### Secondary (MEDIUM confidence)
- Prisma soft delete patterns (community blog posts, verified against schema.prisma index strategy)
- NestJS error handling (official docs + Phase 9 controller pattern)

---

## Metadata

**Confidence breakdown:**
- Standard stack (NestJS/Prisma): HIGH — locked in CLAUDE.md, verified in Phase 1-10
- Transactions pattern: HIGH — verified in existing Phase 6 code (ingestion.processor.ts)
- Response mapping: HIGH — established in Phase 9 (jobs.service.ts)
- Soft delete query filtering: HIGH — schema index exists, pattern standard in industry
- Field aliasing (answerType → type): HIGH — Zod + manual transformation, verified in Phase 10
- Schema migration safety: HIGH — Prisma docs + common practice (ADD → COPY → DROP)
- Error response format: HIGH — standardized in Phase 10, aligned with spec

**Research date:** 2026-03-25
**Valid until:** 2026-04-25 (30 days — NestJS/Prisma stable, no breaking changes expected)

---

## Appendix: Practical Checklist for Implementation

**Before writing code:**
- [ ] Read API_PROTOCOL_MVP.md completely
- [ ] Review Phase 11 CONTEXT.md decisions (D-01 through D-32)
- [ ] Check existing GET /jobs response in jobs.service.ts (Phase 9 pattern)

**Schema migration order:**
- [ ] CREATE: Add is_enabled, interviewer, expected_answer columns
- [ ] BACKFILL: Copy responsible_user_id → interviewer, set is_enabled = true
- [ ] VALIDATE: Check counts match, data integrity OK
- [ ] DROP: Remove responsible_user_id, required, knockout columns

**Endpoint implementation order:**
- [ ] GET /config (hardcoded, no queries)
- [ ] GET /jobs (reuse Phase 9 pattern, add nested stages/questions)
- [ ] POST /jobs (use existing + transaction + add new fields)
- [ ] PUT /jobs/:id (new endpoint, transaction, nested delete + create)
- [ ] DELETE /jobs/:id (new endpoint, soft delete, return 204)

**Response mapping verification:**
- [ ] Test: API response has snake_case field names (job_type, not jobType)
- [ ] Test: Color is computed from order (not stored in DB)
- [ ] Test: type field renamed from answerType
- [ ] Test: expected_answer field exists, nullable
- [ ] Test: required, knockout fields NOT in response
- [ ] Test: interviewer field exists (was responsible_user_id)

**Tenant isolation verification:**
- [ ] Test: GET /jobs only returns tenant's jobs
- [ ] Test: POST /jobs creates with tenantId from ConfigService
- [ ] Test: PUT /jobs/:id rejects if job not in tenant
- [ ] Test: DELETE /jobs/:id rejects if job not in tenant
- [ ] Test: Multiple tenants don't cross-contaminate

**Soft delete verification:**
- [ ] Test: DELETE /jobs/:id returns 204, no body
- [ ] Test: GET /jobs does NOT return closed jobs
- [ ] Test: Closed jobs still exist in DB (SELECT * WHERE status='closed')
- [ ] Test: Scoring loop doesn't process closed jobs (SCOR-01 query filters status)
