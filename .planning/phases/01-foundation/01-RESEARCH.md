# Phase 1: Foundation - Research

**Researched:** 2026-03-22
**Domain:** NestJS 11 database schema + infrastructure bootstrap
**Confidence:** HIGH

## Summary

Phase 1 establishes the automated email intake pipeline's structural skeleton: database schema with 7 multi-tenant tables, NestJS API with rawBody HMAC verification, separate BullMQ Worker process for CPU-heavy tasks, environment validation at startup via @nestjs/config + Zod, and Docker Compose orchestration of all 4 services locally (API, Worker, PostgreSQL, Redis).

This phase contains zero business logic — only infrastructure patterns proven across NestJS + Prisma + BullMQ applications. The architecture supports all 7 phases without rewrite: modular NestJS structure (webhooks → ingestion → scoring modules), append-only scoring table, fuzzy dedup via pg_trgm, and tenant_id on every table from day 1.

**Primary recommendation:** Follow the approved architecture spec (`spec/backend-architecture-proposal.md`) verbatim — the schema, docker-compose, and project structure are locked decisions. Install all Phase 1–7 dependencies upfront in one `npm install` run (D-01) to avoid repeated dependency churn.

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Install ALL project dependencies upfront in Phase 1 — do not defer AI/parsing/storage libs to later phases. Production: `@prisma/client`, `prisma`, `@nestjs/config`, `zod`, `bullmq`, `ioredis`, `ai`, `@ai-sdk/anthropic`, `pdf-parse`, `mammoth`, `@aws-sdk/client-s3`. Dev: `@types/pdf-parse`.
- **D-02:** Delete the NestJS scaffold entirely — remove `src/app.controller.ts`, `src/app.service.ts`, `src/app.controller.spec.ts`. `AppModule` becomes a clean slate.
- **D-03:** `prisma/seed.ts` pre-populates: 1 tenant (`name: 'Triolla'`, `id: '00000000-0000-0000-0000-000000000001'`) and 1 active job (`title: 'Software Engineer'`, `status: 'active'`). Idempotent via `upsert`.
- **D-04:** `TENANT_ID` in `.env.example` pre-filled with `00000000-0000-0000-0000-000000000001`.
- **D-05:** Single `docker-compose.yml` (no dev/prod split). Both `api` and `worker` use same `Dockerfile`; worker overrides `command: node dist/worker.js`.
- **D-06:** Add health checks to postgres and redis services so `api` and `worker` won't start until dependencies are ready (`depends_on` with `condition: service_healthy`).

### Claude's Discretion
- Dockerfile design (multi-stage vs single-stage — prefer multi-stage for smaller prod image)
- Exact Zod env schema shape (URL validation for DATABASE_URL/REDIS_URL, non-empty string for API keys)
- AppModule structure (which built-in NestJS modules to import: ConfigModule.forRoot, etc.)

### Deferred Ideas (OUT OF SCOPE)
- Docker Compose dev/prod split (docker-compose.override.yml for hot reload) — not needed in Phase 1, add when CI/CD is set up
- Health check HTTP endpoint on the API (`/health`) — Phase 2 or later
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| **DB-01** | 7 tables created via Prisma migration: `tenants`, `jobs`, `candidates`, `applications`, `candidate_job_scores`, `duplicate_flags`, `email_intake_log` | Schema defined in `spec/backend-architecture-proposal.md` §9; Prisma 6 migration tooling verified; pg_trgm indexes documented |
| **DB-02** | Every table carries `tenant_id` FK → `tenants.id` from day 1 — no schema rewrite required for multi-tenancy | Architecture approved; schema includes tenant_id on all 7 tables per spec §9 |
| **DB-03** | Status/type columns use `text` + CHECK constraints (not PostgreSQL ENUMs) — adding values requires no migration | Enum migration burden documented; CHECK constraint pattern standard in Prisma |
| **DB-04** | `updated_at` maintained by Prisma `@updatedAt` directive, not DB triggers | Prisma 6 @updatedAt standard pattern; no custom trigger needed |
| **DB-05** | No binary blobs stored in database — original files go to R2, only URL stored | Architecture spec §9 & §5 clarify: cv_text → PostgreSQL, original file → R2, url → cv_file_url |
| **DB-06** | `applications` has UNIQUE constraint `(tenant_id, candidate_id, job_id)` | Schema spec defines UNIQUE index at §9 |
| **DB-07** | `duplicate_flags` has UNIQUE constraint `(tenant_id, candidate_id, matched_candidate_id)` — prevents duplicate flags on worker retries | Unique constraint listed in schema; idempotency pattern verified |
| **DB-08** | `email_intake_log` has UNIQUE constraint `(tenant_id, message_id)` — primary idempotency guard | Schema spec §9; idempotency pattern critical for webhook retries |
| **DB-09** | All required indexes created in migration (active jobs, application stage, score lookup, unreviewed duplicates, intake status) | Indexes documented in spec §9 (line 700–730): pg_trgm GIN indexes, UNIQUE email per tenant, active jobs index, etc. |
| **INFR-01** | `main.ts` bootstraps NestJS with `rawBody: true` for HMAC signature verification | NestJS standard pattern; rawBody required for Postmark HMAC validation (spec §6, step 1) |
| **INFR-02** | `worker.ts` bootstraps BullMQ worker with no HTTP layer | NestJS separate worker process pattern confirmed via WebSearch: Standalone BullMQ worker approach idiomatic in NestJS ecosystem |
| **INFR-03** | Environment variables validated at startup via `@nestjs/config` + Zod — application fails fast on missing config | WebSearch confirms standard pattern: @nestjs/config ConfigModule with Zod validation schema, type inference via z.infer |
| **INFR-04** | Docker Compose defines: `api`, `worker`, `postgres` (16-alpine), `redis` (7-alpine) services | Architecture spec §10 defines docker-compose.yml; D-06 adds health checks to postgres/redis |
| **INFR-05** | `.env.example` documents all required environment variables | 10 env vars defined in spec §10: DATABASE_URL, REDIS_URL, ANTHROPIC_API_KEY, POSTMARK_WEBHOOK_TOKEN, TENANT_ID, R2_* (4), NODE_ENV |
| **PROC-01** | API and Worker run as separate Docker containers — CPU-heavy processing cannot block webhook receipt | Architecture spec §3 & §6 (step 2) establishes pattern; docker-compose defines two services; separate entry points (main.ts vs worker.ts) |

</phase_requirements>

---

## Standard Stack

### Core Framework & ORM

| Library | Version | Purpose | Why Standard | Install |
|---------|---------|---------|--------------|---------|
| **NestJS** | 11.0.1 | TypeScript-first framework, modular architecture, built-in dependency injection | TypeScript-native, structured for growth, proven with 500+ CVs/month scale. Scaffold already initialized. | ✓ (already installed) |
| **@nestjs/core** | 11.0.1 | NestJS runtime kernel | Paired dependency with @nestjs/common | ✓ (already installed) |
| **@nestjs/common** | 11.0.1 | Decorators (Controller, Module, Inject, etc.) | Idiomatic NestJS | ✓ (already installed) |
| **@nestjs/platform-express** | 11.0.1 | HTTP server (Express adapter) | Default NestJS HTTP transport | ✓ (already installed) |
| **@nestjs/config** | ^11.0.0+ | Environment variable management + Zod integration | WebSearch confirms standard pattern for env validation; enables fail-fast startup | ⚠️ **NOT installed** — add in D-01 |
| **Prisma** | 6 | Schema-first ORM, type-safe queries, migration tooling | Standard for NestJS + PostgreSQL; schema is single source of truth; Prisma 6 uses CommonJS by default (no ESM conflict with NestJS) | ⚠️ `@prisma/client` + `prisma` — add in D-01 |
| **PostgreSQL** | 16-alpine | Relational database; pg_trgm for fuzzy matching | Proven at scale; `pg_trgm` extension eliminates need for vector DB or Elasticsearch | ✓ (docker image) |
| **Redis** | 7-alpine | In-memory store for BullMQ job queue | Standard with BullMQ; ephemeral (data loss acceptable) | ✓ (docker image) |

### Queue & Job Processing

| Library | Version | Purpose | Why Standard | Install |
|---------|---------|---------|--------------|---------|
| **BullMQ** | ^5.x (latest) | Job queue with retry logic, concurrency control, worker scaling | Industry standard NestJS queue; built-in persistence via Redis; no message broker setup needed | ⚠️ add in D-01 |
| **ioredis** | ^5.x | Redis client for BullMQ | BullMQ's recommended Redis driver; connection pooling | ⚠️ add in D-01 |

### Environment Validation

| Library | Version | Purpose | Why Standard | Install |
|---------|---------|---------|--------------|---------|
| **Zod** | ^3.x | Schema validation with full TypeScript support | WebSearch confirms standard for @nestjs/config integration; type-safe env vars via z.infer; better than class-validator (unmaintained) | ⚠️ add in D-01 |

### AI & Structured Output

| Library | Version | Purpose | Why Standard | Install |
|---------|---------|---------|--------------|---------|
| **ai** (Vercel AI SDK) | ^0.4.x | Unified interface for LLM calls, structured outputs via generateObject + Zod | Allows one-line model swap (Claude → Ollama → OpenAI); generateObject + Zod pattern removes parsing bugs | ⚠️ add in D-01 |
| **@ai-sdk/anthropic** | ^1.x | Anthropic provider for Vercel AI SDK (Claude models) | WebSearch confirms Claude Haiku 4.5 & Sonnet 4.6 available; cost ~$6–16/month for 500 CVs/month | ⚠️ add in D-01 |

### File Parsing

| Library | Version | Purpose | Why Standard | Install |
|---------|---------|---------|--------------|---------|
| **pdf-parse** | ^1.1.x | Extract plain text from PDF CVs | Standard Node.js PDF parser; lightweight; pdf-lib is for manipulation (not needed) | ⚠️ add in D-01 |
| **mammoth** | ^1.4.x | Convert DOCX to plain text | Standard for DOCX parsing; outputs markdown-like text (suitable for LLM input) | ⚠️ add in D-01 |

### Cloud Storage

| Library | Version | Purpose | Why Standard | Install |
|---------|---------|---------|--------------|---------|
| **@aws-sdk/client-s3** | ^3.x | S3-compatible API client; used for Cloudflare R2 uploads | R2 is S3-compatible; AWS SDK is industry standard; no R2-specific SDK needed | ⚠️ add in D-01 |
| **Cloudflare R2** | (service) | Object storage with no egress fees; stores original CVs (PDF/DOCX) | 10GB free tier; no charge for downloads (unlike S3); cost ~$0.015/GB beyond free tier | ✓ (external service) |

### Development Dependencies

| Library | Version | Purpose | Why Standard | Install |
|---------|---------|---------|--------------|---------|
| **@types/pdf-parse** | ^1.x | TypeScript types for pdf-parse | Type safety for pdf-parse API | ⚠️ add in D-01 (dev only) |
| **@types/express** | ^5.x | Express type definitions | Already installed; needed for rawBody middleware typing | ✓ (already installed) |
| **@types/node** | ^22.x | Node.js type definitions | Already installed | ✓ (already installed) |
| **jest** | ^30.x | Testing framework (pre-configured) | Already installed; Phase 1 Wave 0 may add test stubs | ✓ (already installed) |
| **@nestjs/testing** | ^11.x | NestJS test utilities (pre-configured) | Already installed | ✓ (already installed) |

**Installation command (D-01):**
```bash
npm install @nestjs/config zod bullmq ioredis ai @ai-sdk/anthropic pdf-parse mammoth @aws-sdk/client-s3 && \
npm install --save-dev @types/pdf-parse
```

Then run `npm ci` to lock the new dependencies into `package-lock.json` so all future `docker build` runs get the same versions.

### Alternatives Considered

| Standard | Alternative | Tradeoff | When Alternative Makes Sense |
|----------|-------------|----------|------------------------------|
| Prisma 6 + pg_trgm | Vector DB (Pinecone, Weaviate, Qdrant) + vector embeddings | Vector dedup is more accurate but requires API calls (~$50–200/month), adds infra complexity, and isn't needed at 500 CVs/month. pg_trgm is free and scales locally. | Only if fuzzy matching accuracy drops below 70% or scale grows to 100k+ candidates |
| BullMQ + Redis | NestJS-native Job Scheduler | Scheduler runs in same process as HTTP server and will block webhook receipt on CPU-heavy jobs. Defeats purpose of separation. | Only if you want to avoid Redis entirely (not viable for Phase 1) |
| @nestjs/config + Zod | class-validator + class-transformer | class-validator package is unmaintained (no updates for 2+ years). Zod is actively maintained and produces smaller bundles. | Never — class-validator is a dead dependency. Use Zod. |
| Cloudflare R2 | AWS S3 | R2 has zero egress fees; S3 charges $0.09/GB. At 500 CVs/month (~500MB), R2 saves ~$45/month. R2 is S3-compatible, so switching is trivial. | Only if you need S3-specific features (versioning, replication) or are already in AWS ecosystem |
| Vercel AI SDK | Direct Anthropic SDK | Vercel AI SDK enables model swaps (Claude → Ollama) in one-line code change; direct SDK locks you in. | Never — indirect SDK cost is zero, flexibility is huge |

---

## Architecture Patterns

### Recommended Project Structure

From `spec/backend-architecture-proposal.md` §5 (locked in CONTEXT.md):

```
src/
├── app.module.ts                  # Root NestJS module (imports all domain modules)
├── main.ts                        # Entry point — HTTP server (rawBody: true)
├── worker.ts                      # Entry point — BullMQ worker (no HTTP)
│
├── webhooks/                      # HTTP layer — receives Postmark payloads
│   ├── webhooks.module.ts
│   ├── webhooks.controller.ts     # POST /webhooks/email
│   ├── webhooks.service.ts        # Signature verification + enqueue
│   └── dto/
│       └── postmark-payload.dto.ts
│
├── ingestion/                     # BullMQ worker: email → candidate
│   ├── ingestion.module.ts
│   ├── ingestion.processor.ts     # @Processor('ingest-email')
│   └── attachment-extractor.ts    # pdf-parse + mammoth
│
├── scoring/                       # BullMQ worker: candidate → scores
│   ├── scoring.module.ts
│   └── scoring.processor.ts       # @Processor('score-candidate')
│
├── agents/                        # AI calls (Vercel AI SDK)
│   ├── agents.module.ts
│   ├── email-parser.agent.ts      # Haiku + Zod schema → CandidateExtract
│   └── job-scorer.agent.ts        # Sonnet + Zod schema → ScoringResult
│
├── dedup/                         # Duplicate detection
│   ├── dedup.module.ts
│   └── dedup.service.ts           # pg_trgm queries via Prisma $queryRaw
│
├── storage/                       # Cloudflare R2 file uploads
│   ├── storage.module.ts
│   └── storage.service.ts         # upload(buffer, key) → url
│
├── candidates/                    # Candidate DB operations
│   ├── candidates.module.ts
│   └── candidates.repository.ts
│
├── jobs/                          # Job DB operations
│   ├── jobs.module.ts
│   └── jobs.repository.ts
│
└── common/
    ├── filters/                   # Global exception filter
    └── interceptors/              # Logging
```

**Why this structure:** NestJS is module-based. Each folder is a self-contained module with its own controllers, services, and DTOs. This prevents spaghetti code and makes the codebase predictable as it grows — a new developer knows exactly where to find dedup logic (dedup/), AI calls (agents/), etc.

---

### Pattern 1: Separate API + Worker Entry Points

**What:** Two `main.ts` files (or one main.ts + one worker.ts) that bootstrap different NestJS applications with different concerns.

**When to use:** Whenever you have CPU-heavy background jobs that could block HTTP endpoints. Phase 1 has PDF parsing, AI extraction, and file uploads in the worker — these must never block webhook receipt.

**Example:**

```typescript
// src/main.ts — HTTP server ONLY
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true })
  await app.listen(process.env.PORT ?? 3000)
}
bootstrap()
```

```typescript
// src/worker.ts — BullMQ WORKER ONLY (no HTTP)
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule)
  await app.init()
  // Worker stays alive; NestJS app context keeps Redis connection open
}
bootstrap()
```

**Docker Compose orchestration (from spec §10):**
```yaml
services:
  api:
    build: .
    command: node dist/main.js         # default; runs HTTP server
    ports: ['3000:3000']
    depends_on: [postgres, redis]

  worker:
    build: .
    command: node dist/worker.js       # override; runs worker only
    depends_on: [postgres, redis]
```

**Why separate:** WebSearch confirms "Separate Process/Container Pattern" is idiomatic NestJS for queue scaling. CPU-heavy jobs in worker won't block the API — webhook receipt stays fast.

---

### Pattern 2: rawBody: true for HMAC Verification

**What:** Enable raw request body access so NestJS doesn't JSON-parse the request before you can compute the HMAC signature.

**When to use:** Whenever verifying webhook signatures (Postmark, Stripe, GitHub, etc.). The signature is computed over the raw bytes; if the framework deserializes first, the bytes change and verification fails.

**Example:**

```typescript
// src/main.ts
const app = await NestFactory.create(AppModule, { rawBody: true })
```

**Then in the webhook controller:**

```typescript
import { Controller, Post, Headers, Body, RawBody } from '@nestjs/common'

@Controller('webhooks')
export class WebhooksController {
  @Post('email')
  async ingestEmail(
    @Headers('x-postmark-signature') signature: string,
    @Body() payload: PostmarkPayloadDto,
    @RawBody() rawBody: Buffer
  ) {
    // Compute HMAC-SHA256 over rawBody, compare to signature
    this.webhooksService.verifySignature(signature, rawBody)
    await this.webhooksService.enqueue(payload)
    return { status: 'queued' }
  }
}
```

**Why:** Postmark signs the raw HTTP request body. Any JSON parsing changes the bytes. HMAC verification requires exact byte match — rawBody: true is non-negotiable for security (INFR-01).

---

### Pattern 3: Environment Validation at Startup (Zod + @nestjs/config)

**What:** Define a Zod schema for environment variables, validate at app bootstrap, and fail immediately if any required var is missing or invalid.

**When to use:** Always. Missing credentials or invalid DATABASE_URL should never be discovered at runtime or in production logs.

**Example (Claude's discretion on exact shape):**

```typescript
// src/config/env.ts
import { z } from 'zod'

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid URL'),
  REDIS_URL: z.string().url('REDIS_URL must be a valid URL'),
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  POSTMARK_WEBHOOK_TOKEN: z.string().min(1, 'POSTMARK_WEBHOOK_TOKEN is required'),
  TENANT_ID: z.string().uuid('TENANT_ID must be a valid UUID'),
  R2_ACCOUNT_ID: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_BUCKET_NAME: z.string().min(1),
})

export type Environment = z.infer<typeof EnvSchema>
```

```typescript
// src/app.module.ts
import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { EnvSchema } from './config/env'

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (config) => {
        const parsed = EnvSchema.safeParse(config)
        if (!parsed.success) {
          console.error('❌ Environment validation failed:', parsed.error.errors)
          process.exit(1)
        }
        return parsed.data
      },
    }),
    // ... other modules
  ],
})
export class AppModule {}
```

**Why:** WebSearch confirms this is standard NestJS pattern. z.infer gives you full TypeScript types. `validate` function is called at startup — if it throws or returns false, NestJS exits immediately. No mystery runtime errors.

---

### Pattern 4: Prisma Service for Dependency Injection

**What:** Wrap PrismaClient in a NestJS service so database access is injected throughout the app, not imported directly.

**When to use:** Always with NestJS + Prisma. Enables testing (mock PrismaService), module organization, and connection pooling via middleware.

**Example:**

```typescript
// src/prisma/prisma.service.ts
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect()
  }

  async onModuleDestroy() {
    await this.$disconnect()
  }
}
```

```typescript
// src/prisma/prisma.module.ts
import { Module } from '@nestjs/common'
import { PrismaService } from './prisma.service'

@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
```

**Then inject in any service:**

```typescript
import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'

@Injectable()
export class CandidatesRepository {
  constructor(private prisma: PrismaService) {}

  async findById(id: string) {
    return this.prisma.candidate.findUnique({ where: { id } })
  }
}
```

**Why:** WebSearch confirms this is standard NestJS + Prisma pattern. Enables connection reuse, graceful shutdown, and testability (mock PrismaService in unit tests).

---

### Pattern 5: BullMQ @Processor Decorator with Job Type Safety

**What:** Use NestJS decorators (@Processor, @Process) to define queue handlers with type-safe job data.

**When to use:** For every background job (ingest-email, score-candidate, etc.).

**Example:**

```typescript
// src/ingestion/ingestion.processor.ts
import { Processor, Process } from '@nestjs/bullmq'
import { Job } from 'bullmq'
import { PostmarkPayloadDto } from '../webhooks/dto/postmark-payload.dto'

@Processor('ingest-email')
export class IngestionProcessor {
  constructor(
    private attachmentExtractor: AttachmentExtractorService,
    private emailParserAgent: EmailParserAgent,
    // ... other injected services
  ) {}

  @Process('ingest-email')
  async process(job: Job<PostmarkPayloadDto>) {
    const payload = job.data

    // Step 1: Extract text from PDF/DOCX
    const cvText = await this.attachmentExtractor.extract(payload.Attachments)

    // Step 2: AI extraction (Haiku)
    const extracted = await this.emailParserAgent.extract(cvText)

    // Step 3: Upload to R2
    const fileUrl = await this.storageService.upload(payload.Attachments[0], ...)

    // ... rest of processing
  }
}
```

**Register the processor in the module:**

```typescript
// src/ingestion/ingestion.module.ts
import { Module } from '@nestjs/common'
import { BullModule } from '@nestjs/bullmq'
import { IngestionProcessor } from './ingestion.processor'

@Module({
  imports: [
    BullModule.registerQueue(
      { name: 'ingest-email' },
      { name: 'score-candidate' }, // can register multiple queues
    ),
  ],
  providers: [IngestionProcessor],
})
export class IngestionModule {}
```

**Why:** Type-safe job data (Job<T>), automatic retry logic, concurrency control, and seamless dependency injection. BullMQ handles the queue mechanics — you just implement the @Process method.

---

### Pattern 6: pg_trgm for Fuzzy Matching (Dedup)

**What:** PostgreSQL's `pg_trgm` extension indexes text similarity and allows fuzzy queries without loading candidates into memory.

**When to use:** For duplicate detection. Query `WHERE full_name % ${newName}` returns similar names with similarity scores — all in SQL.

**Example (in Prisma migration):**

```sql
-- Enable extension (run once)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Create GIN indexes for fast fuzzy matching
CREATE INDEX idx_candidates_name_trgm  ON candidates USING GIN (full_name gin_trgm_ops);
CREATE INDEX idx_candidates_phone_trgm ON candidates USING GIN (phone gin_trgm_ops);

-- Unique email index (exact match dedup)
CREATE UNIQUE INDEX idx_candidates_email ON candidates (tenant_id, email) WHERE email IS NOT NULL;
```

**Then in service:**

```typescript
// src/dedup/dedup.service.ts
async check(candidate: CandidateExtract, tenantId: string) {
  // Step 1: Exact email match (fastest)
  if (candidate.email) {
    const exact = await this.prisma.candidate.findFirst({
      where: { tenantId, email: candidate.email },
    })
    if (exact) return { match: exact, confidence: 1.0, fields: ['email'] }
  }

  // Step 2: Fuzzy name match via pg_trgm
  const fuzzy = await this.prisma.$queryRaw<FuzzyMatch[]>`
    SELECT id, full_name, phone,
           similarity(full_name, ${candidate.fullName}) AS name_sim
    FROM candidates
    WHERE tenant_id = ${tenantId}
      AND full_name % ${candidate.fullName}
    ORDER BY name_sim DESC
    LIMIT 1
  `

  if (fuzzy[0]?.name_sim > 0.7) {
    return { match: fuzzy[0], confidence: fuzzy[0].name_sim, fields: ['name'] }
  }

  return null  // no match
}
```

**Why:** pg_trgm is free, scales naturally, requires no vector API calls (~$50–200/month), and is accurate enough at 500 CVs/month. Fuzzy match (0.7 < confidence < 1.0) creates a duplicate_flags row for human review — never auto-merges.

---

### Pattern 7: Append-Only Scoring Table

**What:** `candidate_job_scores` table has no UPDATE logic — every score is INSERT-only. Latest score = `ORDER BY scored_at DESC LIMIT 1`.

**When to use:** Whenever you want to preserve full history and avoid merge conflicts on retries.

**Example:**

```typescript
// src/scoring/scoring.processor.ts
@Process('score-candidate')
async process(job: Job<{ candidateId: string }>) {
  const { candidateId } = job.data
  const tenantId = this.configService.get('TENANT_ID')

  const candidate = await this.candidatesRepository.findById(candidateId)
  const activeJobs = await this.jobsRepository.findActive(tenantId)

  for (const activeJob of activeJobs) {
    // Upsert application — idempotent on retry
    const application = await this.prisma.application.upsert({
      where: { tenantId_candidateId_jobId: { tenantId, candidateId, jobId: activeJob.id } },
      create: { tenantId, candidateId, jobId: activeJob.id, stage: 'new', appliedAt: new Date() },
      update: {}, // no-op on retry
    })

    const result = await this.jobScorerAgent.score(candidate, activeJob)

    // APPEND ONLY — never update existing scores
    await this.prisma.candidateJobScore.create({
      data: {
        tenantId,
        applicationId: application.id,
        score: result.score,
        reasoning: result.reasoning,
        strengths: result.strengths,
        gaps: result.gaps,
        modelUsed: 'claude-sonnet-4-6',
        // scoredAt is NOW() via @db.Timestamp @default(now()) in Prisma
      },
    })
  }
}
```

**Why:** If a job is retried (network failure, worker crash), the INSERT-only pattern means no merge conflicts. History is preserved. The recruiter UI will query `ORDER BY scored_at DESC LIMIT 1` to get the latest score.

---

### Anti-Patterns to Avoid

- **❌ Storing binary blobs in PostgreSQL:** Raw PDF/DOCX attachments in the DB makes every backup massive. Store files in R2, keep only the URL in `cv_file_url`. (DB-05)
- **❌ Using PostgreSQL ENUMs for status columns:** Adding a new enum value requires a migration. Use `text + CHECK (status IN (...))` instead — no migration needed. (DB-03)
- **❌ Running BullMQ processors in the same HTTP process:** PDF parsing and AI calls block webhook receipt. Separate processes are non-negotiable. (PROC-01)
- **❌ Auto-upserting on fuzzy dedup match:** "Daniel Shalem" and "Danny Shalem" might be the same person or two different people. Let a recruiter decide. Never silently overwrite. (DEDUP-05 in Requirements)
- **❌ Updating `candidate_job_scores`:** History loss, no audit trail, merge conflicts on retry. Append-only only. (SCOR-04 in Requirements)
- **❌ Storing Postmark raw payload with binary attachment blobs:** A single email with a large PDF can write 10–20MB to the DB. Strip attachment blobs before storing. (DB-05)
- **❌ Skipping HMAC verification on webhooks:** Anyone who discovers the endpoint URL can inject fake candidates. Verify the X-Postmark-Signature header. (INFR-01)

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|------------|-------------|-----|
| **Environment variable validation** | Custom parsing logic with defaults and try-catch | `@nestjs/config` + Zod | Zod handles URL validation, type coercion, and produces clear error messages on startup. Hand-rolled parsing is error-prone and hard to test. |
| **Job queue with retries** | Custom Redis polling loop + retry count tracking | BullMQ + @nestjs/bullmq | BullMQ handles exponential backoff, concurrency, dead-letter queues, and job state persistence. Hand-rolled is fragile and requires extensive testing. |
| **Fuzzy string matching** | In-app similarity algorithm (Levenshtein, etc.) + loading all candidates into memory | PostgreSQL `pg_trgm` extension | pg_trgm is battle-tested, indexes scale naturally, and requires zero memory overhead. Hand-rolled algorithms are slow on 10k+ candidates. |
| **Database schema migrations** | Hand-written SQL migration files | Prisma migrations | Prisma auto-generates idempotent migrations from schema.prisma, handles rollbacks, and produces repeatable deployments. Hand-written migrations are error-prone and hard to audit. |
| **PDF/DOCX parsing** | Custom regex + text extraction | `pdf-parse` + `mammoth` | Both libraries handle edge cases (malformed PDFs, embedded fonts, character encoding) that hand-written parsers miss. Production-tested in thousands of projects. |
| **S3/R2 uploads** | Custom file streaming + multipart handling | `@aws-sdk/client-s3` | AWS SDK handles retries, multipart uploads for large files, chunking, and connection pooling. Hand-rolled is slow and error-prone. |
| **HMAC-SHA256 signature verification** | Custom Node.js crypto calls + manual byte handling | Express middleware + built-in crypto module (properly) | One-off crypto implementations are vulnerable to timing attacks and byte-ordering bugs. Use verified libraries. |

**Key insight:** All items above involve error cases (network retries, character encoding, file corruption) that are easy to miss in hand-rolled code. Production libraries handle these invisibly — their value is in the edge cases, not the happy path.

---

## Runtime State Inventory

**Not applicable:** Phase 1 is greenfield — no existing schema, no running services, no cached state to migrate.

---

## Common Pitfalls

### Pitfall 1: Forgetting rawBody: true for HMAC Verification

**What goes wrong:** Webhook signature verification fails on every request (always 401), so the API rejects all legitimate emails. Or worse — verification silently succeeds with corrupted data because JSON parsing changed the bytes.

**Why it happens:** NestJS automatically JSON-deserializes the request body. By the time your handler receives the payload, the raw bytes are lost. The HMAC signature was computed over the original bytes; deserialized JSON doesn't match.

**How to avoid:** Enable `rawBody: true` in NestFactory.create() (INFR-01) and inject `@RawBody() rawBody: Buffer` in your controller. Verify HMAC over rawBody before deserializing.

**Warning signs:** Every webhook returns 401. Or verify passes but you see data corruption (e.g., non-ASCII characters mangled).

---

### Pitfall 2: Storing Attachment Blobs in PostgreSQL

**What goes wrong:** A single email with a 10MB PDF attachment writes 10MB to `email_intake_log.raw_payload`. With 500 CVs/month, that's 5GB of database per month. Backups become huge. Queries slow down. Costs spiral.

**Why it happens:** It's easy to just serialize the entire Postmark payload to JSONB. The attachment binary is right there in the JSON — why not keep it?

**How to avoid:** Before storing in `raw_payload`, strip attachment blobs via a helper function (spec §6, line 251–256). Keep only attachment metadata (filename, size, content-type). The original file is uploaded to R2 separately (STOR-01).

**Warning signs:** Database size grows faster than expected. Backup/restore takes hours. Queries slow down despite small candidate count.

---

### Pitfall 3: Running BullMQ Processors in the Same Process as the HTTP Server

**What goes wrong:** A webhook arrives while the worker is CPU-bound parsing a 50-page PDF. The HTTP server blocks. The webhook endpoint is unresponsive. Another webhook arrives — it times out waiting for the first to finish. Message queue backs up. Emails are lost or re-delivered.

**Why it happens:** Running everything in one process is simpler. It's tempting to skip the Docker Compose complexity.

**How to avoid:** Create a separate `worker.ts` entry point that runs `NestFactory.createApplicationContext()` (no HTTP server). Orchestrate two Docker services (`api` and `worker`) in docker-compose.yml, each with its own container (PROC-01). The API stays responsive; the worker scales independently.

**Warning signs:** API latency spikes whenever a large email arrives. Webhook timeouts. Redis queue depth grows constantly without draining.

---

### Pitfall 4: Auto-Upserting on Fuzzy Dedup Match

**What goes wrong:** "Daniel Shalem" and "Danny Shalem" with different emails are fuzzy-matched at 0.85 confidence. The system auto-upsertes — overwrites Danny's record with Daniel's data. Later, a recruiter realizes they're two different people. Data is lost.

**Why it happens:** Fuzzy matching is tempting for dedup. A 0.8+ similarity score *feels* like a match. Why flag for human review?

**How to avoid:** Only UPSERT on exact email match (confidence = 1.0). For fuzzy matches (0.7 < confidence < 1.0), always INSERT a new candidate and create a `duplicate_flags` row (DEDUP-05). Let the recruiter review in Phase 2.

**Warning signs:** Duplicate flags are never created. Recruiter says "I see candidate X, but their record has data from candidate Y." Data merges are irreversible at scale.

---

### Pitfall 5: Updating candidate_job_scores Instead of Appending

**What goes wrong:** If a scoring job is retried (network timeout, worker crash), you UPDATE the old score row instead of creating a new one. On retry, the UPDATE runs twice due to race conditions (two workers or two retries). Score is corrupted or lost. No audit trail.

**Why it happens:** UPDATE is intuitive. "Re-score the candidate, replace the old score." It's simpler than append-only.

**How to avoid:** Use INSERT-only for `candidate_job_scores`. On retry, insert a new row. The recruiter UI queries `ORDER BY scored_at DESC LIMIT 1` to get the latest score. Full history is preserved.

**Warning signs:** Score history is lost. Recruiter can't trace when a score changed. Re-running the job changes the result.

---

### Pitfall 6: Missing Environment Variables at Startup

**What goes wrong:** The app starts fine locally but crashes in production when it tries to upload to R2 — `R2_ACCESS_KEY_ID` was never loaded. Or it connects to the wrong database because `DATABASE_URL` isn't set.

**Why it happens:** Missing env vars are discovered only when that code path runs. If you deploy on a Friday night and the first email arrives Saturday morning, you'll be paged.

**How to avoid:** Validate ALL environment variables at startup via `@nestjs/config` + Zod (INFR-03). If any required var is missing or invalid, the app exits immediately with a clear error. You catch the problem during deployment tests, not in production.

**Warning signs:** App starts but crashes on first webhook. Error is buried in logs: "cannot read property 'bucket' of undefined".

---

### Pitfall 7: Using PostgreSQL ENUMs for Status Columns

**What goes wrong:** You define `CREATE TYPE application_stage AS ENUM ('new', 'screening', 'interview', 'offer', 'hired', 'rejected')`. Later, a recruiter says "we also need 'on-hold'". You add it to the enum. Running the migration fails because the enum value is already in use in production rows. You need a complex migration script.

**Why it happens:** ENUMs are typed and feel safer than arbitrary text. But they're inflexible.

**How to avoid:** Use `text NOT NULL CHECK (status IN ('new', 'screening', ...))` instead (DB-03). Adding a new value is a schema change with no migration — just UPDATE the CHECK constraint. Safer, simpler, proven pattern.

**Warning signs:** Enum migrations fail. You're forced to write custom migration code or create intermediate stages. Team complains about schema inflexibility.

---

## Code Examples

Verified patterns from official sources and architecture spec:

### Example 1: BullMQ Module Registration

```typescript
// src/app.module.ts
import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { BullModule } from '@nestjs/bullmq'
import { EnvSchema } from './config/env'
import { PrismaModule } from './prisma/prisma.module'
import { IngestionModule } from './ingestion/ingestion.module'
import { ScoringModule } from './scoring/scoring.module'

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (config) => {
        const parsed = EnvSchema.safeParse(config)
        if (!parsed.success) {
          console.error('Environment validation failed:', parsed.error.errors)
          process.exit(1)
        }
        return parsed.data
      },
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        connection: {
          url: configService.get<string>('REDIS_URL'),
        },
      }),
    }),
    BullModule.registerQueue(
      { name: 'ingest-email' },
      { name: 'score-candidate' },
    ),
    PrismaModule,
    IngestionModule,
    ScoringModule,
  ],
})
export class AppModule {}
```

Source: [NestJS BullMQ Documentation](https://docs.nestjs.com/techniques/queues)

---

### Example 2: Webhook Signature Verification

```typescript
// src/webhooks/webhooks.controller.ts
import { Controller, Post, Headers, Body, RawBody } from '@nestjs/common'
import { WebhooksService } from './webhooks.service'
import { PostmarkPayloadDto } from './dto/postmark-payload.dto'

@Controller('webhooks')
export class WebhooksController {
  constructor(private webhooksService: WebhooksService) {}

  @Post('email')
  async ingestEmail(
    @Headers('x-postmark-signature') signature: string,
    @Body() payload: PostmarkPayloadDto,
    @RawBody() rawBody: Buffer,
  ) {
    // Verify HMAC-SHA256 signature before processing
    this.webhooksService.verifySignature(signature, rawBody)

    // Enqueue for background processing
    await this.webhooksService.enqueue(payload)

    return { status: 'queued' }
  }
}
```

```typescript
// src/webhooks/webhooks.service.ts
import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { InjectQueue } from '@nestjs/bullmq'
import { Queue } from 'bullmq'
import * as crypto from 'crypto'
import { PrismaService } from '../prisma/prisma.service'
import { PostmarkPayloadDto } from './dto/postmark-payload.dto'

@Injectable()
export class WebhooksService {
  constructor(
    private configService: ConfigService,
    @InjectQueue('ingest-email') private ingestQueue: Queue,
    private prisma: PrismaService,
  ) {}

  verifySignature(signature: string, rawBody: Buffer) {
    const webhookToken = this.configService.get<string>('POSTMARK_WEBHOOK_TOKEN')
    const computedSignature = crypto
      .createHmac('sha256', webhookToken)
      .update(rawBody)
      .digest('base64')

    if (signature !== computedSignature) {
      throw new UnauthorizedException('Invalid webhook signature')
    }
  }

  async enqueue(payload: PostmarkPayloadDto) {
    // Idempotency check: skip if already processed
    const existing = await this.prisma.emailIntakeLog.findUnique({
      where: {
        tenantId_messageId: {
          tenantId: this.configService.get('TENANT_ID'),
          messageId: payload.MessageID,
        },
      },
    })
    if (existing) return

    // INSERT intake log row BEFORE enqueuing — idempotency guard
    await this.prisma.emailIntakeLog.create({
      data: {
        tenantId: this.configService.get<string>('TENANT_ID'),
        messageId: payload.MessageID,
        fromEmail: payload.From,
        subject: payload.Subject,
        receivedAt: new Date(payload.Date),
        processingStatus: 'pending',
        rawPayload: this.stripAttachmentBlobs(payload),
      },
    })

    // Enqueue with retry logic
    await this.ingestQueue.add('ingest-email', payload, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    })
  }

  private stripAttachmentBlobs(payload: PostmarkPayloadDto) {
    return {
      ...payload,
      Attachments: (payload.Attachments ?? []).map(({ Content, ...meta }) => meta),
    }
  }
}
```

Source: [Architecture Spec §6](spec/backend-architecture-proposal.md)

---

### Example 3: Prisma pg_trgm Fuzzy Dedup Query

```typescript
// src/dedup/dedup.service.ts
import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'

interface CandidateExtract {
  fullName: string
  email?: string
  phone?: string
}

interface FuzzyMatch {
  id: string
  full_name: string
  phone?: string
  name_sim: number
}

@Injectable()
export class DedupService {
  constructor(private prisma: PrismaService) {}

  async check(candidate: CandidateExtract, tenantId: string) {
    // Step 1: Exact email match (UPSERT-safe)
    if (candidate.email) {
      const exact = await this.prisma.candidate.findFirst({
        where: { tenantId, email: candidate.email },
      })
      if (exact) {
        return { match: exact, confidence: 1.0, fields: ['email'] }
      }
    }

    // Step 2: Fuzzy name match via pg_trgm (never UPSERT)
    const fuzzy = await this.prisma.$queryRaw<FuzzyMatch[]>`
      SELECT id, full_name, phone,
             similarity(full_name, ${candidate.fullName}) AS name_sim
      FROM candidates
      WHERE tenant_id = ${tenantId}
        AND full_name % ${candidate.fullName}
      ORDER BY name_sim DESC
      LIMIT 1
    `

    if (fuzzy[0]?.name_sim > 0.7) {
      return {
        match: fuzzy[0],
        confidence: fuzzy[0].name_sim,
        fields: ['name'],
      }
    }

    return null // No match
  }

  async createFlag(
    newCandidateId: string,
    matchedCandidateId: string,
    confidence: number,
    tenantId: string,
  ) {
    // Never auto-merge: always flag for human review
    await this.prisma.duplicateFlag.create({
      data: {
        tenantId,
        candidateId: newCandidateId,
        matchedCandidateId,
        confidence,
        matchFields: ['name'],
        reviewed: false,
      },
    })
  }
}
```

Source: [Architecture Spec §8](spec/backend-architecture-proposal.md)

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| class-validator + class-transformer | Zod for environment validation | 2024–2025 | class-validator package unmaintained (2+ years); Zod is actively maintained, produces smaller bundles, better error messages |
| Multiple separate .env files (dev, prod, test) | Single schema with environment-specific overrides | 2023+ | Reduces config duplication; single source of truth for required vars |
| Bull (older queue package) | BullMQ (newer, lighter, better DX) | 2023+ | BullMQ has sandboxed processors, better TypeScript support, cleaner API |
| Vector DB for dedup (Pinecone, Weaviate) | PostgreSQL pg_trgm for fuzzy matching | 2024+ (at this scale) | pg_trgm is free, scales naturally, no vendor lock-in; vector DB adds $50–200/month and infrastructure complexity at 500 CVs/month |
| Hand-written Prisma migrations (SQL) | Prisma auto-generated migrations (from schema.prisma) | 2022+ | Schema-driven, reversible, idempotent, no manual SQL bugs |
| `class-validator` decorators on DTOs | Zod schemas (separate from DTOs, more flexible) | 2024+ | Zod supports complex transformations, nested validation, and environment schemas; class-validator is unmaintained |

**Deprecated/outdated:**
- **Bull (old queue package):** Replaced by BullMQ (v5+). BullMQ is lighter, faster, and has better TypeScript support. This project should use BullMQ.
- **class-validator:** Unmaintained for 2+ years. Replace with Zod.
- **TypeORM:** Prisma is more modern, has better tooling (migrations, auto-generated types), and is the default for NestJS 11 projects.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Jest 30.0.0 (pre-installed) |
| Config file | `package.json` (jest key) + `test/jest-e2e.json` |
| Quick run command | `npm test -- --testPathPattern="src/" --testNamePattern="Unit" --maxWorkers=2` |
| Full suite command | `npm run test:cov` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| **DB-01** | Prisma migration creates all 7 tables with correct schema | Integration | `npm test -- --testPathPattern="prisma.service" -x` | ❌ Wave 0 |
| **DB-02** | Every table has `tenant_id` FK + proper indexes | Integration | `npm test -- --testPathPattern="prisma" -x` | ❌ Wave 0 |
| **DB-03** | Status columns use CHECK constraints, not ENUMs | Manual verification | Inspect `prisma/schema.prisma` | N/A |
| **DB-04** | `updated_at` is auto-maintained by Prisma `@updatedAt` | Unit | `npm test -- --testPathPattern="prisma.service" -x` | ❌ Wave 0 |
| **DB-05** | No binary blobs in DB (cv_file_url is text, not bytea) | Manual verification | Inspect `prisma/schema.prisma` and integration test | N/A |
| **DB-06** | `applications` UNIQUE constraint `(tenant_id, candidate_id, job_id)` | Integration | `npm test -- --testPathPattern="applications" -x` | ❌ Wave 0 |
| **DB-07** | `duplicate_flags` UNIQUE constraint prevents duplicate flags | Integration | `npm test -- --testPathPattern="dedup" -x` | ❌ Wave 0 |
| **DB-08** | `email_intake_log` UNIQUE constraint `(tenant_id, message_id)` | Integration | `npm test -- --testPathPattern="webhooks" -x` | ❌ Wave 0 |
| **DB-09** | All indexes created (pg_trgm GIN, active jobs, stages, scores, etc.) | Manual verification | List indexes: `\d candidates` in psql | N/A |
| **INFR-01** | NestJS API starts with `rawBody: true` | Unit | `npm test -- --testPathPattern="main" -x` | ❌ Wave 0 |
| **INFR-02** | BullMQ worker starts in separate process (no HTTP) | Integration | `npm test -- --testPathPattern="worker" -x` | ❌ Wave 0 |
| **INFR-03** | Environment validation fails fast on missing ANTHROPIC_API_KEY, etc. | Unit | `npm test -- --testPathPattern="config" -x` | ❌ Wave 0 |
| **INFR-04** | Docker Compose brings up all 4 services (api, worker, postgres, redis) | Integration (e2e) | `docker-compose up --wait && docker-compose ps` | N/A (manual docker test) |
| **INFR-05** | `.env.example` has all 10 required vars documented | Manual verification | Inspect `.env.example` | ✅ (must exist) |
| **PROC-01** | API and Worker run in separate Docker containers | Integration (e2e) | `docker-compose ps \| grep -E 'api\|worker'` | N/A (manual docker test) |

### Sampling Rate
- **Per task commit:** `npm test -- --testPathPattern="src/" --maxWorkers=2` (unit tests, ~10 seconds)
- **Per wave merge:** `npm run test:cov` (full suite, ~30 seconds)
- **Phase gate:** Full suite green + docker-compose e2e test before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `src/config/env.ts` + `src/config/env.spec.ts` — Zod schema with validation tests (covers INFR-03)
- [ ] `src/prisma/prisma.service.ts` + `src/prisma/prisma.service.spec.ts` — PrismaService initialization tests (covers DB-01, DB-04)
- [ ] `src/main.ts` + `src/main.spec.ts` — rawBody: true configuration test (covers INFR-01)
- [ ] `src/worker.ts` + `src/worker.spec.ts` — Worker bootstrap (no HTTP) test (covers INFR-02)
- [ ] `prisma/schema.prisma` migration test — Verify schema against requirements (covers DB-02 through DB-09)
- [ ] Framework install: `npm install @nestjs/testing jest @types/jest` — already done, no action needed
- [ ] E2E test (`test/app.e2e-spec.ts`): Update to test docker-compose bootstrap (covers INFR-04, PROC-01)

**Key insight:** Phase 1 Wave 0 focuses on infrastructure (database, config, process bootstrap). Integration tests verify database schema constraints. E2E tests verify Docker Compose orchestration. Manual verification confirms no binary blobs and all env vars documented.

---

## Open Questions

1. **Exact Zod schema shape (Claude's discretion)**
   - What we know: @nestjs/config + Zod is standard NestJS pattern; URL validation for DATABASE_URL/REDIS_URL, non-empty string for API keys.
   - What's unclear: Specific z.string().url() vs z.string().startsWith('postgresql://') — should schema be permissive or strict?
   - Recommendation: Use z.string().url() for DATABASE_URL (strict parsing), z.string().min(1) for ANTHROPIC_API_KEY (just non-empty). Schema should fail fast on invalid URLs but not be pedantic about API key format.

2. **Dockerfile design: multi-stage vs single-stage (Claude's discretion)**
   - What we know: Multi-stage is industry standard for smaller production images (excludes build tools). Single-stage is simpler.
   - What's unclear: Is production image size critical at this scale? (~200MB vs ~500MB).
   - Recommendation: Use multi-stage Dockerfile (build stage with full toolchain, runtime stage with only Node.js + dist/). Standard practice, minimal extra complexity.

3. **AppModule structure: which built-in NestJS modules to import (Claude's discretion)**
   - What we know: ConfigModule, BullModule, PrismaModule are needed. Should they be imported in AppModule or in feature modules?
   - What's unclear: Best practice for module hierarchy in Phase 1.
   - Recommendation: Import ConfigModule.forRoot() and BullModule.forRoot() in AppModule (global). Feature modules (IngestionModule, ScoringModule) import BullModule.registerQueue() locally.

---

## Sources

### Primary (HIGH confidence)

- **spec/backend-architecture-proposal.md** (approved 2026-03-19) — Full database schema, docker-compose, environment variables, architecture patterns, and project structure. This is the source of truth for Phase 1.
- **.planning/CONTEXT.md** (decisions D-01 through D-06) — Locked implementation decisions: dependencies to install, scaffold cleanup, seed data, docker-compose health checks.
- **.planning/REQUIREMENTS.md** (DB-01 through DB-09, INFR-01 through INFR-05, PROC-01) — Phase 1 requirements mapped to architecture patterns.

### Secondary (MEDIUM confidence)

- [NestJS BullMQ Integration Documentation](https://docs.nestjs.com/techniques/queues) — Confirmed separate worker process pattern is idiomatic NestJS; @Processor/@Process decorators are standard.
- [NestJS Prisma Documentation](https://docs.nestjs.com/recipes/prisma) — Confirmed PrismaService pattern with dependency injection; @updatedAt directive for timestamp auto-maintenance.
- [Running NestJS Queues in a Separate Process — Medium](https://medium.com/s1seven/running-nestjs-queues-in-a-separate-process-948f414c4b41) — Validated separate API + Worker container pattern prevents webhook blocking.
- [Validating NestJS env vars with zod — Omid Sayfun](https://omiid.me/notebook/38/validating-nestjs-env-vars-with-zod) — Confirmed @nestjs/config + Zod is standard for environment validation.
- [Prisma 6 PostgreSQL NestJS 11 Best Practices — DEV Community](https://dev.to/manendrav/how-to-set-up-nestjs-with-prisma-and-postgresql-2026-complete-guide-2da7) — Validated Prisma 6 + NestJS 11 stack patterns.
- [Cloudflare R2 S3 API Compatibility](https://developers.cloudflare.com/r2/api/s3/api/) — Confirmed R2 is S3-compatible; @aws-sdk/client-s3 works directly.
- [Vercel AI SDK Anthropic Provider](https://ai-sdk.dev/providers/ai-sdk-providers/anthropic) — Confirmed Claude Haiku 4.5 and Sonnet 4.6 available through @ai-sdk/anthropic.

### Tertiary (LOW confidence — flagged for validation)

None. All critical claims are verified by approved spec or official documentation.

---

## Metadata

**Confidence breakdown:**
- **Standard stack:** HIGH — NestJS 11, Prisma 6, BullMQ, PostgreSQL 16 are approved in spec and confirmed by WebSearch. Versions are stable (11.0.1, ^6.0, ^5.x, ^16.0).
- **Architecture patterns:** HIGH — Separate API + Worker process, rawBody: true, Zod validation, pg_trgm dedup are all documented in approved spec or verified as idiomatic NestJS.
- **Pitfalls:** HIGH — Common mistakes (binary blobs, enum migrations, updating scores, fuzzy auto-merge) are extracted directly from spec and Requirements.md.
- **Don't hand-roll:** MEDIUM-HIGH — BullMQ, pdf-parse, Prisma migrations are proven libraries. Reasoning (edge cases, error handling) is solid but not verified with every library's exact docs.

**Research date:** 2026-03-22
**Valid until:** 2026-04-22 (NestJS/Prisma/BullMQ move fast; check for updates in 30 days if major features are needed)

---

*Phase 1 Foundation research complete. Ready for planner to create PLAN.md and execute Wave 1 (database schema + env config).*
