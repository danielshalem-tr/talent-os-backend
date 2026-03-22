# Triolla Talent OS — Backend Architecture

> **Status:** Approved
> **Last updated:** 2026-03-19
> **Scope:** Phase 1 MVP — Email Intake Pipeline

---

## Table of Contents

1. [What We're Building](#1-what-were-building)
2. [Constraints & Decisions](#2-constraints--decisions)
3. [System Overview](#3-system-overview)
4. [Tech Stack](#4-tech-stack)
5. [Project Structure](#5-project-structure)
6. [The Email Intake Pipeline](#6-the-email-intake-pipeline)
7. [AI Agents](#7-ai-agents)
8. [Duplicate Detection](#8-duplicate-detection)
9. [Database](#9-database)
10. [Infrastructure & Deployment](#10-infrastructure--deployment)
11. [What's Not in Phase 1](#11-whats-not-in-phase-1)
12. [Open Questions](#12-open-questions)

---

## 1. What We're Building

**Phase 1 goal:** An automated email intake pipeline that receives CVs by email, extracts candidate data using AI, detects duplicates, scores candidates against open positions, and stores everything in a database — ready for the recruiter UI to consume.

**Scale:** ~500 CVs/month (~17/day). Low throughput. Performance is not a constraint.

**What the MVP does NOT include:** recruiter-facing API, authentication, UI integration, outreach, or any write operations initiated by a human. The system is purely reactive — it processes inbound emails.

---

## 2. Constraints & Decisions

| Topic             | Decision                              | Reason                                                                                                                            |
| :---------------- | :------------------------------------ | :-------------------------------------------------------------------------------------------------------------------------------- |
| **Language**      | TypeScript only                       | Shared language with frontend.                                                                                                    |
| **Framework**     | NestJS                                | TypeScript-first, structured, scales well as the product grows. Over-engineered for MVP alone, right choice for the full product. |
| **Email intake**  | Postmark Inbound webhook              | Simplest path. No polling loop, no Gmail OAuth complexity.                                                                        |
| **AI calls**      | Claude API via Vercel AI SDK          | Haiku for cheap extraction, Sonnet for scoring. No local models in Phase 1.                                                       |
| **Dedup**         | PostgreSQL `pg_trgm`                  | Fuzzy matching in the DB — no in-memory loading of candidates, scales naturally.                                                  |
| **Queue**         | BullMQ + Redis                        | Decouples webhook receipt from slow AI processing. Retry logic built-in.                                                          |
| **ORM**           | Prisma                                | Type-safe, TS-native, clean migration tooling. Schema as single source of truth.                                                  |
| **Database**      | PostgreSQL 16                         | Relational integrity + JSONB for flexible fields. `pg_trgm` for fuzzy search.                                                     |
| **Deployment**    | Docker Compose on Hetzner VPS         | Cheapest viable option at this scale. ~€5/month. Migrates to AWS trivially if needed.                                             |
| **Multi-tenancy** | `tenant_id` on every table from day 1 | Prevents a schema rewrite when the product scales to multiple clients.                                                            |

---

## 3. System Overview

```
[Email arrives]
      │
      ▼
[Postmark Inbound]
      │  structured JSON webhook POST
      ▼
┌─────────────────────────────┐
│  NestJS API (Docker: api)   │  ← only webhook reception, never blocked
│  ├── Verify HMAC-SHA256     │
│  ├── Idempotency check      │
│  └── Enqueue → BullMQ/Redis │
└─────────────────────────────┘
      │
      ▼ (separate Docker container — different OS process)
┌──────────────────────────────────────┐
│  BullMQ Worker (Docker: worker)      │
│  ├── [0] Spam filter (heuristics)    │  → discard if not a CV
│  ├── [1] Extract PDF/DOCX text       │  ← CPU-heavy, safe here
│  ├── [2] Agent 1: extract fields     │  (Haiku)
│  ├── [3] Upload original file → R2   │  ← before dedup: file must be preserved
│  ├── [4] Dedup check (pg_trgm)       │
│  ├── [5] INSERT candidate + flag     │  ← never blind upsert on fuzzy
│  └── [6] Enqueue scoring job         │
└──────────────────────────────────────┘
      │
      ▼ (same worker container, separate queue)
┌──────────────────────────────────────┐
│  BullMQ Worker: score-candidate      │
│  └── Agent 2: score vs active jobs   │  (Sonnet)
└──────────────────────────────────────┘
      │
      ▼
[PostgreSQL]  ←─→  [Cloudflare R2]
      │
      ▼  (Phase 2)
[Recruiter UI]
```

**Non-negotiable requirements for Phase 1:**

1. **Webhook signature verification.** Postmark signs every request with `X-Postmark-Signature` (HMAC-SHA256). Without verifying it, anyone who discovers the endpoint URL can inject arbitrary candidate records.
2. **Idempotency.** Email services re-deliver webhooks on network failures. Check `MessageID` before enqueuing — otherwise the same CV is processed multiple times.
3. **API and Worker are separate processes.** This is intentional and already reflected in docker-compose (`api` and `worker` are separate containers). CPU-heavy operations like PDF parsing happen in the Worker process and can never block the API from receiving new webhooks.
4. **Never auto-upsert on fuzzy match.** Only exact email matches justify overwriting an existing record. Fuzzy matches always create a new candidate + `duplicate_flags` row for human review.
5. **Store original CV files in Phase 1.** Postmark does not retain attachments. If files are not stored on receipt, they are lost permanently.

---

## 4. Tech Stack

| Layer            | Technology                   | Notes                                                                       |
| :--------------- | :--------------------------- | :-------------------------------------------------------------------------- |
| Runtime          | Node.js 22 LTS               | LTS — stable, supported until 2027                                          |
| Framework        | NestJS 11                    | TypeScript-first, modular, decorator-based                                  |
| Queue            | BullMQ + Redis               | Job queue with retries, concurrency control, dead-letter                    |
| ORM              | Prisma 6                     | Schema-first, type-safe, migration tooling                                  |
| Database         | PostgreSQL 16                | `pg_trgm` extension for fuzzy matching                                      |
| AI SDK           | Vercel AI SDK (`ai` package) | Unified interface: Claude, OpenAI, Ollama — one-line model swap             |
| AI provider      | `@ai-sdk/anthropic`          | Claude Haiku (extraction) + Claude Sonnet (scoring)                         |
| PDF parsing      | `pdf-parse`                  | Extracts text from PDF CVs                                                  |
| DOCX parsing     | `mammoth`                    | Converts DOCX to plain text                                                 |
| Validation       | Zod                          | Schema validation + typed AI structured outputs                             |
| Config           | `@nestjs/config` + Zod       | Env vars validated at startup                                               |
| File storage     | Cloudflare R2                | S3-compatible, 10GB free tier, ~$0.015/GB beyond — stores original CV files |
| Containerization | Docker + Docker Compose      | Same setup runs locally and on VPS                                          |

---

## 5. Project Structure

```
triolla-backend/
├── src/
│   ├── app.module.ts                  # Root NestJS module
│   ├── main.ts                        # Entry point — HTTP server (bootstrap)
│   ├── worker.ts                      # Entry point — BullMQ worker (bootstrap, no HTTP layer)
│   │
│   ├── webhooks/                      # HTTP layer — receives Postmark payloads
│   │   ├── webhooks.module.ts
│   │   ├── webhooks.controller.ts     # POST /webhooks/email
│   │   ├── webhooks.service.ts        # Signature verification + enqueue
│   │   └── dto/
│   │       └── postmark-payload.dto.ts
│   │
│   ├── ingestion/                     # BullMQ worker: email → candidate
│   │   ├── ingestion.module.ts
│   │   ├── ingestion.processor.ts     # @Processor('ingest-email')
│   │   └── attachment-extractor.ts    # pdf-parse + mammoth
│   │
│   ├── scoring/                       # BullMQ worker: candidate → scores
│   │   ├── scoring.module.ts
│   │   └── scoring.processor.ts      # @Processor('score-candidate')
│   │
│   ├── agents/                        # AI calls (Vercel AI SDK)
│   │   ├── agents.module.ts
│   │   ├── email-parser.agent.ts      # Haiku + Zod schema → CandidateExtract
│   │   └── job-scorer.agent.ts        # Sonnet + Zod schema → ScoringResult
│   │
│   ├── dedup/                         # Duplicate detection
│   │   ├── dedup.module.ts
│   │   └── dedup.service.ts           # pg_trgm queries via Prisma $queryRaw
│   │
│   ├── storage/                       # Cloudflare R2 file uploads
│   │   ├── storage.module.ts
│   │   └── storage.service.ts         # upload(buffer, key) → url
│   │
│   ├── candidates/                    # Candidate DB operations
│   │   ├── candidates.module.ts
│   │   └── candidates.repository.ts
│   │
│   ├── jobs/                          # Job DB operations
│   │   ├── jobs.module.ts
│   │   └── jobs.repository.ts
│   │
│   └── common/
│       ├── filters/                   # Global exception filter
│       └── interceptors/              # Logging
│
├── prisma/
│   ├── schema.prisma                  # DB schema (single source of truth)
│   └── migrations/                    # Auto-generated by prisma migrate
│
├── docker-compose.yml
├── Dockerfile
├── .env.example
├── package.json
└── tsconfig.json
```

**Why this structure:**

NestJS is module-based. Each folder above is a self-contained NestJS module. This is idiomatic NestJS and makes the codebase predictable as it grows — a new developer (or future you) knows exactly where each concern lives.

---

## 6. The Email Intake Pipeline

### Step 1 — Receive Webhook

`main.ts` must enable raw body access for HMAC verification to work:

```typescript
// main.ts
const app = await NestFactory.create(AppModule, { rawBody: true })
```

> **Auth note:** Postmark's **inbound** webhooks use a different authentication mechanism than their delivery/bounce webhooks (which use HMAC-SHA256 on `X-Postmark-Signature`). Verify the exact auth method for inbound webhooks in Postmark's documentation before implementing `verifySignature`.

```typescript
// webhooks.controller.ts
@Controller('webhooks')
export class WebhooksController {
  @Post('email')
  async ingestEmail(@Headers('x-postmark-signature') signature: string, @Body() payload: PostmarkPayloadDto, @RawBody() rawBody: Buffer) {
    this.webhooksService.verifySignature(signature, rawBody) // throws 401 if invalid
    await this.webhooksService.enqueue(payload)
    return { status: 'queued' }
  }
}
```

### Step 2 — Verify & Enqueue

```typescript
// webhooks.service.ts
async enqueue(payload: PostmarkPayloadDto) {
  // Idempotency: skip if already processed
  const existing = await this.prisma.emailIntakeLog.findUnique({
    where: { messageId: payload.MessageID },
  })
  if (existing) return

  // INSERT intake log row BEFORE enqueuing — this row IS the idempotency guard.
  // If the process crashes after this and before BullMQ acks, a re-delivery
  // will hit the findUnique above and be safely skipped.
  await this.prisma.emailIntakeLog.create({
    data: {
      tenantId: this.configService.get('TENANT_ID'),
      messageId: payload.MessageID,
      fromEmail: payload.From,
      subject: payload.Subject,
      receivedAt: new Date(payload.Date),
      processingStatus: 'pending',
      rawPayload: stripAttachmentBlobs(payload), // strip binary blobs before storing
    },
  })

  await this.ingestQueue.add('ingest-email', payload, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  })
}

// Strips raw attachment binary content before storing the payload in the DB.
// Without this, a single email with a PDF attachment can write 5–20MB to raw_payload.
function stripAttachmentBlobs(payload: PostmarkPayloadDto): PostmarkPayloadDto {
  return {
    ...payload,
    Attachments: (payload.Attachments ?? []).map(({ Content, ...meta }) => meta),
  }
}
```

### Step 3 — Process (BullMQ Worker)

The Worker runs in a **separate Docker container** (`worker` in docker-compose). PDF parsing is CPU-bound — running it here means it can never block the `api` container from accepting new webhooks.

```typescript
// ingestion.processor.ts
@Processor('ingest-email')
export class IngestionProcessor {
  @Process('ingest-email')
  async process(job: Job<PostmarkPayloadDto>) {
    const payload = job.data

    // Step 0: Spam filter — discard before calling any LLM
    const isCV = this.spamFilter.check(payload)
    if (!isCV) {
      await this.emailIntakeLog.markSpam(payload.MessageID)
      return
    }

    // Step 1: Extract text from attachments (CPU-bound — safe in worker process)
    const cvText = await this.attachmentExtractor.extract(payload.Attachments)
    const fullText = `${payload.TextBody}\n\n${cvText}`

    // Step 2: AI extraction (Haiku)
    const extracted = await this.emailParserAgent.extract(fullText)

    // Step 3: Upload original file to Cloudflare R2 (before dedup — file must be preserved)
    // tenantId comes from env, not from the Postmark payload (which has no such field)
    const tenantId = this.configService.get<string>('TENANT_ID')
    const fileUrl = await this.storageService.upload(payload.Attachments[0], `cvs/${tenantId}/${payload.MessageID}`)

    // Step 4: Dedup check
    const dupResult = await this.dedupService.check(extracted, tenantId)

    // Step 5: Store — logic depends on dedup result
    let candidateId: string
    if (dupResult?.confidence === 1.0) {
      // Exact email match → safe to upsert (same person re-applying)
      candidateId = await this.candidatesRepository.upsert(extracted, fileUrl, tenantId)
    } else {
      // Fuzzy match OR no match → always INSERT new record
      candidateId = await this.candidatesRepository.insert(extracted, fileUrl, tenantId)
      if (dupResult) {
        // Flag for human review — never auto-merge
        await this.dedupService.createFlag(candidateId, dupResult.match.id, dupResult)
      }
    }

    // Step 6: Enqueue scoring
    await this.scoreQueue.add('score-candidate', { candidateId })
  }
}
```

### Email Intake: Why Postmark Over Gmail

|             | Postmark Inbound                                                                 | Gmail API polling                             |
| :---------- | :------------------------------------------------------------------------------- | :-------------------------------------------- |
| Setup       | Set MX record → receive webhooks                                                 | OAuth2 flow + polling loop + state management |
| Reliability | Push — no missed emails                                                          | Pull — depends on poll interval               |
| Payload     | Parsed JSON (headers, body, attachments)                                         | Raw MIME — parse yourself                     |
| Cost        | Free trial: 100 credits. Paid: ~$15/month for 50k emails. Mailgun: 1k/month free | Free (Gmail API quota)                        |
| Complexity  | Low                                                                              | High                                          |

**Recommendation:** Postmark for Phase 1. If the client insists on an existing Gmail inbox, use Gmail API polling as a fallback — it's a drop-in replacement at the queue level.

### Spam Filter (Step 0)

The intake email address is public-facing. Any spam list or automated sender that discovers `cv@triolla...` will trigger the full pipeline — calling Claude and filling the DB with garbage. A pre-filter costs nothing and runs before any LLM call.

```typescript
// spam-filter.service.ts
check(payload: PostmarkPayloadDto): boolean {
  const hasAttachment = payload.Attachments?.length > 0
  const bodyLength = (payload.TextBody ?? '').trim().length
  const subject = (payload.Subject ?? '').toLowerCase()

  // Hard discard: no attachment and very short body
  if (!hasAttachment && bodyLength < 100) return false

  // Hard discard: obvious marketing keywords in subject
  const spamKeywords = ['unsubscribe', 'newsletter', 'promotion', 'deal', 'offer']
  if (spamKeywords.some(k => subject.includes(k))) return false

  return true
}
```

If heuristics aren't enough, add a second-stage Haiku check (ultra-cheap at ~$0.0001 per call):

```typescript
// Optional: LLM pre-filter for ambiguous cases
const { object } = await generateObject({
  model: anthropic('claude-haiku-4-5'),
  schema: z.object({ isCV: z.boolean() }),
  prompt: `Does this email appear to be a job application or CV submission? Reply true or false only.\n\n${emailText.slice(0, 500)}`,
})
if (!object.isCV) return false
```

---

## 7. AI Agents

Both agents use the Vercel AI SDK with `generateObject` — structured, typed outputs validated by Zod. Swapping the model is a one-line change.

### Agent 1: Email Parser (Haiku)

Runs on every inbound email. Cheap and fast.

```typescript
// email-parser.agent.ts
import { generateObject } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { z } from 'zod'

const CandidateExtractSchema = z.object({
  fullName: z.string(),
  email: z.string().email().nullable(),
  phone: z.string().nullable(),
  currentRole: z.string().nullable(),
  yearsExperience: z.number().int().nullable(),
  skills: z.array(z.string()),
  summary: z.string().nullable(),  // AI-generated 2-sentence summary
  source: z.enum(['direct', 'agency', 'linkedin', 'referral', 'website']).default('direct'),
})

export type CandidateExtract = z.infer<typeof CandidateExtractSchema>

async extract(emailText: string): Promise<CandidateExtract> {
  const { object } = await generateObject({
    model: anthropic('claude-haiku-4-5'),
    schema: CandidateExtractSchema,
    prompt: `Extract candidate information from the following email and CV:\n\n${emailText}`,
  })
  return object
}
```

### Agent 2: Job Scorer (Sonnet)

Runs once per active job, per candidate. Quality matters here.

The scoring processor must first fetch active jobs, create `applications` rows (the `candidate_job_scores` table references `application_id`, not `candidate_id` directly), then insert scores.

```typescript
// scoring.processor.ts
@Processor('score-candidate')
export class ScoringProcessor {
  @Process('score-candidate')
  async process(job: Job<{ candidateId: string }>) {
    const { candidateId } = job.data
    const tenantId = this.configService.get<string>('TENANT_ID')

    const candidate = await this.candidatesRepository.findById(candidateId)
    const activeJobs = await this.jobsRepository.findActive(tenantId)

    for (const activeJob of activeJobs) {
      // Upsert application — creates it on first scoring, is a no-op on retry
      const application = await this.prisma.application.upsert({
        where: { tenantId_candidateId_jobId: { tenantId, candidateId, jobId: activeJob.id } },
        create: { tenantId, candidateId, jobId: activeJob.id, stage: 'new', appliedAt: new Date() },
        update: {},
      })

      const result = await this.jobScorerAgent.score(candidate, activeJob)

      // Append-only — never update existing scores
      await this.prisma.candidateJobScore.create({
        data: {
          tenantId,
          applicationId: application.id,
          score: result.score,
          reasoning: result.reasoning,
          strengths: result.strengths,
          gaps: result.gaps,
          modelUsed: 'claude-sonnet-4-6',
        },
      })
    }
  }
}
```

```typescript
// job-scorer.agent.ts
const ScoringResultSchema = z.object({
  score: z.number().min(0).max(100),
  reasoning: z.string(),
  strengths: z.array(z.string()),
  gaps: z.array(z.string()),
})

async score(candidate: CandidateExtract, job: Job): Promise<ScoringResult> {
  const { object } = await generateObject({
    model: anthropic('claude-sonnet-4-6'),
    schema: ScoringResultSchema,
    prompt: buildScoringPrompt(candidate, job),
  })
  return object
}
```

### Model Strategy

| Task                         | Model               | Cost per CV | Monthly @ 500 CVs |
| :--------------------------- | :------------------ | :---------- | :---------------- |
| Spam filter (optional LLM)   | `claude-haiku-4-5`  | ~$0.0001    | ~$0.05            |
| Email extraction             | `claude-haiku-4-5`  | ~$0.001     | ~$0.50            |
| Job scoring (per active job) | `claude-sonnet-4-6` | ~$0.01      | ~$5–15\*          |
| Duplicate detection          | PostgreSQL — no LLM | $0          | $0                |
| **Total**                    |                     |             | **~$6–16/month**  |

\*Depends on number of active jobs scored per candidate.

**No local models in Phase 1.** At $6–16/month the cost is negligible. Ollama adds RAM requirements (16GB minimum for a 7B model with headroom), operational complexity, and model management overhead. It makes sense when monthly LLM cost exceeds ~$100/month — not now.

**Future model swap:** When/if Ollama is introduced, it's a one-line change per agent:

```typescript
// Before:
model: anthropic('claude-haiku-4-5')
// After:
model: ollama('qwen2.5:7b')
```

---

## 8. Duplicate Detection

Duplicate detection runs **entirely in PostgreSQL** using the built-in `pg_trgm` extension. No candidates are loaded into application memory.

### Setup (once, in migration)

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX idx_candidates_name_trgm ON candidates
  USING GIN (full_name gin_trgm_ops);

CREATE INDEX idx_candidates_phone_trgm ON candidates
  USING GIN (phone gin_trgm_ops);
```

### Detection Logic

```typescript
// dedup.service.ts
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

  return null
}
```

**What happens after dedup:**

| Result                                      | Action                                                |
| :------------------------------------------ | :---------------------------------------------------- |
| No match                                    | `INSERT` new candidate                                |
| Exact email match (`confidence = 1.0`)      | `UPSERT` — same person, update their record           |
| Fuzzy name/phone match (`confidence < 1.0`) | `INSERT` new candidate + create `duplicate_flags` row |

**Never auto-merge on fuzzy match.** "Daniel Shalem" and "Danny Shalem" with different emails could be the same person or two different people. Auto-upserting would silently corrupt data. The `duplicate_flags` table exists precisely so a recruiter can review and decide in Phase 2.

---

## 9. Database Schema

PostgreSQL 16. **7 tables for Phase 1** — `users` is excluded (no human-initiated writes in Phase 1). Every table carries `tenant_id` from day one; Phase 1 has exactly one tenant.

> **Text over ENUMs.** All status/type columns use `text` with CHECK constraints. PostgreSQL ENUMs require a migration to add values; CHECK constraints don't.
> **`updated_at`** is maintained by Prisma's `@updatedAt` directive, not a DB trigger.
> **No binary blobs in the DB.** Original CV files go to Cloudflare R2; only the URL is stored.

---

### `tenants`

One row in Phase 1. Exists to make every other table multi-tenant-ready.

| Column       | Type                   | Notes               |
| :----------- | :--------------------- | :------------------ |
| `id`         | `uuid` PK              | `gen_random_uuid()` |
| `name`       | `text NOT NULL`        | e.g. "Triolla"      |
| `created_at` | `timestamptz NOT NULL` | `now()`             |

---

### `jobs`

Open positions. Created via seed or admin in Phase 1. The scoring worker queries `WHERE status = 'active'`.

| Column           | Type                              | Notes                                    |
| :--------------- | :-------------------------------- | :--------------------------------------- |
| `id`             | `uuid` PK                         |                                          |
| `tenant_id`      | `uuid NOT NULL` FK → `tenants.id` |                                          |
| `title`          | `text NOT NULL`                   |                                          |
| `department`     | `text`                            |                                          |
| `location`       | `text`                            |                                          |
| `job_type`       | `text NOT NULL`                   | `full_time` · `part_time` · `contract`   |
| `status`         | `text NOT NULL` default `'draft'` | `active` · `draft` · `closed` · `paused` |
| `description`    | `text`                            | Full JD text — used in scoring prompt    |
| `requirements`   | `text[]`                          | Bullet list — used in scoring prompt     |
| `salary_range`   | `text`                            | Free text, e.g. "$140k–$175k"            |
| `hiring_manager` | `text`                            | Name only in Phase 1                     |
| `created_at`     | `timestamptz NOT NULL`            |                                          |
| `updated_at`     | `timestamptz NOT NULL`            | `@updatedAt`                             |

---

### `candidates`

One row per person (global talent pool). Created by the ingestion worker.

| Column             | Type                              | Notes                                                     |
| :----------------- | :-------------------------------- | :-------------------------------------------------------- |
| `id`               | `uuid` PK                         |                                                           |
| `tenant_id`        | `uuid NOT NULL` FK → `tenants.id` |                                                           |
| `email`            | `text`                            | Nullable — some CVs lack a visible email                  |
| `full_name`        | `text NOT NULL`                   |                                                           |
| `phone`            | `text`                            |                                                           |
| `current_role`     | `text`                            | AI-extracted                                              |
| `location`         | `text`                            | AI-extracted                                              |
| `years_experience` | `smallint`                        | AI-extracted, approximate                                 |
| `skills`           | `text[]`                          | e.g. `{'React','TypeScript','PostgreSQL'}`                |
| `cv_text`          | `text`                            | Full plain text extracted from PDF/DOCX                   |
| `cv_file_url`      | `text`                            | R2 URL of original PDF/DOCX — set on intake               |
| `source`           | `text NOT NULL`                   | `linkedin` · `website` · `agency` · `referral` · `direct` |
| `source_agency`    | `text`                            | Agency name if `source = 'agency'`                        |
| `source_email`     | `text`                            | `from` address of the inbound email                       |
| `metadata`         | `jsonb`                           | Enrichment data, LinkedIn URL, custom fields              |
| `created_at`       | `timestamptz NOT NULL`            |                                                           |
| `updated_at`       | `timestamptz NOT NULL`            | `@updatedAt`                                              |

**Storage rule:** `cv_text` → PostgreSQL. Original file → Cloudflare R2 (`cvs/{tenantId}/{messageId}`). URL → `cv_file_url`. Postmark does not retain attachments — if the file is not uploaded to R2 on intake, it is lost permanently.

---

### `applications`

Candidate ↔ Job junction. Intake worker creates one row with `stage = 'new'`. Stage transitions are Phase 2.

| Column          | Type                                 | Notes                                                              |
| :-------------- | :----------------------------------- | :----------------------------------------------------------------- |
| `id`            | `uuid` PK                            |                                                                    |
| `tenant_id`     | `uuid NOT NULL` FK → `tenants.id`    |                                                                    |
| `candidate_id`  | `uuid NOT NULL` FK → `candidates.id` | `ON DELETE CASCADE`                                                |
| `job_id`        | `uuid NOT NULL` FK → `jobs.id`       | `ON DELETE CASCADE`                                                |
| `stage`         | `text NOT NULL` default `'new'`      | `new` · `screening` · `interview` · `offer` · `hired` · `rejected` |
| `notes`         | `text`                               | Recruiter notes — writable in Phase 2                              |
| `intake_log_id` | `uuid` FK → `email_intake_log.id`    | Links application to the email that created it                     |
| `applied_at`    | `timestamptz NOT NULL`               | When the email arrived                                             |
| `updated_at`    | `timestamptz NOT NULL`               | `@updatedAt`                                                       |

**UNIQUE:** `(tenant_id, candidate_id, job_id)` — one application per candidate per job.

---

### `candidate_job_scores`

Append-only. Each scoring run inserts a new row. Latest score = `ORDER BY scored_at DESC LIMIT 1`.

| Column           | Type                                   | Notes                             |
| :--------------- | :------------------------------------- | :-------------------------------- |
| `id`             | `uuid` PK                              |                                   |
| `tenant_id`      | `uuid NOT NULL` FK → `tenants.id`      |                                   |
| `application_id` | `uuid NOT NULL` FK → `applications.id` | `ON DELETE CASCADE`               |
| `score`          | `smallint NOT NULL`                    | `CHECK (score BETWEEN 0 AND 100)` |
| `reasoning`      | `text`                                 | Plain English explanation from AI |
| `strengths`      | `text[]`                               | AI-identified strengths           |
| `gaps`           | `text[]`                               | AI-identified gaps                |
| `model_used`     | `text NOT NULL`                        | e.g. `claude-sonnet-4-6`          |
| `scored_at`      | `timestamptz NOT NULL`                 | `now()`                           |

---

### `duplicate_flags`

Created by the dedup worker when fuzzy-match confidence > 0.7. Recruiter reviews in Phase 2.

| Column                 | Type                                 | Notes                                              |
| :--------------------- | :----------------------------------- | :------------------------------------------------- |
| `id`                   | `uuid` PK                            |                                                    |
| `tenant_id`            | `uuid NOT NULL` FK → `tenants.id`    |                                                    |
| `candidate_id`         | `uuid NOT NULL` FK → `candidates.id` | `ON DELETE RESTRICT` — newly ingested              |
| `matched_candidate_id` | `uuid NOT NULL` FK → `candidates.id` | `ON DELETE RESTRICT` — existing candidate          |
| `confidence`           | `numeric(4,3) NOT NULL`              | `CHECK (confidence BETWEEN 0 AND 1)`, e.g. `0.920` |
| `match_fields`         | `text[] NOT NULL`                    | e.g. `{'name'}`, `{'email','name'}`                |
| `reviewed`             | `boolean NOT NULL` default `false`   | Set true when recruiter dismisses                  |
| `created_at`           | `timestamptz NOT NULL`               |                                                    |

**UNIQUE:** `(tenant_id, candidate_id, matched_candidate_id)` — prevents duplicate flags on worker retries.

---

### `email_intake_log`

One row per inbound email. Dual purpose: idempotency guard + audit trail.

| Column              | Type                                | Notes                                                      |
| :------------------ | :---------------------------------- | :--------------------------------------------------------- |
| `id`                | `uuid` PK                           |                                                            |
| `tenant_id`         | `uuid NOT NULL` FK → `tenants.id`   |                                                            |
| `message_id`        | `text NOT NULL`                     | Email `Message-ID` header — UNIQUE per tenant              |
| `from_email`        | `text NOT NULL`                     | Sender address                                             |
| `subject`           | `text`                              |                                                            |
| `received_at`       | `timestamptz NOT NULL`              | Timestamp from email headers                               |
| `processing_status` | `text NOT NULL` default `'pending'` | `pending` · `processing` · `completed` · `failed` · `spam` |
| `error_message`     | `text`                              | Populated if `status = 'failed'`                           |
| `candidate_id`      | `uuid` FK → `candidates.id`         | Set after successful processing                            |
| `raw_payload`       | `jsonb`                             | Full Postmark JSON — **attachment blobs stripped**         |
| `created_at`        | `timestamptz NOT NULL`              |                                                            |

**UNIQUE:** `(tenant_id, message_id)` — primary idempotency guard.

---

### Indexes

```sql
-- pg_trgm for fuzzy dedup (run once in migration)
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_candidates_name_trgm  ON candidates USING GIN (full_name gin_trgm_ops);
CREATE INDEX idx_candidates_phone_trgm ON candidates USING GIN (phone gin_trgm_ops);

-- Unique email per tenant (exact-match dedup + constraint)
CREATE UNIQUE INDEX idx_candidates_email
  ON candidates (tenant_id, email) WHERE email IS NOT NULL;

-- Jobs — scoring worker fetches active jobs
CREATE INDEX idx_jobs_active ON jobs (tenant_id, status);

-- Applications — pipeline views, stage filters
CREATE UNIQUE INDEX idx_applications_unique ON applications (tenant_id, candidate_id, job_id);
CREATE INDEX idx_applications_job         ON applications (job_id);
CREATE INDEX idx_applications_stage       ON applications (tenant_id, stage);

-- Scores — latest score lookup
CREATE INDEX idx_scores_application ON candidate_job_scores (application_id);

-- Duplicate flags — recruiter review queue
CREATE UNIQUE INDEX idx_duplicates_pair      ON duplicate_flags (tenant_id, candidate_id, matched_candidate_id);
CREATE INDEX        idx_duplicates_unreviewed ON duplicate_flags (tenant_id, reviewed) WHERE reviewed = false;

-- Idempotency
CREATE UNIQUE INDEX idx_intake_message_id ON email_intake_log (tenant_id, message_id);
-- Retry/monitoring: find failed or pending jobs
CREATE INDEX idx_intake_status ON email_intake_log (processing_status)
  WHERE processing_status IN ('pending', 'failed');
```

---

## 10. Infrastructure & Deployment

### Docker Compose

```yaml
# docker-compose.yml
services:
  api:
    build: .
    ports: ['3000:3000']
    env_file: .env
    depends_on: [postgres, redis]

  worker:
    build: .
    command: node dist/worker.js # separate BullMQ worker entry point
    env_file: .env
    depends_on: [postgres, redis]

  postgres:
    image: postgres:16-alpine
    volumes: ['postgres_data:/var/lib/postgresql/data']
    environment:
      POSTGRES_DB: triolla
      POSTGRES_USER: triolla
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}

  redis:
    image: redis:7-alpine
    volumes: ['redis_data:/data']

volumes:
  postgres_data:
  redis_data:
```

### VPS vs AWS

**Phase 1: Hetzner CX21** (~€5/month, 2 vCPU, 4GB RAM)

Without Ollama, the full stack (API + worker + Redis + Postgres) uses ~1.5–2GB RAM. A 4GB VPS provides comfortable headroom.

|                       | Hetzner CX21           | AWS EC2 t3.small         |
| :-------------------- | :--------------------- | :----------------------- |
| Monthly cost          | ~€5                    | ~$15                     |
| RAM                   | 4GB                    | 2GB                      |
| Setup time            | 30–60 min              | 2–4 hours                |
| Local LLMs later      | Upgrade to CX41 (16GB) | GPU instance — expensive |
| Enterprise compliance | No                     | SOC2, ISO 27001          |

**Switch to AWS when:**

- Paying customers requiring SOC2 or data residency SLAs
- Need auto-scaling across multiple tenants
- Team already in AWS ecosystem

The Docker Compose setup runs identically on both — migration is under an hour.

### Environment Variables

```bash
# .env.example
DATABASE_URL=postgresql://triolla:password@postgres:5432/triolla
REDIS_URL=redis://redis:6379
ANTHROPIC_API_KEY=sk-ant-...
POSTMARK_WEBHOOK_TOKEN=...          # for HMAC signature verification
TENANT_ID=...                       # single tenant ID for Phase 1
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=triolla-cvs
NODE_ENV=production
```

---

## 11. What's Not in Phase 1

| Feature                         | When                                             |
| :------------------------------ | :----------------------------------------------- |
| Recruiter-facing REST API       | Phase 2 — after intake pipeline is stable        |
| Authentication (JWT / Clerk)    | Phase 2 — no human-initiated requests in Phase 1 |
| UI integration                  | Phase 2                                          |
| Outbound email / outreach agent | Phase 2                                          |
| Voice screening                 | Phase 2                                          |
| Local LLM (Ollama)              | Phase 2+ — only if monthly LLM cost > ~$100      |
| Multi-tenant registration flow  | Phase 2                                          |
| Fine-tuning / RAG               | Future                                           |

Phase 1 is purely reactive: receive email → process → store. No human in the loop.

---

## 12. Open Questions

Not blockers for Phase 1, but decide before Phase 2:

| Question            | Options                                           | Notes                                    |
| :------------------ | :------------------------------------------------ | :--------------------------------------- |
| **Outbound email**  | Postmark transactional · AWS SES                  | Needed for outreach agent in Phase 2     |
| **Recruiter auth**  | Clerk · Supabase Auth · custom JWT                | Phase 2 — no human requests in Phase 1   |
| **Voice screening** | Deepgram API · Whisper (local)                    | PRD mentions voice; not in Phase 1 scope |
| **Monitoring**      | Sentry (errors) · BullMQ dashboard (queue health) | Recommended from day 1                   |

---

_Phase 1 is a single, well-defined capability: automated email intake. NestJS provides the structure to grow this into a full product without a rewrite. The stack is 100% TypeScript, AI cost is ~$10/month, and infra cost is ~€5/month._
