# Phase 12: Manual Candidate Addition via UI - Research

**Researched:** 2026-03-26
**Domain:** NestJS multipart file uploads, Prisma atomic transactions, API response formatting, tenant isolation, file validation
**Confidence:** HIGH

## Summary

Phase 12 adds two endpoints to support manual candidate creation from the recruiter UI:
1. **POST /candidates** — Create candidate + application atomically with optional CV file upload
2. **GET /jobs/list** — Lightweight endpoint for job selector dropdown

The codebase has established patterns for all required components: StorageService (Cloudflare R2 integration), CandidatesService (snake_case response format), Prisma transactions (atomic operations), and error handling (NestJS exceptions). The primary gap is multipart/form-data handling (FileInterceptor), which is not currently used in the codebase but is a standard NestJS pattern. File validation, tenant isolation, and transaction error handling are proven patterns from Phases 5–11.

**Primary recommendation:** Use @nestjs/platform-express FileInterceptor for multipart handling, validate files server-side by MIME type, reuse StorageService.upload() pattern, and apply Prisma transaction pattern from Phase 11 POST /jobs.

## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Manual candidates skip pg_trgm duplicate detection (recruitment deliberate, no auto-merge)
- **D-02:** CV file upload to R2 at `cvs/{tenantId}/{candidateId}`, store public URL in `cv_file_url`, leave `cv_text = null` for manual adds
- **D-03:** POST /candidates response uses snake_case field names (consistent with existing API)
- **D-04:** Manual candidates always start at application `stage = "new"`
- **D-05:** POST /candidates must atomically create Candidate + Application records or fail entirely
- **D-06:** GET /jobs/list returns only `status = "open"` jobs with minimal fields `{id, title, department}`

### Claude's Discretion
- Exact Cloudflare R2 key generation strategy (path structure)
- File type validation strictness (MIME type vs extension check)
- Response field ordering in POST /candidates response
- Exact error messages and error response format
- Email validation regex or library choice

### Deferred Ideas (OUT OF SCOPE)
- Email uniqueness per-job vs tenant-wide (currently enforced tenant-wide)
- Async CV file parsing (currently cv_text stays null)
- Advanced file validation (magic bytes / content inspection)
- GET /jobs/list pagination or filtering
- Bulk candidate import
- Duplicate detection toggle for manual adds

---

## Standard Stack

### Core Libraries
| Library | Version | Purpose | Installed |
|---------|---------|---------|-----------|
| NestJS | 11 | Framework core, HTTP handling | ✓ |
| @nestjs/platform-express | 11+ | FileInterceptor, multipart middleware | ✓ |
| Prisma | 7 | ORM, atomic transactions | ✓ |
| PostgreSQL | 16 | Persistent data store | ✓ |
| @aws-sdk/client-s3 | (current) | Cloudflare R2 S3-compatible uploads | ✓ |
| Zod | 4+ | Request validation schemas | ✓ |

### File Handling Dependencies
| Library | Purpose | Availability |
|---------|---------|--------------|
| @nestjs/platform-express::FileInterceptor | Multipart/form-data parsing, file extraction | Standard in @nestjs/platform-express, no install needed |
| multer | Underlying middleware for FileInterceptor | Auto-installed with @nestjs/platform-express |

**No additional packages required** — all dependencies already installed.

---

## Architecture Patterns

### Pattern 1: Multipart File Upload with Additional JSON Fields

**What:** Combine file upload (multipart/form-data) with structured JSON data in a single request using FileInterceptor + @Body().

**When to use:** POST endpoints that accept both files and form fields.

**Implementation pattern:**
```typescript
// Source: NestJS platform-express documentation
import { FileInterceptor } from '@nestjs/platform-express';
import { UseInterceptors, UploadedFile, Body } from '@nestjs/common';

@Post('candidates')
@UseInterceptors(FileInterceptor('cv_file'))  // field name from multipart form
async create(
  @UploadedFile() file: Express.Multer.File | undefined,  // optional
  @Body() body: CreateCandidateDto,  // parsed JSON fields
) {
  // file.buffer contains uploaded data
  // file.mimetype contains MIME type
  // body contains parsed JSON fields from form
}
```

**Key points:**
- FileInterceptor argument ('cv_file') must match the form field name in multipart request
- File is optional in our case (endpoint supports JSON-only POST for candidates without CVs)
- @Body() receives form fields automatically parsed by multer
- file.buffer is the raw bytes (use this with StorageService.upload())
- file.mimetype is MIME type string from client (validate server-side)

### Pattern 2: Atomic Transaction with File Upload

**What:** Ensure file is uploaded AND database records created succeed together, or fail entirely.

**When to use:** Multi-step operations where a partial failure corrupts state (e.g., file uploaded but DB insert failed).

**Implementation pattern:**
```typescript
// Source: Phase 11 POST /jobs pattern + Phase 5 file upload logic
async create(file: Express.Multer.File | undefined, dto: CreateCandidateDto) {
  const tenantId = this.configService.get<string>('TENANT_ID')!;

  // Step 1: Validate job exists in tenant BEFORE transaction (read-only)
  const job = await this.prisma.job.findUnique({
    where: { id_tenantId: { id: dto.job_id, tenantId } },
  });
  if (!job) throw new NotFoundException({ code: 'NOT_FOUND' });

  // Step 2: Validate email uniqueness BEFORE transaction (read-only)
  if (dto.email) {
    const existing = await this.prisma.candidate.findFirst({
      where: { tenantId, email: dto.email },
      select: { id: true },
    });
    if (existing) throw new ConflictException({ code: 'EMAIL_EXISTS' });
  }

  // Step 3: Upload file BEFORE transaction (external service, failures = 400)
  let cvFileUrl: string | null = null;
  if (file) {
    // Validate MIME type
    if (!['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(file.mimetype)) {
      throw new BadRequestException({ code: 'INVALID_FILE_TYPE' });
    }
    cvFileUrl = await this.storageService.uploadFromBuffer(
      file.buffer,
      file.mimetype,
      tenantId,
      candidateId,  // Note: candidateId doesn't exist yet — use temp ID or generate here
    );
  }

  // Step 4: Atomic transaction — Candidate + Application or nothing
  return this.prisma.$transaction(async (tx) => {
    const candidate = await tx.candidate.create({
      data: {
        tenantId,
        fullName: dto.full_name,
        email: dto.email ?? null,
        phone: dto.phone ?? null,
        currentRole: dto.current_role ?? null,
        location: dto.location ?? null,
        yearsExperience: dto.years_experience ?? null,
        skills: dto.skills ?? [],
        cvText: null,  // D-02: null for manual adds
        cvFileUrl,     // populated from Step 3
        source: dto.source,
        sourceAgency: dto.source_agency ?? null,
        sourceEmail: null,  // D-02: null for manual adds
        aiSummary: dto.ai_summary ?? null,
        metadata: null,  // D-02: null for manual adds
      },
    });

    const application = await tx.application.create({
      data: {
        tenantId,
        candidateId: candidate.id,
        jobId: dto.job_id,
        stage: 'new',  // D-04
        appliedAt: new Date(),
      },
    });

    return { candidate, application };
  });
}
```

**Key points:**
- Validations (job exists, email unique, file valid) happen OUTSIDE transaction
- These pre-checks prevent unnecessary lock contention and immediate failure
- File upload happens OUTSIDE transaction (R2 is external, transaction doesn't control it)
- Candidate + Application created atomically INSIDE transaction
- If either INSERT fails, transaction rolls back (application never created, candidate rolled back)
- P2002 (UNIQUE constraint violation) will not occur for email because pre-check validates

### Pattern 3: File Validation (MIME Type + Extension)

**What:** Server-side validation of uploaded files before accepting.

**When to use:** All file upload endpoints.

**Implementation pattern:**
```typescript
// Source: Phase 5 StorageService.selectLargestCvAttachment pattern
const ACCEPTED_MIME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;

const ACCEPTED_EXTENSIONS = ['.pdf', '.doc', '.docx'] as const;

// Validate MIME type (primary check)
if (!ACCEPTED_MIME_TYPES.includes(file.mimetype)) {
  throw new BadRequestException({
    error: {
      code: 'INVALID_FILE_TYPE',
      message: `File type ${file.mimetype} not supported. Accepted: PDF, DOC, DOCX`,
    },
  });
}

// Optional: Also check file extension from originalname (secondary check)
const ext = Path.extname(file.originalname).toLowerCase();
if (!ACCEPTED_EXTENSIONS.includes(ext)) {
  throw new BadRequestException({
    error: {
      code: 'INVALID_FILE_TYPE',
      message: `File extension ${ext} not supported. Use .pdf, .doc, or .docx`,
    },
  });
}
```

**Key points:**
- MIME type from file.mimetype (set by multer from Content-Type header)
- Extension from file.originalname (filename from client)
- Server-side validation prevents malicious uploads
- Phase 5 StorageService validates MIME type only — this pattern extends it

### Pattern 4: Tenant Isolation in Endpoints

**What:** Ensure all operations are scoped to the request's tenant, preventing cross-tenant data leaks.

**When to use:** All endpoints.

**Implementation pattern:**
```typescript
// Source: CandidatesService.findAll, JobsService.findAll pattern
async findAll(): Promise<any> {
  const tenantId = this.configService.get<string>('TENANT_ID')!;  // Resolved once per request

  const jobs = await this.prisma.job.findMany({
    where: { tenantId },  // Always filter by tenantId
    // ... other query conditions
  });

  return jobs;
}
```

**Key points:**
- TenantId comes from ConfigService (loaded at request bootstrap)
- NEVER trust tenantId from request body or query params
- ALL database queries must include `where: { tenantId }`
- Prevents accidental cross-tenant queries

### Pattern 5: Snake_case Response Format

**What:** Convert database camelCase field names to snake_case in API responses for UI consistency.

**When to use:** All response DTOs.

**Implementation pattern:**
```typescript
// Source: CandidatesService.findAll, ApplicationsService.findAll pattern
const candidates = await this.prisma.candidate.findMany({
  // camelCase from Prisma
  select: {
    id: true,
    fullName: true,
    email: true,
    cvFileUrl: true,
    createdAt: true,
    // ...
  },
});

// Map to snake_case for API response
return {
  candidates: candidates.map((c) => ({
    id: c.id,
    full_name: c.fullName,
    email: c.email,
    cv_file_url: c.cvFileUrl,
    created_at: c.createdAt,
    // ...
  })),
};
```

**Key points:**
- Database schema uses camelCase (Prisma ORM convention)
- API responses use snake_case (REST API convention)
- All existing endpoints (GET /candidates, GET /jobs) follow this pattern
- POST /candidates response MUST follow same pattern

### Pattern 6: Error Response Format

**What:** Standardized error response format across all endpoints.

**When to use:** All error conditions.

**Implementation pattern:**
```typescript
// Source: JobsController error handling pattern
// 400 Bad Request (validation error)
throw new BadRequestException({
  error: {
    code: 'VALIDATION_ERROR',
    message: 'Validation failed',
    details: fieldErrors,  // { fieldName: ['error message'] }
  },
});

// 404 Not Found
throw new NotFoundException({
  error: {
    code: 'NOT_FOUND',
    message: 'Job not found',
  },
});

// 409 Conflict (constraint violation)
throw new ConflictException({
  error: {
    code: 'EMAIL_EXISTS',
    message: 'A candidate with this email already exists',
  },
});
```

**Key points:**
- All errors follow `{ error: { code, message, details? } }` structure
- NestJS exceptions (BadRequestException, NotFoundException, ConflictException) auto-set HTTP status
- code field is machine-readable, message is human-readable
- details field includes field-level errors for validation failures

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| File upload handling | Custom multipart parser | @nestjs/platform-express FileInterceptor + multer | Battle-tested, handles edge cases (size limits, MIME parsing, memory management) |
| Request validation | String regex matching | Zod schema (existing pattern) | Type-safe, composable, matches existing codebase |
| Atomic multi-table inserts | Manual transaction with error recovery | Prisma $transaction() | Automatic rollback on any failure, cleaner API |
| Cloudflare R2 upload | Custom S3 client setup | Existing StorageService | Already tested, credentials configured, integration patterns established |
| Email validation | Custom regex | Zod .email() or simple string check | Zod available, matches decision D-discretion |
| Tenant isolation | Per-endpoint conditionals | ConfigService.get('TENANT_ID') once per request | Single source of truth, prevents accidental cross-tenant queries |

**Key insight:** The codebase has solved all these problems in previous phases. Reusing existing patterns (Zod, Prisma transactions, StorageService, snake_case mapping) keeps code consistent and leverages proven solutions.

---

## Runtime State Inventory

**Not applicable for greenfield endpoint implementation.** No existing candidate creation endpoint to rename or migrate. Phase 12 introduces entirely new API surface.

---

## Common Pitfalls

### Pitfall 1: File Upload Outside Transaction

**What goes wrong:** File successfully uploads to R2, but database INSERT fails (job doesn't exist, email conflict). File is orphaned in R2 with no candidate record referencing it.

**Why it happens:** Developers try to upload file inside Prisma transaction, but external services (R2) should not be part of DB transactions.

**How to avoid:**
- Validate job exists and email is unique BEFORE transaction (read-only queries)
- Upload file to R2 BEFORE transaction
- Create candidate + application INSIDE transaction only
- If transaction fails after file upload, file remains orphaned (acceptable; cleanup is separate phase)

**Warning signs:** Transaction errors mentioning timeout or "cannot await external service inside transaction"

### Pitfall 2: Email Validation Missing or Incorrect MIME Type

**What goes wrong:** Endpoint accepts malformed emails (no @ symbol) or `.exe` files disguised as `.pdf`.

**Why it happens:** Developers skip server-side validation, assume client-side checks or MIME type from Content-Type header is sufficient.

**How to avoid:**
- Always validate email format server-side (Zod .email() or simple regex)
- Always validate MIME type server-side (check file.mimetype against whitelist)
- Do NOT trust Content-Type header alone — validate file extension in originalname
- Phase 5 pattern: filter by MIME type, extend it

**Warning signs:** Accepting file extensions not in spec, empty email rejection message

### Pitfall 3: File Upload Error Not Caught Before Transaction

**What goes wrong:** If file is invalid or R2 upload fails, endpoint throws error, but transaction has already started. Inconsistent error response.

**How to avoid:**
- Validate file type (MIME + extension) before transaction
- Call storageService.upload() before transaction
- Let file upload errors propagate as 400 (file validation) or 500 (R2 failure)
- This matches Phase 5 pattern: "Transient R2 errors propagate to BullMQ for automatic retry"

**Warning signs:** Transaction errors mentioning file upload, partial state after 5xx errors

### Pitfall 4: Forgotten tenantId in Database Query

**What goes wrong:** Query returns candidates from OTHER tenants, cross-tenant data leak.

**Why it happens:** Developer copy-pastes query from another service, forgets to add `where: { tenantId }`.

**How to avoid:**
- EVERY Prisma query must include `where: { tenantId }`
- Extract tenantId once at start of service method
- Use ConfigService pattern (established in all existing services)
- Code review checklist: "Does every where clause include tenantId?"

**Warning signs:** Endpoint returns more candidates than expected, tenant_id appearing in WHERE clause multiple times

### Pitfall 5: Missing P2002 Constraint Violation Handling

**What goes wrong:** Email already exists, database returns P2002 (UNIQUE constraint violation), endpoint returns cryptic database error instead of 409 Conflict.

**Why it happens:** Developers rely on pre-validation but don't handle race conditions (two requests create same email concurrently).

**How to avoid:**
- Pre-validate email uniqueness before transaction (catches most cases)
- If using transaction, still catch P2002 from database (seen in webhooks.service.ts)
- Return 409 ConflictException on P2002, not 500 InternalServerErrorException
- But in Phase 12, pre-validation check prevents P2002 entirely — only throw 409 from pre-check

**Warning signs:** P2002 errors in logs, 500 status code for duplicate emails

### Pitfall 6: fileStorage Key Generation Using Candidate ID Before Creation

**What goes wrong:** Code tries to generate R2 key using candidateId (e.g., `cvs/{tenantId}/{candidateId}`), but candidate doesn't exist yet. Need to create candidate first, then use its ID.

**Why it happens:** Phase 5 pattern uses `cvs/{tenantId}/{messageId}` (email already has messageId). Manual upload needs candidateId.

**How to avoid:**
- Option A: Generate temporary ID (UUID v4) before create, use in key, then create candidate with that ID
- Option B: Create candidate first (without file), get back candidateId, then upload file, update candidate
- Option C: Use a temporary key (e.g., `cvs/{tenantId}/temp-{uuid}`), rename after candidate creation
- Recommend Option A (simplest): Generate UUID, use in key, create candidate with that UUID

**Warning signs:** Candidate creation succeeds but R2 key refers to non-existent candidate ID

---

## Code Examples

Verified patterns from existing codebase:

### Example 1: File Validation Pattern (MIME Type + Extension)

```typescript
// Source: src/storage/storage.service.ts lines 6-9, 74-80
const CV_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;

// In your service method:
if (!CV_MIME_TYPES.includes(file.mimetype)) {
  throw new BadRequestException({
    error: {
      code: 'INVALID_FILE_TYPE',
      message: `File type not supported`,
    },
  });
}
```

### Example 2: Atomic Transaction Pattern (Candidate + Application)

```typescript
// Source: src/jobs/jobs.service.ts lines 68-98 (POST /jobs pattern)
return this.prisma.$transaction(async (tx) => {
  const candidate = await tx.candidate.create({
    data: {
      tenantId,
      fullName: dto.full_name,
      email: dto.email ?? null,
      cvFileUrl,
      source: dto.source,
      // ... other fields
    },
  });

  const application = await tx.application.create({
    data: {
      tenantId,
      candidateId: candidate.id,
      jobId: dto.job_id,
      stage: 'new',
    },
  });

  return { candidate, application };
});
```

### Example 3: Tenant Isolation Pattern

```typescript
// Source: src/candidates/candidates.service.ts lines 29-36, src/jobs/jobs.service.ts lines 24-34
async create(dto: CreateCandidateDto): Promise<any> {
  const tenantId = this.configService.get<string>('TENANT_ID')!;

  // Every query includes tenantId
  const job = await this.prisma.job.findUnique({
    where: { id_tenantId: { id: dto.job_id, tenantId } },
  });

  if (!job) {
    throw new NotFoundException({ code: 'NOT_FOUND' });
  }
}
```

### Example 4: Snake_case Response Mapping

```typescript
// Source: src/candidates/candidates.service.ts lines 94-113
const result: CandidateResponse[] = candidates.map((c) => ({
  id: c.id,
  full_name: c.fullName,
  email: c.email,
  phone: c.phone,
  current_role: c.currentRole,
  location: c.location,
  cv_file_url: c.cvFileUrl,
  source: c.source,
  created_at: c.createdAt,
  skills: c.skills,
}));

return { candidates: result };
```

### Example 5: Error Response Format

```typescript
// Source: src/jobs/jobs.controller.ts lines 28-40
throw new BadRequestException({
  error: {
    code: 'VALIDATION_ERROR',
    message: 'Validation failed',
    details: fieldErrors,  // { fieldName: ['error message'] }
  },
});
```

### Example 6: FileInterceptor Pattern for Multipart Upload

```typescript
// Source: NestJS platform-express documentation
import { FileInterceptor } from '@nestjs/platform-express';
import { UseInterceptors, UploadedFile, Body, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { CreateCandidateDto } from './dto/create-candidate.dto';

@Post('candidates')
@UseInterceptors(FileInterceptor('cv_file'))  // Match multipart field name
async create(
  @UploadedFile() file: Express.Multer.File | undefined,
  @Body() dto: CreateCandidateDto,
) {
  // file is undefined if no file uploaded
  // file.buffer contains bytes
  // file.mimetype contains MIME type
  // dto contains parsed form fields
}
```

---

## Database Constraints

### UNIQUE Email Constraint (tenant_id, email)

**Location:** `prisma/migrations/20260322110817_init/migration.sql` lines 181-182

```sql
CREATE UNIQUE INDEX idx_candidates_email
  ON candidates (tenant_id, email) WHERE email IS NOT NULL;
```

**Effect:**
- Only one candidate per tenant can have a given email
- NULL emails are allowed (multiple candidates can have NULL email)
- If POST /candidates receives an email that already exists for this tenant, database will reject with P2002

**Handling in Phase 12:**
- Pre-check query: find if candidate exists with same email BEFORE transaction
- If found, throw 409 ConflictException immediately
- This prevents database P2002 error from being visible to client
- Pattern: See webhooks.service.ts lines 68-75 for P2002 handling

### Application UNIQUE Constraint (tenant_id, candidate_id, job_id)

**Location:** `prisma/schema.prisma` lines 117

```
@@unique([tenantId, candidateId, jobId], name: "idx_applications_unique")
```

**Effect:**
- Only one application per candidate per job per tenant
- If you try to create second Application with same candidate+job+tenant, database rejects with P2002

**Handling in Phase 12:**
- Two scenarios:
  1. If POST /candidates creates new candidate: application is guaranteed unique (candidate is new)
  2. If somehow reusing existing candidate (out of scope): check beforehand

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Jest + Supertest |
| Config file | jest.config.js |
| Quick run command | `npm test -- --testPathPattern="candidates" --testNamePattern="POST" -x` |
| Full suite command | `npm test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CAND-02 | POST /candidates rejects duplicate email with 409 | unit + integration | `npm test -- candidates.service.spec.ts -t "email"` | ❌ Wave 0 |
| (new) | POST /candidates creates Candidate + Application atomically | integration | `npm test -- candidates.integration.spec.ts -t "atomic"` | ❌ Wave 0 |
| (new) | POST /candidates rejects invalid file type with 400 | unit | `npm test -- candidates.service.spec.ts -t "file.*type"` | ❌ Wave 0 |
| (new) | POST /candidates requires job_id to exist in tenant (404 if missing) | integration | `npm test -- candidates.integration.spec.ts -t "job.*not.*found"` | ❌ Wave 0 |
| (new) | GET /jobs/list returns only open jobs with required fields | unit | `npm test -- jobs.service.spec.ts -t "jobs.*list"` | ❌ Wave 0 |
| (new) | POST /candidates response includes application_id | integration | `npm test -- candidates.integration.spec.ts -t "response.*application"` | ❌ Wave 0 |

### Wave 0 Gaps
- [ ] `tests/candidates.integration.spec.ts` — covers POST /candidates, GET /jobs/list, atomic transaction, tenant isolation
- [ ] `src/candidates/dto/create-candidate.dto.ts` — Zod schema with email, years_experience, skills, source validation
- [ ] `src/candidates/candidates.service.ts` — createCandidate() method with file upload and transaction logic
- [ ] `src/candidates/candidates.controller.ts` — POST /candidates route with FileInterceptor, GET /jobs/list route
- [ ] Framework install: No new packages required (FileInterceptor built-in to @nestjs/platform-express)

---

## Integration Points

### Existing Services to Reuse

**1. StorageService** (`src/storage/storage.service.ts`)
- **Current use:** Upload Postmark attachments to R2, return object key
- **For Phase 12:** Need new method to upload file from Express.Multer.File.buffer
  - Current signature: `upload(attachments: PostmarkAttachmentDto[], tenantId, messageId)`
  - Needed: `uploadFromBuffer(buffer, mimetype, tenantId, candidateId)` or adapt existing method
  - Alternative: Extend upload() to handle both Postmark attachments and raw buffers
- **Key pattern:** Returns object key (not presigned URL), credentials already configured

**2. CandidatesService** (`src/candidates/candidates.service.ts`)
- **Current use:** GET /candidates with filtering
- **For Phase 12:** Add createCandidate() method with file handling and atomic transaction
- **Key pattern:** snake_case response mapping, tenant isolation, PrismaService injection

**3. JobsService** (`src/jobs/jobs.service.ts`)
- **Current use:** GET /jobs, POST /jobs, PUT /jobs, DELETE /jobs
- **For Phase 12:** Add getOpenJobs() method for GET /jobs/list, reuse findAll() with status filter
- **Key pattern:** Atomic transactions, tenant isolation, snake_case response

**4. PrismaService** (`src/prisma/prisma.service.ts`)
- **Current use:** Database client, transaction management
- **For Phase 12:** Use prisma.$transaction() for Candidate + Application atomic creation
- **Key pattern:** Pattern established in Phase 11 POST /jobs

**5. CandidatesController** (`src/candidates/candidates.controller.ts`)
- **Current use:** GET /candidates route
- **For Phase 12:** Add POST /candidates route with FileInterceptor, add GET /jobs/list route
- **Key pattern:** Error handling with BadRequestException, NotFoundException, ConflictException

### Module Imports
- **CandidatesModule:** Already exists, add POST route
- **StorageModule:** Already imported in IngestionModule (Phase 5), need to import in CandidatesModule
- **PrismaModule:** Global module (already available)
- **ConfigModule:** Already available (ConfigService injected)

### Prisma Models Used
- **Candidate:** create with 13 fields (all nullable except id, tenantId, fullName, source)
- **Application:** create with 5 fields (id, tenantId, candidateId, jobId, stage="new")
- **Job:** query to validate exists (findUnique by id + tenantId)

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Manual file uploads using raw multer | @UseInterceptors(FileInterceptor()) in NestJS | NestJS 3.0+ | Cleaner decorator-based API, less boilerplate |
| Separate file + data uploads (POST file, then POST data) | Multipart form-data single request | HTTP standards (RFC 7578) | Single atomic request, simpler UI, consistency |
| Full CV text parsing for all candidates | cv_text = null for manual adds (Phase 12 decision D-02) | Phase 12 onward | Recognizes manual adds are intentional, saves AI processing |

**Deprecated/outdated:**
- Raw multer middleware (superseded by NestJS interceptors)
- pg_trgm dedup for manual adds (Phase 12 D-01: skipped entirely)
- Bulk file upload endpoints (not in MVP scope)

---

## Open Questions

1. **R2 Key Generation Strategy**
   - What we know: Phase 5 uses `cvs/{tenantId}/{messageId}.{ext}`, Phase 12 needs `cvs/{tenantId}/{candidateId}.{ext}`
   - What's unclear: Do we generate UUID before candidate creation, or create candidate first and update key after?
   - Recommendation: Generate UUID v4 before candidate creation, use in R2 key, create candidate with that ID (simplest, no race condition)

2. **Response Field Ordering**
   - What we know: spec lists fields in specific order, existing responses don't strictly follow order
   - What's unclear: Is field order critical for frontend, or can planner reorder for readability?
   - Recommendation: Follow spec order exactly; use test to verify field presence and types, ignore order

3. **Email Format Validation**
   - What we know: spec says "must be valid email format if provided"
   - What's unclear: Simple regex (contains @), or full RFC 5322 validation?
   - Recommendation: Use Zod .email() (handles most cases, fails on edge cases, matches project pattern)

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | TypeScript compilation, runtime | ✓ | 20+ (from .nvmrc) | — |
| PostgreSQL | Database (candidate + application storage) | ✓ | 16 (docker-compose) | — |
| Redis | BullMQ queue (not used in POST /candidates) | ✓ | 7 (docker-compose) | — |
| Cloudflare R2 Account | File upload (cv_file) | ✓ | (external) | Skip file upload, test with null cv_file_url |
| npm | Package management | ✓ | 10+ | — |

**Missing dependencies with no fallback:** None. All external services (R2) can be tested with mock/stub in unit tests.

---

## Sources

### Primary (HIGH confidence)
- **NestJS platform-express documentation** - FileInterceptor usage, @UploadedFile() decorator, multipart/form-data handling
- **Existing codebase** (`src/storage/storage.service.ts`, Phase 5) - File validation pattern, StorageService S3 client setup, MIME type validation
- **Existing codebase** (`src/jobs/jobs.service.ts`, Phase 11) - Prisma $transaction() pattern for atomic operations, snake_case response mapping
- **Existing codebase** (`src/candidates/candidates.service.ts`, Phase 9) - Tenant isolation pattern, ConfigService tenantId resolution
- **Prisma schema** (`prisma/schema.prisma`) - Candidate + Application model structure, field names, constraints
- **Database migration** (`prisma/migrations/20260322110817_init/migration.sql`) - UNIQUE email constraint structure

### Secondary (MEDIUM confidence)
- [NestJS File Upload Documentation](https://docs.nestjs.com/techniques/file-upload) - General FileInterceptor patterns
- [Express Multer Middleware](https://github.com/expressjs/multer) - FileInterceptor underlying implementation, file.buffer / file.mimetype
- [RFC 7578 - multipart/form-data](https://tools.ietf.org/html/rfc7578) - Standard for combining files and data in single request

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — All libraries already installed, patterns proven in existing code
- File upload pattern: MEDIUM-HIGH — NestJS FileInterceptor is standard, but no existing implementation in codebase to reference
- Atomic transactions: HIGH — Phase 11 established Prisma $transaction() pattern
- Validation & error handling: HIGH — JobsController shows exact error format and exception types
- Tenant isolation: HIGH — Pattern consistent across all existing services
- Database constraints: HIGH — Migration file confirms UNIQUE email, Application constraints

**Research date:** 2026-03-26
**Valid until:** 2026-04-02 (7 days — NestJS stable, patterns mature)
