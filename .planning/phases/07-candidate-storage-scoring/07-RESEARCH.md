# Phase 7: Candidate Storage & Scoring - Research

**Researched:** 2026-03-23
**Domain:** NestJS service module creation, Prisma upsert/update/create patterns, Vercel AI SDK generateObject with Zod schema
**Confidence:** HIGH

## Summary

Phase 7 is the terminal step of the ingestion pipeline: it enriches the candidate shell created in Phase 6 with all AI-extracted fields, upserts application rows for every active job, and scores each candidate-job pair with Claude Sonnet (mocked in this phase, real call scaffolded). The implementation is a pure code addition — no new migrations, no new infrastructure, no new npm packages. Every DB model and index already exists from Phase 1.

The work is well-defined by prior phases. Phase 4 established the mock-first pattern for AI services. Phase 6 established the NestJS module-per-concern pattern and the Prisma transaction idiom. Phase 7 creates one new module (`ScoringModule`), one new service (`ScoringAgentService`), and extends `IngestionProcessor.process()` at the existing Phase 7 stub comment (line 184/155 in the current file after Phase 6 splice-in at line 154).

The schema is fully confirmed: `candidates`, `applications`, `candidate_job_scores` models match the required output fields exactly. No migration is needed. The UNIQUE partial index for `(tenant_id, email) WHERE email IS NOT NULL` is the only constraint that requires raw SQL — Prisma does not natively support partial indexes; this must be added as a raw migration statement and verified.

**Primary recommendation:** Follow the established DedupModule/DedupService pattern for ScoringModule/ScoringAgentService. Use `prisma.candidate.update()` for enrichment (not upsert), `prisma.application.upsert()` for idempotent application creation, and `prisma.candidateJobScore.create()` (never upsert) for append-only scores.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** Phase 7 issues a targeted `candidate.update()` on the `candidateId` from Phase 6 — writes all enrichment fields: `currentRole`, `yearsExperience`, `skills`, `cvText`, `cvFileUrl`, `aiSummary`, `metadata`. No re-insert; update only.
- **D-02:** `cvText` comes from `context.cvText` (plain text extracted in Phase 3). `cvFileUrl` is derived from `context.fileKey` (Phase 5). Both are already on `ProcessingContext` — no re-extraction needed.
- **D-03:** `aiSummary` is the 2-sentence summary field from `CandidateExtractSchema.summary`. `metadata` JSONB is left `null` in Phase 7 (no metadata use case yet).
- **D-04:** `ExtractionAgentService.extract()` remains a deterministic mock in Phase 7. The real Anthropic `generateObject()` call stays commented out and scaffold-ready — same pattern established in Phase 4. Activation is deferred until LLM credentials are available.
- **D-05:** No changes to `CandidateExtractSchema` — schema is already correct and matches all fields to be stored.
- **D-06:** New `ScoringAgentService` in a new `ScoringModule` — follows the same module-per-concern pattern as `StorageModule` and `DedupModule`. Lives at `src/scoring/scoring.service.ts` (and `.module.ts`).
- **D-07:** Scoring input (when real Anthropic call is activated): full `cvText` + all structured candidate fields + job `title`, `description`, `requirements[]`. This gives Sonnet the most complete signal. Currently scaffolded as mock — the interface is defined now so activation is a one-line swap.
- **D-08:** Scoring output Zod schema: `{ score: z.number().int().min(0).max(100), reasoning: z.string(), strengths: z.array(z.string()), gaps: z.array(z.string()) }`. Maps directly to `candidate_job_scores` columns.
- **D-09:** `ScoringAgentService.score()` is a deterministic mock in Phase 7 (same pattern as extraction) — returns hardcoded score with real call commented out and ready.
- **D-10:** `model_used` field records the literal model string (e.g., `claude-sonnet-4-6`) — hardcoded in the mock, passed from `generateObject` result when real call activates.
- **D-11:** Fetch all active jobs: `prisma.job.findMany({ where: { tenantId, status: 'active' } })`. If no active jobs, skip scoring loop entirely — candidate is still stored and `processingStatus` is set to `completed`.
- **D-12:** For each active job: upsert `applications` row first (`stage = 'new'`), then call `scoringService.score()`. The upsert uses the UNIQUE constraint `(tenant_id, candidate_id, job_id)` — idempotent on BullMQ retry.
- **D-13:** Score result is INSERT-only into `candidate_job_scores` — never upsert, never update. `applicationId` links the score to the application row. This preserves full score history across retries.
- **D-14:** If `scoringService.score()` throws for any job, the entire Phase 7 throws — BullMQ retries the full job (up to 3x, exponential backoff). This is consistent with how extraction failure is handled in Phase 4. Safe because: applications upsert is idempotent, candidate enrichment UPDATE is idempotent, score INSERTs are append-only (retry creates duplicate rows on the same `applicationId` — acceptable for Phase 1).
- **D-15:** No try/catch around scoring loop — errors propagate directly to BullMQ worker.
- **D-16:** `email_intake_log.processingStatus` is set to `'completed'` after all Phase 7 work succeeds — single terminal status regardless of whether scoring ran (active jobs may be 0). Consistent with Phase 1 scope where the recruiter UI doesn't read this field yet.

### Claude's Discretion

- Module file structure inside `src/scoring/` (service, module, spec file naming)
- Scoring prompt wording when real call activates
- How `metadata` JSONB is populated in future phases
- Whether to add a `location` field extraction (field exists in schema but not in CandidateExtractSchema)

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| CAND-01 | `candidates` table stores AI-extracted fields plus `cv_text`, `cv_file_url`, `source`, `source_email`, `source_agency`, `metadata` JSONB | Prisma schema confirmed: all columns exist. Phase 7 fills them via `candidate.update()` using `context.candidateId` from Phase 6 |
| CAND-02 | `candidates` table has UNIQUE index on `(tenant_id, email) WHERE email IS NOT NULL` | Prisma schema comment at line 78 confirms intent but NO `@@unique` directive — requires raw SQL partial index in migration. Must verify migration contains this index. |
| CAND-03 | `email_intake_log.candidate_id` is set after successful candidate creation | Already implemented in Phase 6 transaction (`tx.emailIntakeLog.update` with `candidateId`). Phase 7 confirms status with `processingStatus: 'completed'` update. |
| SCOR-01 | Scoring processor fetches all active jobs for the tenant (`WHERE status = 'active'`) | `prisma.job.findMany({ where: { tenantId, status: 'active' } })` — `Job` model has `status String @default("draft")` and `@@index([tenantId, status])` already created |
| SCOR-02 | Scoring processor upserts an `applications` row (`stage = 'new'`) for each candidate-job pair before scoring — idempotent on retry | `Application` model has `@@unique([tenantId, candidateId, jobId], name: "idx_applications_unique")` — upsert on this constraint is the correct pattern |
| SCOR-03 | Agent 2 (claude-sonnet-4-6) scores candidate against each active job; returns `score` (0–100), `reasoning`, `strengths[]`, `gaps[]` | `ScoringAgentService` with Zod schema D-08 — mock now, real `generateObject()` call commented-ready |
| SCOR-04 | Score result inserted append-only into `candidate_job_scores` — existing scores never updated | `prisma.candidateJobScore.create()` — no upsert. `CandidateJobScore` model has no unique constraint on `(applicationId)` so repeated INSERTs on retry are accepted |
| SCOR-05 | `candidate_job_scores` records the `model_used` string | `CandidateJobScore.modelUsed String @map("model_used")` column confirmed in schema |
</phase_requirements>

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@prisma/client` | ^7.0.0 (installed) | DB operations: `candidate.update`, `application.upsert`, `job.findMany`, `candidateJobScore.create` | Locked project ORM |
| `zod` | ^4.3.6 (installed) | Scoring output schema validation (`ScoreSchema`) | Already used for extraction schema — consistent pattern |
| `ai` (Vercel AI SDK) | ^6.0.134 (installed) | `generateObject()` for scoring — commented out, ready to activate | Locked project AI SDK |
| `@ai-sdk/anthropic` | ^3.0.63 (installed) | Anthropic provider for `generateObject()` | Locked project AI provider |
| `@nestjs/common` | ^11.0.1 (installed) | `@Injectable()`, `@Module()` decorators | Locked project framework |

No new packages required. All dependencies are already installed.

**Installation:** None needed.

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@nestjs/testing` | ^11.0.1 (installed) | `Test.createTestingModule()` for unit tests | Phase 7 spec files |

## Architecture Patterns

### Recommended Project Structure

```
src/
├── scoring/
│   ├── scoring.module.ts       # @Module({ providers: [ScoringAgentService], exports: [ScoringAgentService] })
│   ├── scoring.service.ts      # ScoringAgentService with score() mock + commented real call
│   └── scoring.service.spec.ts # Unit tests for ScoringAgentService
├── ingestion/
│   ├── ingestion.module.ts     # Import ScoringModule (add alongside DedupModule)
│   └── ingestion.processor.ts  # Replace Phase 7 stub at line 155 with enrichment + scoring logic
```

### Pattern 1: New NestJS Module (DedupModule → ScoringModule)

**What:** Create `ScoringModule` with `ScoringAgentService`, export the service, import in `IngestionModule`.

**When to use:** Any new concern requiring injection into `IngestionProcessor`.

**Example (from `src/dedup/dedup.module.ts`):**
```typescript
import { Module } from '@nestjs/common';
import { ScoringAgentService } from './scoring.service';

@Module({
  providers: [ScoringAgentService],
  exports: [ScoringAgentService],
})
export class ScoringModule {}
```

Module import in `IngestionModule` (follows line 8 pattern in `ingestion.module.ts`):
```typescript
import { ScoringModule } from '../scoring/scoring.module';
// ...
imports: [BullModule.registerQueue({ name: 'ingest-email' }), StorageModule, DedupModule, ScoringModule],
```

Constructor injection in `IngestionProcessor` (follows existing pattern):
```typescript
constructor(
  // ... existing services ...
  private readonly scoringService: ScoringAgentService,
) { super(); }
```

### Pattern 2: Mock-First AI Service (ExtractionAgentService → ScoringAgentService)

**What:** Define the real Anthropic call as a commented-out block inside a try-comment envelope. Ship a deterministic mock return. Activation = swap the comment.

**When to use:** Any AI service before LLM credentials are available in the deployment environment.

**Example (mirroring `extraction-agent.service.ts`):**
```typescript
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

export const ScoreSchema = z.object({
  score: z.number().int().min(0).max(100),
  reasoning: z.string(),
  strengths: z.array(z.string()),
  gaps: z.array(z.string()),
});
export type ScoreResult = z.infer<typeof ScoreSchema>;

export interface ScoringInput {
  cvText: string;
  candidateFields: { currentRole: string | null; yearsExperience: number | null; skills: string[] };
  job: { title: string; description: string | null; requirements: string[] };
}

@Injectable()
export class ScoringAgentService {
  async score(input: ScoringInput): Promise<ScoreResult & { modelUsed: string }> {
    // TODO: replace mock with real Anthropic call
    // const { object } = await generateObject({
    //   model: anthropic('claude-sonnet-4-6'),
    //   schema: ScoreSchema,
    //   prompt: `Score this candidate against the job...\n\nCV: ${input.cvText}\nJob: ${input.job.title}`,
    // });
    // return { ...object, modelUsed: 'claude-sonnet-4-6' };

    void input; // used by real implementation
    return {
      score: 72,
      reasoning: 'Strong TypeScript background matches the role requirements.',
      strengths: ['TypeScript', 'Node.js'],
      gaps: ['No PostgreSQL mentioned'],
      modelUsed: 'claude-sonnet-4-6',
    };
  }
}
```

### Pattern 3: Prisma application.upsert with Named Unique Constraint

**What:** Upsert an `applications` row using the named unique constraint `idx_applications_unique` on `(tenantId, candidateId, jobId)`.

**When to use:** Creating applications idempotently — safe on BullMQ retry.

**Example:**
```typescript
const application = await this.prisma.application.upsert({
  where: {
    idx_applications_unique: { tenantId, candidateId: context.candidateId, jobId: job.id },
  },
  create: { tenantId, candidateId: context.candidateId, jobId: job.id, stage: 'new' },
  update: {}, // No-op on retry — idempotent
  select: { id: true },
});
```

### Pattern 4: Append-Only Score INSERT

**What:** `candidateJobScore.create()` — no upsert, no update. Repeated INSERTs on retry are accepted (no unique constraint on `applicationId`).

**Example:**
```typescript
await this.prisma.candidateJobScore.create({
  data: {
    tenantId,
    applicationId: application.id,
    score: scoreResult.score,
    reasoning: scoreResult.reasoning,
    strengths: scoreResult.strengths,
    gaps: scoreResult.gaps,
    modelUsed: scoreResult.modelUsed,
  },
});
```

### Pattern 5: Phase 7 Processor Splice

**What:** The Phase 7 stub comment is at line 155 of `ingestion.processor.ts` (after Phase 6 transaction completion). Append Phase 7 code below the `this.logger.log('Phase 6 complete...')` line.

**Phase 7 execution order inside `process()`:**
1. `candidate.update()` — enrich with all extracted + file fields
2. `job.findMany({ where: { tenantId, status: 'active' } })` — fetch active jobs
3. If no active jobs → skip loop, go to step 6
4. For each active job: `application.upsert()` → `scoringService.score()` → `candidateJobScore.create()`
5. Errors propagate (no try/catch) — BullMQ retries
6. `emailIntakeLog.update({ processingStatus: 'completed' })` — terminal status

### Anti-Patterns to Avoid

- **Using `candidate.upsert()` for enrichment:** Phase 7 must use `candidate.update()` — the shell already exists from Phase 6. An upsert would be wrong semantics and could bypass the dedup logic.
- **Using `candidateJobScore.upsert()`:** There is no unique constraint on scores. Even if one were added, the design decision is append-only for score history. Use `create()`.
- **Wrapping the scoring loop in a prisma.$transaction:** The scoring loop is long-running (one Anthropic call per job). Prisma transactions have a connection timeout (~5s by default). Keep the loop outside transactions; individual writes are individually idempotent.
- **Catching errors from `scoringService.score()`:** D-15 — no try/catch. Errors must propagate to BullMQ for retry.
- **Updating `processingStatus` to `'completed'` before scoring finishes:** The final status update must be the last operation after the loop completes successfully.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Idempotent application creation | Custom SELECT + INSERT + conflict handling | `prisma.application.upsert()` on `idx_applications_unique` | Named unique constraint makes this a one-liner; Prisma handles P2002 |
| AI output validation | Manual JSON parsing + field checks | `z.object()` schema passed to `generateObject()` | Vercel AI SDK + Zod validates and types the output automatically |
| Score data mapping | Manual column assignment | Destructure `ScoreResult` into `candidateJobScore.create({ data })` | Direct schema alignment — no mapping layer needed |
| Retry safety | Custom deduplication logic | DB constraints + idempotent write patterns | UNIQUE on applications, no-unique on scores — the schema IS the retry strategy |

**Key insight:** Every retry-safety concern is handled by DB constraints and idempotent write semantics. The application code should not add its own deduplication layer on top.

## Common Pitfalls

### Pitfall 1: CAND-02 Partial Index May Not Exist

**What goes wrong:** CAND-02 requires a partial UNIQUE index `(tenant_id, email) WHERE email IS NOT NULL`. Prisma does not support partial indexes via the schema DSL — they must be added as raw SQL in a migration file. If Phase 1 migration did not include this raw SQL block, the constraint does not exist at the DB level, and duplicate emails per tenant are silently permitted.

**Why it happens:** Prisma's `@@unique` directive does not accept a `WHERE` clause. The schema comment at line 78 says "enforced via raw SQL index" but does not guarantee the migration was written correctly.

**How to avoid:** Before implementing Phase 7, verify the migration SQL contains `CREATE UNIQUE INDEX ... WHERE email IS NOT NULL`. Check the latest migration file in `prisma/migrations/`.

**Warning signs:** No `WHERE email IS NOT NULL` clause in any migration SQL file → CAND-02 is not implemented and needs a new migration.

### Pitfall 2: `cvFileUrl` Construction from `fileKey`

**What goes wrong:** `context.fileKey` is the R2 object key (e.g., `cvs/tenant-id/msg-id.pdf`), not a full URL. `candidates.cvFileUrl` is documented as a URL. If Phase 7 stores the raw key as the URL, the field is semantically incorrect.

**Why it happens:** `fileKey` is set by `StorageService.upload()` which returns the S3 key, not the public URL. The R2 URL format is `https://<account-id>.r2.cloudflarestorage.com/<bucket>/<key>` or a custom domain.

**How to avoid:** For Phase 7 (mock mode), storing `fileKey` directly as `cvFileUrl` is acceptable as a placeholder since no UI reads this field. When real R2 is activated, a `StorageService.getUrl(fileKey)` helper should construct the full URL. The CONTEXT.md decision D-02 says "derived from `context.fileKey`" — treat this as "use `context.fileKey` directly for now."

**Warning signs:** If `cvFileUrl` is expected to be a clickable URL before real R2 activation, this will be a broken link. Low risk for Phase 1.

### Pitfall 3: Transaction Scope for Scoring Loop

**What goes wrong:** Wrapping the entire `for...of jobs` loop in `this.prisma.$transaction()` will hit Prisma's interactive transaction timeout (default 5 seconds) if there are multiple jobs and the scoring mock (or real call) is slow.

**Why it happens:** Each `scoringService.score()` call will eventually be an Anthropic API call (~1–3s each). With 5 active jobs, the transaction would take 5–15 seconds — far exceeding the default timeout.

**How to avoid:** Keep `application.upsert()` and `candidateJobScore.create()` as individual, non-transactional writes. Each is individually idempotent. No transaction needed.

**Warning signs:** `PrismaClientKnownRequestError: Transaction API error: Transaction already closed` or similar timeout errors.

### Pitfall 4: IngestionProcessor Constructor Parameter Order

**What goes wrong:** NestJS DI requires `IngestionProcessor`'s constructor to list `ScoringAgentService` in the parameter list. Forgetting to add it means `this.scoringService` is `undefined` at runtime with no compile-time error if typed with `!`.

**Why it happens:** TypeScript constructor injection with NestJS requires the parameter declared in both constructor signature AND the module's `providers` import chain.

**How to avoid:** Add `private readonly scoringService: ScoringAgentService` to `IngestionProcessor`'s constructor, AND import `ScoringModule` in `IngestionModule`. Both changes are required.

**Warning signs:** `Cannot read properties of undefined (reading 'score')` at runtime — `ScoringAgentService` not injected.

### Pitfall 5: Duplicate Score Rows on Retry

**What goes wrong:** Per D-13, score INSERTs are append-only — retries will create additional score rows for the same `applicationId`. This is documented as acceptable for Phase 1. If a future phase adds a unique constraint on `(applicationId)`, existing duplicate rows will block the migration.

**Why it happens:** BullMQ retries re-run the full `process()` function. `application.upsert()` is idempotent (returns existing ID), so `candidateJobScore.create()` is called again with the same `applicationId`.

**How to avoid:** Acceptable in Phase 1 by explicit design decision. Flag for Phase 2: if score idempotency matters, add a `scoringRunId` (UUID, set once per processor invocation) and make scores unique on `(applicationId, scoringRunId)`.

**Warning signs:** `candidate_job_scores` has multiple rows with the same `applicationId` — expected behavior, not a bug.

## Code Examples

### Candidate Enrichment Update (D-01, CAND-01)

```typescript
// Source: Prisma schema — candidates model (prisma/schema.prisma lines 51-80)
await this.prisma.candidate.update({
  where: { id: context.candidateId },
  data: {
    currentRole: extraction.currentRole ?? null,
    yearsExperience: extraction.yearsExperience ?? null,
    skills: extraction.skills ?? [],
    cvText: context.cvText,
    cvFileUrl: context.fileKey,    // R2 object key used as URL placeholder in Phase 1
    aiSummary: extraction.summary ?? null,
    metadata: null,                // D-03: deferred to future phase
  },
});
```

### Active Jobs Fetch (SCOR-01)

```typescript
// Source: Job model — @@index([tenantId, status]) (prisma/schema.prisma line 47)
const activeJobs = await this.prisma.job.findMany({
  where: { tenantId, status: 'active' },
  select: { id: true, title: true, description: true, requirements: true },
});
// D-11: if no active jobs, skip loop and proceed to processingStatus update
```

### Application Upsert (SCOR-02)

```typescript
// Source: Application model — @@unique([tenantId, candidateId, jobId], name: "idx_applications_unique")
// (prisma/schema.prisma line 102)
const application = await this.prisma.application.upsert({
  where: {
    idx_applications_unique: {
      tenantId,
      candidateId: context.candidateId,
      jobId: job.id,
    },
  },
  create: { tenantId, candidateId: context.candidateId, jobId: job.id, stage: 'new' },
  update: {},
  select: { id: true },
});
```

### Score Insert (SCOR-03, SCOR-04, SCOR-05)

```typescript
// Source: CandidateJobScore model (prisma/schema.prisma lines 109-126)
// No unique constraint on applicationId — append-only by design (D-13)
await this.prisma.candidateJobScore.create({
  data: {
    tenantId,
    applicationId: application.id,
    score: scoreResult.score,
    reasoning: scoreResult.reasoning,
    strengths: scoreResult.strengths,
    gaps: scoreResult.gaps,
    modelUsed: scoreResult.modelUsed,
  },
});
```

### Final Status Update (D-16)

```typescript
await this.prisma.emailIntakeLog.update({
  where: { idx_intake_message_id: { tenantId, messageId: payload.MessageID } },
  data: { processingStatus: 'completed' },
});
```

### Test Module Setup (following ingestion.processor.spec.ts pattern)

```typescript
// Phase 7 tests extend the existing describe block patterns in ingestion.processor.spec.ts
// Add a new describe('IngestionProcessor — Phase 7', ...) block
// Mock ScoringAgentService:
const scoringService = {
  score: jest.fn().mockResolvedValue({
    score: 72,
    reasoning: 'Good match.',
    strengths: ['TypeScript'],
    gaps: [],
    modelUsed: 'claude-sonnet-4-6',
  }),
};
// Add to prisma mock:
// prisma.candidate = { update: jest.fn().mockResolvedValue({}) }
// prisma.job = { findMany: jest.fn().mockResolvedValue([{ id: 'job-id', title: 'SWE', description: null, requirements: [] }]) }
// prisma.application = { upsert: jest.fn().mockResolvedValue({ id: 'app-id' }) }
// prisma.candidateJobScore = { create: jest.fn().mockResolvedValue({}) }
```

## Runtime State Inventory

> This is a greenfield feature addition (new service + processor extension). No renaming or migration of existing state. Section: N/A — no runtime state concerns for this phase.

| Category | Items Found | Action Required |
|----------|-------------|-----------------|
| Stored data | No existing `candidate_job_scores` or `applications` rows to migrate | None |
| Live service config | No external services reference scoring module | None |
| OS-registered state | None | None |
| Secrets/env vars | `ANTHROPIC_API_KEY` already in `.env.example` (INFR-05 pending) — used by scoring when activated | Code only — no new env var needed |
| Build artifacts | None | None |

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| PostgreSQL | Prisma DB writes | Confirmed via prior phases | 16-alpine (Docker) | — |
| Redis | BullMQ queue | Confirmed via prior phases | 7-alpine (Docker) | — |
| Node.js | NestJS runtime | Confirmed (jest runs) | 22.x | — |
| `@ai-sdk/anthropic` | ScoringAgentService real call | Installed | ^3.0.63 | Mock (Phase 7 ships mock, real call deferred) |
| `ANTHROPIC_API_KEY` | Real scoring call | Not verified (may not be set) | — | Mock — no key needed for Phase 7 |

**Missing dependencies with no fallback:** None.

**Missing dependencies with fallback:**
- `ANTHROPIC_API_KEY`: Real Anthropic call is commented out in Phase 7 — key not required for this phase.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Jest 30 + ts-jest 29 |
| Config file | Inline in `package.json` (`"jest"` key) |
| Quick run command | `npx jest src/scoring/scoring.service.spec.ts --no-coverage` |
| Full suite command | `npx jest` |

**Current baseline:** 86 tests passing, 12 suites (verified 2026-03-23).

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CAND-01 | `candidate.update()` called with all enrichment fields | unit (processor integration) | `npx jest src/ingestion/ingestion.processor.spec.ts` | Existing file — new describe block |
| CAND-02 | Partial UNIQUE index exists in migration SQL | migration verification | `npx jest` (no automated check — manual verify migration SQL) | Manual |
| CAND-03 | `email_intake_log.candidate_id` already set by Phase 6 | unit (covered by 6-02-01) | `npx jest src/ingestion/ingestion.processor.spec.ts` | Existing — no new test needed |
| SCOR-01 | `job.findMany({ where: { status: 'active' } })` called | unit (processor integration) | `npx jest src/ingestion/ingestion.processor.spec.ts` | Existing file — new describe block |
| SCOR-01 | No active jobs → loop skipped, status still `completed` | unit (processor integration) | `npx jest src/ingestion/ingestion.processor.spec.ts` | Existing file — new test case |
| SCOR-02 | `application.upsert()` called per active job | unit (processor integration) | `npx jest src/ingestion/ingestion.processor.spec.ts` | Existing file — new test case |
| SCOR-03 | `scoringService.score()` called with correct input | unit (scoring service) | `npx jest src/scoring/scoring.service.spec.ts` | Wave 0 gap |
| SCOR-03 | `scoringService.score()` returns valid ScoreResult shape | unit (scoring service) | `npx jest src/scoring/scoring.service.spec.ts` | Wave 0 gap |
| SCOR-04 | `candidateJobScore.create()` called (not upsert) | unit (processor integration) | `npx jest src/ingestion/ingestion.processor.spec.ts` | Existing file — new test case |
| SCOR-05 | `modelUsed` value in score create call | unit (processor integration) | `npx jest src/ingestion/ingestion.processor.spec.ts` | Existing file — new test case |
| D-16 | `processingStatus: 'completed'` set after all Phase 7 work | unit (processor integration) | `npx jest src/ingestion/ingestion.processor.spec.ts` | Existing file — new test case |
| D-14 | Scoring failure propagates (no catch) — BullMQ retries | unit (processor integration) | `npx jest src/ingestion/ingestion.processor.spec.ts` | Existing file — new test case |

### Sampling Rate

- **Per task commit:** `npx jest src/scoring/scoring.service.spec.ts src/ingestion/ingestion.processor.spec.ts --no-coverage`
- **Per wave merge:** `npx jest`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `src/scoring/scoring.service.spec.ts` — covers SCOR-03 (ScoringAgentService unit tests)
- [ ] `src/scoring/scoring.module.ts` — module scaffold
- [ ] `src/scoring/scoring.service.ts` — service stub with mock

*(Existing `src/ingestion/ingestion.processor.spec.ts` covers all processor integration tests for CAND-01, SCOR-01, SCOR-02, SCOR-04, SCOR-05, D-16, D-14 via new describe block)*

## Open Questions

1. **CAND-02 partial index existence in migration**
   - What we know: Prisma schema comment says "enforced via raw SQL index" but no `@@unique` with WHERE clause in schema DSL
   - What's unclear: Whether the Phase 1 migration SQL file actually contains `CREATE UNIQUE INDEX ... WHERE email IS NOT NULL`
   - Recommendation: Wave 0 task should check `prisma/migrations/` SQL files for this index. If absent, add a new migration before Phase 7 enrichment.

2. **`cvFileUrl` as full URL vs. R2 key**
   - What we know: `context.fileKey` is an R2 object key (e.g., `cvs/tenant-id/msg-id.pdf`), not a full URL. D-02 says "derived from `context.fileKey`."
   - What's unclear: Whether the plan should store the key directly or construct a URL. No recruiter UI reads this in Phase 1.
   - Recommendation: Store `context.fileKey` directly. Document that a URL construction helper is needed before Phase 2 UI activation.

## Sources

### Primary (HIGH confidence)

- `prisma/schema.prisma` — all model fields, constraints, and indexes verified directly from source
- `src/ingestion/ingestion.processor.ts` — current processor state, Phase 7 stub location, `ProcessingContext` interface
- `src/ingestion/services/extraction-agent.service.ts` — mock-first pattern to replicate for `ScoringAgentService`
- `src/dedup/dedup.module.ts` + `src/dedup/dedup.service.ts` — module/service boilerplate pattern
- `src/ingestion/ingestion.module.ts` — import location for `ScoringModule`
- `src/ingestion/ingestion.processor.spec.ts` — test structure and mock patterns
- `package.json` — confirmed installed versions of all dependencies

### Secondary (MEDIUM confidence)

- Vercel AI SDK `generateObject()` pattern inferred from commented-out code in `extraction-agent.service.ts` — consistent with package.json `ai` ^6.0.134

### Tertiary (LOW confidence)

None — all claims sourced from project code directly.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all packages verified from `package.json`, no new dependencies
- Architecture: HIGH — all patterns directly sourced from existing project code
- Pitfalls: HIGH — derived from reading actual schema, existing code paths, and documented Phase 6 decisions
- Test map: HIGH — test file names and patterns confirmed from directory listing

**Research date:** 2026-03-23
**Valid until:** Stable — no external library evolution affects this phase. Valid until Phase 7 implementation completes.
