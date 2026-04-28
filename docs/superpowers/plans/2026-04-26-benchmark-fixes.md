# Benchmark Fixes: Security, Reliability & AI Quality

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all confirmed bugs and high-priority findings from benchmark/opus4.7.md, verified by a second-opinion review.

**Architecture:** Four sequential phases (P0 → P1 → P2) plus one independent phase (P3). P0 is low-risk security/quality fixes. P1 moves base64 payloads from Redis to R2 — a data-flow change requiring a DB migration. P2 switches AI calls to structured output and adds R2 caching, gated on P1 being live. P3 parallelises scoring independently.

**Tech Stack:** NestJS 11, BullMQ, Prisma 7, PostgreSQL 16, @aws-sdk/client-s3 (R2), @openrouter/sdk, ai SDK (already installed), @openrouter/ai-sdk-provider (to install in P2)

---

## Findings addressed

**From benchmark/opus4.7.md:**

| ID  | Severity                                                     | Fix in |
| --- | ------------------------------------------------------------ | ------ |
| H1  | Security — auth truncation allows token+junk to authenticate | Task 1 |
| H4  | High — OpenRouter client new'd per AI call                   | Task 2 |
| M5  | Medium — ThrottlerGuard runs before auth                     | Task 2 |
| M6  | Medium — dual loggers (NestJS + pino) in processor           | Task 2 |
| C1  | Critical — base64 CV payloads in Redis (~99% memory waste)   | Task 3 |
| M3  | Medium — R2 orphan if Phase 6 fails (fixed as part of C1)    | Task 3 |
| H5  | High — markdown-strip + JSON.parse hack for AI output        | Task 4 |
| C2  | Critical — AI extraction re-runs on every BullMQ retry       | Task 4 |
| H3  | High — scoring loop is sequential (N jobs × 3–8 s each)      | Task 5 |

**From benchmark/kimi2.6.md (safe fixes only, no breaking changes):**

| ID   | Severity                                                              | Fix in |
| ---- | --------------------------------------------------------------------- | ------ |
| K-C1 | Critical — `CandidateJobScore` no unique constraint → duplicates on retry | Task 6 |
| K-C2 | Critical — partial unique email index promised in schema comment but missing | Task 7 |
| K-M1 | Medium — `'openai/gpt-4o-mini'` hardcoded in 4+ places               | Task 8 |
| K-H1 | High — failed BullMQ jobs silently removed, no visibility             | Task 9 |

**Skipped from opus4.7.md:** sandboxed processors (breaks NestJS DI), candidate_ranked view (requires full query audit), multi-tenant slug (needs Postmark dashboard change), WS gateway (out of scope), OTel/Prom metrics (future phase).

**Skipped from kimi2.6.md:** circuit breaker on OpenRouter (adds opossum dep), split scoring queue (architectural change), `cvFileUrl` rename (breaking schema + code rename), worker health HTTP endpoint (NestJS shutdown hooks already handle graceful close via `WorkerHost.onApplicationShutdown`).

---

## File Map

| File                                                      | Change                                                                              |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `src/webhooks/guards/postmark-auth.guard.ts`              | H1 fix                                                                              |
| `src/webhooks/guards/postmark-auth.guard.spec.ts`         | add truncation regression test                                                      |
| `src/webhooks/webhooks.controller.ts`                     | M5: swap guard order                                                                |
| `src/ingestion/services/extraction-agent.service.ts`      | H4: singleton client; P2: generateObject + R2 cache                                 |
| `src/ingestion/services/extraction-agent.service.spec.ts` | update mocks for P2                                                                 |
| `src/scoring/scoring.service.ts`                          | H4: singleton client; P2: generateObject                                            |
| `src/storage/storage.service.ts`                          | P1: uploadPayload/downloadPayload; P2: saveExtractionCache/loadExtractionCache      |
| `src/webhooks/webhooks.service.ts`                        | P1: upload to R2, enqueue {tenantId,messageId}                                      |
| `src/webhooks/webhooks.module.ts`                         | P1: import StorageModule                                                            |
| `src/ingestion/ingestion.module.ts`                       | P1/P2: StorageService already available via StorageModule                           |
| `src/ingestion/ingestion.processor.ts`                    | M6: single logger; P1: read payload from R2; P2: no AI re-run; P3: parallel scoring |
| `prisma/schema.prisma`                                    | P1: add rawPayloadKey, cvFileKey to EmailIntakeLog                                  |
| `prisma/migrations/…`                                     | P1: migration SQL                                                                   |

---

## Task 1: Fix H1 Auth Guard Token Truncation (security, standalone)

**Files:**

- Modify: `src/webhooks/guards/postmark-auth.guard.ts:31-35`
- Modify: `src/webhooks/guards/postmark-auth.guard.spec.ts`

**Bug:** `Buffer.alloc(expected.length)` + `.copy()` silently truncates a longer provided password to `expected.length` bytes before comparing. The length check on line 35 always passes (both bufs are `expected.length`). Result: `correct_token` + any suffix authenticates.

- [ ] **Step 1: Write the regression test first**

Add to `src/webhooks/guards/postmark-auth.guard.spec.ts` after the existing three tests:

```ts
it('rejects token with correct prefix followed by extra characters — truncation attack blocked', () => {
  const malicious = Buffer.from('user:test-tokenEXTRA_JUNK').toString('base64');
  const ctx = buildContext(`Basic ${malicious}`);
  expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
});
```

- [ ] **Step 2: Run test to confirm it currently FAILS (demonstrating the bug)**

```bash
cd /Users/danielshalem/triolla/talento/talent-os-backend
npx jest src/webhooks/guards/postmark-auth.guard.spec.ts --no-coverage 2>&1 | tail -20
```

Expected: one test fails with "Expected function to throw, received no exception" (or similar).

- [ ] **Step 3: Apply the fix**

In `src/webhooks/guards/postmark-auth.guard.ts`, replace lines 31–35:

```ts
// BEFORE (broken):
const providedBuf = Buffer.alloc(expected.length);
Buffer.from(password).copy(providedBuf);
const expectedBuf = Buffer.from(expected);

if (providedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
  throw new UnauthorizedException('Invalid webhook credentials');
}
```

```ts
// AFTER (fixed):
const providedBuf = Buffer.from(password);
const expectedBuf = Buffer.from(expected);

if (providedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
  throw new UnauthorizedException('Invalid webhook credentials');
}
```

The fix removes `Buffer.alloc` + `.copy()` entirely. `Buffer.from(password)` preserves the full length. The `length !==` check now correctly rejects longer tokens.

- [ ] **Step 4: Run all guard tests**

```bash
npx jest src/webhooks/guards/postmark-auth.guard.spec.ts --no-coverage 2>&1 | tail -20
```

Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/webhooks/guards/postmark-auth.guard.ts src/webhooks/guards/postmark-auth.guard.spec.ts
git commit -m "fix(auth): correct timing-safe comparison — reject tokens with correct prefix + extra bytes"
```

---

## Task 2: P0 Quality Fixes (H4 singleton clients, M5 guard order, M6 single logger)

**Files:**

- Modify: `src/ingestion/services/extraction-agent.service.ts`
- Modify: `src/scoring/scoring.service.ts`
- Modify: `src/webhooks/webhooks.controller.ts`
- Modify: `src/ingestion/ingestion.processor.ts`

### Step group: H4 — Singleton OpenRouter client in ExtractionAgentService

- [ ] **Step 1: Move OpenRouter instantiation to constructor in extraction-agent.service.ts**

In `src/ingestion/services/extraction-agent.service.ts`, change:

```ts
// BEFORE: class body
@Injectable()
export class ExtractionAgentService {
  private readonly logger = new Logger(ExtractionAgentService.name);

  constructor(private readonly config: ConfigService) {}

  // ... in callAI():
  private async callAI(...): Promise<...> {
    const apiKey = this.config.get<string>('OPENROUTER_API_KEY')!;
    const client = new OpenRouter({ apiKey });
    // uses `client.callModel`
  }
```

```ts
// AFTER:
@Injectable()
export class ExtractionAgentService {
  private readonly logger = new Logger(ExtractionAgentService.name);
  private readonly client: OpenRouter;

  constructor(private readonly config: ConfigService) {
    this.client = new OpenRouter({ apiKey: config.get<string>('OPENROUTER_API_KEY')! });
  }

  // In callAI() — remove the two apiKey/client lines, replace `client.` with `this.client.`:
  private async callAI(...): Promise<...> {
    // deleted: const apiKey = ...
    // deleted: const client = new OpenRouter({ apiKey });
    const result = this.client.callModel({ ... });
```

- [ ] **Step 2: Same for ScoringAgentService**

In `src/scoring/scoring.service.ts`, change:

```ts
// BEFORE: class body
@Injectable()
export class ScoringAgentService {
  private readonly logger = new Logger(ScoringAgentService.name);

  constructor(private readonly config: ConfigService) {}

  async score(input: ScoringInput): Promise<ScoreResult & { modelUsed: string }> {
    const apiKey = this.config.get<string>('OPENROUTER_API_KEY')!;
    const client = new OpenRouter({ apiKey });
    // uses `client.callModel`
```

```ts
// AFTER:
@Injectable()
export class ScoringAgentService {
  private readonly logger = new Logger(ScoringAgentService.name);
  private readonly client: OpenRouter;

  constructor(private readonly config: ConfigService) {
    this.client = new OpenRouter({ apiKey: config.get<string>('OPENROUTER_API_KEY')! });
  }

  async score(input: ScoringInput): Promise<ScoreResult & { modelUsed: string }> {
    // deleted: const apiKey = ...
    // deleted: const client = new OpenRouter({ apiKey });
    const result = this.client.callModel({ ... });
```

- [ ] **Step 3: Run tests to confirm nothing regressed**

```bash
npx jest src/ingestion/services/extraction-agent.service.spec.ts src/scoring/scoring.service.spec.ts --no-coverage 2>&1 | tail -20
```

Expected: all tests pass. (The mock is at module level — `jest.mock('@openrouter/sdk', ...)` — so it continues to work with the constructor-level instantiation.)

### Step group: M5 — Fix throttler/auth guard order

- [ ] **Step 4: Swap guard order in webhooks.controller.ts**

In `src/webhooks/webhooks.controller.ts` line 11:

```ts
// BEFORE:
@UseGuards(ThrottlerGuard, PostmarkAuthGuard)
```

```ts
// AFTER:
@UseGuards(PostmarkAuthGuard, ThrottlerGuard)
```

Auth guard now runs first. Postmark's IPs won't consume rate-limit slots before being authenticated.

### Step group: M6 — Single logger in IngestionProcessor

- [ ] **Step 5: Replace NestJS Logger with pino in ingestion.processor.ts**

Remove the NestJS Logger import and field; replace all `this.logger.*` calls with `this.pinoLogger.*`.

**Remove from imports:**

```ts
// BEFORE:
import { Logger } from '@nestjs/common';
```

```ts
// AFTER: (remove Logger from @nestjs/common import entirely, or keep other imports)
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger as PinoLogger } from 'nestjs-pino';
// ... (no Logger import from @nestjs/common)
```

**Remove from class body:**

```ts
// BEFORE:
private readonly logger = new Logger(IngestionProcessor.name);
```

```ts
// AFTER: (delete that line entirely)
```

**Replace every `this.logger.*` call** — use structured pino format `(context_object, 'message')`:

```ts
// Pattern: this.logger.log('text') → this.pinoLogger.log({ messageId: payload.MessageID }, 'text')
// Pattern: this.logger.error('text', err.stack) → this.pinoLogger.error({ messageId, error: err.message }, 'text')
// Pattern: this.logger.warn('text') → this.pinoLogger.warn({ messageId }, 'text')
// Pattern: this.logger.debug('text') → this.pinoLogger.debug({ messageId }, 'text')
```

Full replacement table — apply each one:

| BEFORE                                                                                                                    | AFTER                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `this.logger.log(\`Processing job ${job.id} for MessageID: ${payload.MessageID}\`)`                                       | `this.pinoLogger.log({ jobId: job.id, messageId: payload.MessageID }, 'Job processing started')`                                                                  |
| `this.logger.log(\`Spam filter rejected MessageID: ${payload.MessageID}\`)`                                               | `this.pinoLogger.log({ messageId: payload.MessageID }, 'Spam filter rejected')`                                                                                   |
| `this.logger.log(\`Phase 5 complete for MessageID: ${payload.MessageID} — fileKey: ${fileKey ?? 'none'}\`)`               | `this.pinoLogger.log({ messageId: payload.MessageID, fileKey: fileKey ?? null }, 'Phase 5 complete')`                                                             |
| `this.logger.warn(\`AI extraction failed on final attempt for ${payload.MessageID} — trying deterministic fallback\`)`    | `this.pinoLogger.warn({ messageId: payload.MessageID }, 'AI extraction failed on final attempt — trying deterministic fallback')`                                 |
| `this.logger.error(\`Both AI and deterministic extraction failed for ${payload.MessageID}: ${...}\`)`                     | `this.pinoLogger.error({ messageId: payload.MessageID, error: (fallbackErr as Error).message }, 'Both AI and deterministic extraction failed')`                   |
| `this.logger.error(\`Extraction failed for MessageID: ${payload.MessageID} (attempt ${job.attemptsMade + 1}) — ${...}\`)` | `this.pinoLogger.error({ messageId: payload.MessageID, attempt: job.attemptsMade + 1, error: (err as Error).message }, 'Extraction failed')`                      |
| `this.logger.error(\`Extraction returned empty fullName for MessageID: ${payload.MessageID}\`)`                           | `this.pinoLogger.error({ messageId: payload.MessageID }, 'Extraction returned empty fullName')`                                                                   |
| `this.logger.log(\`Phase 4 complete for MessageID: ${payload.MessageID} — extracted: ${extraction!.full_name}\`)`         | `this.pinoLogger.log({ messageId: payload.MessageID, fullName: extraction!.full_name }, 'Phase 4 complete')`                                                      |
| `this.logger.log(\`Idempotency guard: intake ... already has candidateId ...\`)`                                          | `this.pinoLogger.log({ messageId: payload.MessageID, candidateId: existingIntake.candidateId }, 'Idempotency guard: skipping Phase 6')`                           |
| `this.logger.error(\`Dedup check failed for MessageID: ${payload.MessageID} — ${...}\`, ...)`                             | `this.pinoLogger.error({ messageId: payload.MessageID, error: (err as Error).message }, 'Dedup check failed')`                                                    |
| `this.logger.error(\`Phase 6 transaction failed for MessageID: ${payload.MessageID} — ${...}\`, ...)`                     | `this.pinoLogger.error({ messageId: payload.MessageID, error: (err as Error).message }, 'Phase 6 transaction failed')`                                            |
| `this.logger.log(\`Phase 6 complete for MessageID: ${payload.MessageID} — candidateId: ${candidateId}\`)`                 | `this.pinoLogger.log({ messageId: payload.MessageID, candidateId }, 'Phase 6 complete')`                                                                          |
| `this.logger.log(\`Phase 15: Found ${matchedJobs.length} matching job(s) ...\`)`                                          | `this.pinoLogger.log({ messageId: payload.MessageID, count: matchedJobs.length }, 'Phase 15: matched jobs found')`                                                |
| `this.logger.debug(\`Phase 15: No matching job short_ids found in email text ...\`)`                                      | `this.pinoLogger.debug({ messageId: payload.MessageID }, 'Phase 15: no matching job short_ids')`                                                                  |
| `this.logger.log(\`No matching jobs for MessageID: ${payload.MessageID} — skipping scoring\`)`                            | `this.pinoLogger.log({ messageId: payload.MessageID }, 'No matching jobs — skipping scoring')`                                                                    |
| `this.logger.error(\`Scoring failed for candidateId: ... jobId: ... — ${...}\`)`                                          | `this.pinoLogger.error({ messageId: payload.MessageID, candidateId: context.candidateId, jobId: activeJob.id, error: (err as Error).message }, 'Scoring failed')` |
| `this.logger.log(\`Phase 7 scored candidateId: ... against jobId: ... — score: ${scoreResult.score}\`)`                   | `this.pinoLogger.log({ messageId: payload.MessageID, candidateId: context.candidateId, jobId: activeJob.id, score: scoreResult.score }, 'Phase 7 scored')`        |
| `this.logger.log(\`Phase 7 complete for MessageID: ${payload.MessageID} — pipeline finished\`)`                           | (already using pinoLogger for completion — verify `pinoLogger.log({ jobId, jobName, tenantId }, 'Job completed')` is intact)                                      |

- [ ] **Step 6: Run the full test suite**

```bash
npx jest --no-coverage 2>&1 | tail -30
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/ingestion/services/extraction-agent.service.ts src/scoring/scoring.service.ts src/webhooks/webhooks.controller.ts src/ingestion/ingestion.processor.ts
git commit -m "fix(p0): singleton OpenRouter clients, auth-before-throttler guard order, single pino logger in processor"
```

---

## Task 3: P1 — R2-Based Payload (C1 + M3)

**Files:**

- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_add_intake_r2_keys/migration.sql`
- Modify: `src/storage/storage.service.ts`
- Modify: `src/webhooks/webhooks.module.ts`
- Modify: `src/webhooks/webhooks.service.ts`
- Modify: `src/ingestion/ingestion.processor.ts`

**What changes:** The webhook now uploads the full payload JSON (with base64 attachments) + the CV file to R2 before inserting the DB row. It enqueues only `{ tenantId, messageId }`. The worker downloads the full payload from R2 at the start of `process()`. Redis holds ~100 bytes per job instead of 2–3 MB.

**Deployment note:** This changes the BullMQ job data shape from `PostmarkPayloadDto` to `{ tenantId, messageId }`. Any jobs enqueued by the old webhook format (with full payload) will fail to find a payload.json in R2. Safe deployment requires draining the queue before this ships (let all pending jobs complete, then deploy). In dev, flush Redis: `docker exec -it redis redis-cli FLUSHDB`.

### Step group: Schema migration

- [ ] **Step 1: Add rawPayloadKey and cvFileKey columns to EmailIntakeLog in schema.prisma**

In `prisma/schema.prisma`, inside the `EmailIntakeLog` model, add after `rawPayload`:

```prisma
model EmailIntakeLog {
  id               String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  tenantId         String   @map("tenant_id") @db.Uuid
  messageId        String   @map("message_id") @db.Text
  fromEmail        String   @map("from_email") @db.Text
  subject          String?  @db.Text
  receivedAt       DateTime @map("received_at") @db.Timestamptz
  processingStatus String   @default("pending") @map("processing_status") @db.Text
  errorMessage     String?  @map("error_message") @db.Text
  candidateId      String?  @map("candidate_id") @db.Uuid
  rawPayload       Json?    @map("raw_payload") @db.JsonB
  rawPayloadKey    String?  @map("raw_payload_key") @db.Text
  cvFileKey        String?  @map("cv_file_key") @db.Text
  createdAt        DateTime @default(now()) @map("created_at") @db.Timestamptz

  // ... rest unchanged
}
```

- [ ] **Step 2: Create migration file**

Create file `prisma/migrations/<timestamp>_add_intake_r2_keys/migration.sql` where `<timestamp>` is the current datetime (e.g., `20260426120000_add_intake_r2_keys`):

```sql
-- Add R2 storage keys to email_intake_log
-- raw_payload_key: R2 path to full payload JSON (with base64 attachments)
-- cv_file_key:     R2 path to uploaded CV file (null if email has no CV attachment)
ALTER TABLE "email_intake_log" ADD COLUMN "raw_payload_key" TEXT;
ALTER TABLE "email_intake_log" ADD COLUMN "cv_file_key" TEXT;
```

- [ ] **Step 3: Run migration**

```bash
npm run db:migrate
```

Expected output: `The following migration(s) have been applied: add_intake_r2_keys`

Verify in DB:

```bash
docker exec -it postgres psql -U postgres -d talentosdb -c "\d email_intake_log"
```

Expected: columns `raw_payload_key` and `cv_file_key` visible.

### Step group: StorageService additions

- [ ] **Step 4: Add uploadPayload and downloadPayload to StorageService**

Add to `src/storage/storage.service.ts` (after existing methods):

```ts
import { PostmarkPayloadDto } from '../webhooks/dto/postmark-payload.dto';

// Upload full Postmark payload JSON (including base64 attachments) to R2.
// Returns the R2 key. Errors propagate — caller handles retry semantics.
async uploadPayload(payload: PostmarkPayloadDto, tenantId: string, messageId: string): Promise<string> {
  const key = `emails/${tenantId}/${messageId}/payload.json`;
  await this.s3Client.send(
    new PutObjectCommand({
      Bucket: this.config.get<string>('R2_BUCKET_NAME')!,
      Key: key,
      Body: JSON.stringify(payload),
      ContentType: 'application/json',
    }),
  );
  this.logger.log(`Uploaded payload ${key} to R2`);
  return key;
}

// Download and parse the Postmark payload JSON from R2.
// Throws if the key does not exist (unexpected — the webhook always uploads before enqueueing).
async downloadPayload(tenantId: string, messageId: string): Promise<PostmarkPayloadDto> {
  const key = `emails/${tenantId}/${messageId}/payload.json`;
  const response = await this.s3Client.send(
    new GetObjectCommand({
      Bucket: this.config.get<string>('R2_BUCKET_NAME')!,
      Key: key,
    }),
  );
  const body = await response.Body!.transformToString();
  return JSON.parse(body) as PostmarkPayloadDto;
}
```

- [ ] **Step 5: Write unit tests for uploadPayload and downloadPayload**

In `src/storage/storage.service.spec.ts`, add:

```ts
describe('uploadPayload / downloadPayload', () => {
  it('uploadPayload calls PutObjectCommand with correct key and JSON body', async () => {
    // Arrange
    const mockSend = jest.fn().mockResolvedValue({});
    const service = makeService(mockSend);
    const payload = { MessageID: 'msg-1', From: 'a@b.com' } as any;

    // Act
    const key = await service.uploadPayload(payload, 'tenant-1', 'msg-1');

    // Assert
    expect(key).toBe('emails/tenant-1/msg-1/payload.json');
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          Key: 'emails/tenant-1/msg-1/payload.json',
          ContentType: 'application/json',
        }),
      }),
    );
  });

  it('downloadPayload fetches and parses the payload from R2', async () => {
    // Arrange
    const payload = { MessageID: 'msg-1', From: 'a@b.com' };
    const mockSend = jest.fn().mockResolvedValue({
      Body: { transformToString: jest.fn().mockResolvedValue(JSON.stringify(payload)) },
    });
    const service = makeService(mockSend);

    // Act
    const result = await service.downloadPayload('tenant-1', 'msg-1');

    // Assert
    expect(result).toEqual(payload);
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ Key: 'emails/tenant-1/msg-1/payload.json' }),
      }),
    );
  });
});
```

Note: `makeService(mockSend)` is a test helper — check `src/storage/storage.service.spec.ts` for the existing helper pattern and follow it.

- [ ] **Step 6: Run storage tests**

```bash
npx jest src/storage/storage.service.spec.ts --no-coverage 2>&1 | tail -20
```

Expected: all tests pass.

### Step group: WebhooksModule + WebhooksService

- [ ] **Step 7: Import StorageModule in WebhooksModule**

Replace `src/webhooks/webhooks.module.ts` with:

```ts
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { PostmarkAuthGuard } from './guards/postmark-auth.guard';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [BullModule.registerQueue({ name: 'ingest-email' }), StorageModule],
  controllers: [WebhooksController],
  providers: [WebhooksService, PostmarkAuthGuard],
})
export class WebhooksModule {}
```

- [ ] **Step 8: Update WebhooksService to upload to R2 and enqueue reference only**

Replace `src/webhooks/webhooks.service.ts` with:

```ts
import { Injectable, InternalServerErrorException, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { PostmarkPayloadDto } from './dto/postmark-payload.dto';
import { StorageService } from '../storage/storage.service';

export interface IngestJobData {
  tenantId: string;
  messageId: string;
}

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('ingest-email') private readonly ingestQueue: Queue,
    private readonly configService: ConfigService,
    private readonly storageService: StorageService,
  ) {}

  async enqueue(payload: PostmarkPayloadDto): Promise<{ status: string }> {
    const tenantId = this.configService.get<string>('TENANT_ID')!;
    const messageId = payload.MessageID;

    if (messageId === '00000000-0000-0000-0000-000000000000') {
      this.logger.log('Skipping Postmark test payload (Ping)');
      return { status: 'queued' };
    }

    const existing = await this.prisma.emailIntakeLog.findUnique({
      where: { idx_intake_message_id: { tenantId, messageId } },
      select: { processingStatus: true },
    });

    if (existing) {
      if (existing.processingStatus === 'pending') {
        // Payload is already in R2 from the first attempt — just re-enqueue the reference
        await this.ingestQueue.add('ingest-email', { tenantId, messageId } satisfies IngestJobData, {
          jobId: messageId,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        });
        this.logger.log(`Re-enqueued job for MessageID: ${messageId}`);
      } else {
        this.logger.log(`Skipping duplicate MessageID: ${messageId} (status: ${existing.processingStatus})`);
      }
      return { status: 'queued' };
    }

    // Upload full payload JSON to R2 BEFORE inserting DB row.
    // If R2 upload fails → return 5xx → Postmark retries → no orphaned DB row created.
    const rawPayloadKey = await this.storageService.uploadPayload(payload, tenantId, messageId);

    // Upload CV attachment to R2 (moved from worker Phase 5 — fixes M3 orphan risk).
    const cvFileKey = await this.storageService.upload(payload.Attachments ?? [], tenantId, messageId);

    // INSERT intake log row BEFORE enqueueing — idempotency guard (WBHK-04).
    const sanitizedPayload = this.stripAttachmentBlobs(payload);
    try {
      await this.prisma.emailIntakeLog.create({
        data: {
          tenantId,
          messageId,
          fromEmail: payload.From,
          subject: payload.Subject ?? '',
          receivedAt: new Date(payload.Date),
          processingStatus: 'pending',
          rawPayload: sanitizedPayload as object,
          rawPayloadKey,
          cvFileKey: cvFileKey ?? null,
        },
      });
    } catch (err) {
      if ((err as any)?.code === 'P2002') {
        this.logger.log(`Concurrent duplicate for MessageID: ${messageId} — skipping`);
        return { status: 'queued' };
      }
      throw err;
    }

    // Enqueue only the reference — fixes C1 (no base64 in Redis).
    try {
      await this.ingestQueue.add('ingest-email', { tenantId, messageId } satisfies IngestJobData, {
        jobId: messageId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      });
    } catch (error) {
      this.logger.error(`Failed to enqueue job for MessageID: ${messageId}`, error);
      throw new InternalServerErrorException('Failed to enqueue job');
    }

    this.logger.log(`Enqueued job for MessageID: ${messageId}`);
    return { status: 'queued' };
  }

  async checkHealth(): Promise<{ status: string; db: string; redis: string }> {
    let dbStatus = 'ok';
    let redisStatus = 'ok';

    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      dbStatus = 'error';
    }

    try {
      const client = await this.ingestQueue.client;
      await client.ping();
    } catch {
      redisStatus = 'error';
    }

    const overallStatus = dbStatus === 'ok' && redisStatus === 'ok' ? 'ok' : 'degraded';

    if (overallStatus === 'degraded') {
      throw new HttpException(
        { status: overallStatus, db: dbStatus, redis: redisStatus },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    return { status: overallStatus, db: dbStatus, redis: redisStatus };
  }

  private stripAttachmentBlobs(payload: PostmarkPayloadDto): Omit<PostmarkPayloadDto, 'Attachments'> & {
    Attachments: Omit<NonNullable<PostmarkPayloadDto['Attachments']>[number], 'Content'>[];
  } {
    return {
      ...payload,
      Attachments: (payload.Attachments ?? []).map(({ Content: _content, ...meta }) => meta),
    };
  }
}
```

### Step group: Update IngestionProcessor for P1

- [ ] **Step 9: Update IngestionProcessor to read payload from R2**

In `src/ingestion/ingestion.processor.ts`, make these changes:

**Change imports** — remove ConfigService (no longer needed for tenantId):

```ts
// BEFORE:
import { ConfigService } from '@nestjs/config';
```

```ts
// AFTER: remove ConfigService import
```

**Change constructor** — remove `config: ConfigService`, `storageService` is already available via StorageModule:

```ts
// BEFORE:
constructor(
  private readonly spamFilter: SpamFilterService,
  private readonly attachmentExtractor: AttachmentExtractorService,
  private readonly prisma: PrismaService,
  private readonly config: ConfigService,
  private readonly extractionAgent: ExtractionAgentService,
  private readonly storageService: StorageService,
  private readonly dedupService: DedupService,
  private readonly scoringService: ScoringAgentService,
  private readonly pinoLogger: PinoLogger,
) {
```

```ts
// AFTER:
constructor(
  private readonly spamFilter: SpamFilterService,
  private readonly attachmentExtractor: AttachmentExtractorService,
  private readonly prisma: PrismaService,
  private readonly extractionAgent: ExtractionAgentService,
  private readonly storageService: StorageService,
  private readonly dedupService: DedupService,
  private readonly scoringService: ScoringAgentService,
  private readonly pinoLogger: PinoLogger,
) {
```

**Change process() signature and opening lines:**

```ts
// BEFORE:
async process(job: Job<PostmarkPayloadDto>): Promise<void> {
  const payload = job.data;
  const tenantId = this.config.get<string>('TENANT_ID')!;
```

```ts
// AFTER:
async process(job: Job<{ tenantId: string; messageId: string }>): Promise<void> {
  const { tenantId, messageId: jobMessageId } = job.data;
  const payload = await this.storageService.downloadPayload(tenantId, jobMessageId);
```

**Move the idempotency intake fetch to top of process(), before spam filter:**

After reading the payload, add:

```ts
// Fetch intake once — used for idempotency guard (Phase 6) and cvFileKey
const existingIntake = await this.prisma.emailIntakeLog.findUnique({
  where: { idx_intake_message_id: { tenantId, messageId: payload.MessageID } },
  select: { candidateId: true, cvFileKey: true },
});
```

**Update ProcessingContext initialisation** — set fileKey from DB instead of from Phase 5:

```ts
// BEFORE:
const context: ProcessingContext = {
  fullText,
  suspicious: filterResult.suspicious,
  fileKey: null, // populated after Phase 5 upload below
  cvText: fullText,
  candidateId: '',
};
```

```ts
// AFTER:
const context: ProcessingContext = {
  fullText,
  suspicious: filterResult.suspicious,
  fileKey: existingIntake?.cvFileKey ?? null, // set by webhook (P1)
  cvText: fullText,
  candidateId: '',
};
```

**Remove Phase 5 entirely** — delete these lines:

```ts
// DELETE (Phase 5 — CV upload moved to webhook in P1):
const fileKey = await this.storageService.upload(payload.Attachments ?? [], tenantId, payload.MessageID);
context.fileKey = fileKey;
context.cvText = fullText;
this.pinoLogger.log({ messageId: payload.MessageID, fileKey: fileKey ?? null }, 'Phase 5 complete');
```

**Update Phase 6 idempotency guard** — use the already-fetched `existingIntake`:

```ts
// BEFORE:
const existingIntake = await this.prisma.emailIntakeLog.findUnique({
  where: { idx_intake_message_id: { tenantId, messageId: payload.MessageID } },
  select: { candidateId: true },
});

let candidateId!: string;

if (existingIntake?.candidateId) {
```

```ts
// AFTER (existingIntake already fetched at top — just use it):
let candidateId!: string;

if (existingIntake?.candidateId) {
```

- [ ] **Step 10: Run the full test suite**

```bash
npx jest --no-coverage 2>&1 | tail -30
```

Expected: all tests pass. (Tests that mock job.data as PostmarkPayloadDto will need updating — see below.)

- [ ] **Step 11: Update processor tests that pass PostmarkPayloadDto as job.data**

In `src/ingestion/ingestion.processor.spec.ts`, find all places that build the mock job with full payload data, e.g.:

```ts
// BEFORE: test creates job with full payload
const job = { data: { MessageID: 'msg-1', From: '...', Attachments: [] } } as any;
```

Update to the new shape AND mock `storageService.downloadPayload` to return the payload:

```ts
// AFTER:
const payload = {
  MessageID: 'msg-1',
  From: 'test@example.com',
  Attachments: [],
  Subject: 'Test',
  TextBody: '',
  Date: new Date().toISOString(),
};
const job = {
  data: { tenantId: 'tenant-uuid', messageId: 'msg-1' },
  id: 'job-1',
  name: 'ingest-email',
  attemptsMade: 0,
  opts: { attempts: 3 },
} as any;
mockStorageService.downloadPayload.mockResolvedValue(payload);
mockPrismaService.emailIntakeLog.findUnique.mockResolvedValueOnce({
  candidateId: null,
  cvFileKey: 'cvs/tenant-uuid/msg-1.pdf',
});
```

Also remove any `mockStorageService.upload.mockResolvedValue(...)` calls that were for Phase 5, since Phase 5 is now gone.

- [ ] **Step 12: Run full test suite again**

```bash
npx jest --no-coverage 2>&1 | tail -30
```

Expected: all tests pass.

- [ ] **Step 13: Drain queue + flush Redis before committing (dev environment)**

```bash
# Drain queue: let any pending jobs finish (or force-flush in dev)
docker exec -it redis redis-cli FLUSHDB
```

- [ ] **Step 14: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/ src/storage/storage.service.ts src/storage/storage.service.spec.ts src/webhooks/webhooks.module.ts src/webhooks/webhooks.service.ts src/ingestion/ingestion.processor.ts
git commit -m "feat(p1): move base64 payloads from Redis to R2 — enqueue only {tenantId,messageId}"
```

---

## Task 4: P2 — Structured AI Output + R2 Extraction Cache (H5 + C2)

**Requires:** Task 3 (P1) complete and deployed.

**Files:**

- Modify: `package.json` (new dep)
- Modify: `src/storage/storage.service.ts`
- Modify: `src/ingestion/services/extraction-agent.service.ts`
- Modify: `src/ingestion/services/extraction-agent.service.spec.ts`
- Modify: `src/scoring/scoring.service.ts`
- Modify: `src/ingestion/ingestion.processor.ts`

**What changes:** Replace `callModel → getText → regex-strip → JSON.parse` with Vercel AI SDK `generateObject` (schema-enforced JSON, no parsing hacks). Cache the extraction result to R2 so retries skip the AI call. Remove the `extractDeterministically` fallback (safe now that we have R2 caching — retries use cached result, not garbage fallback).

### Step group: Install dependency

- [ ] **Step 1: Install @openrouter/ai-sdk-provider**

```bash
npm install @openrouter/ai-sdk-provider
```

Expected: package installed, `package.json` and `package-lock.json` updated.

### Step group: StorageService caching methods

- [ ] **Step 2: Add saveExtractionCache and loadExtractionCache to StorageService**

Add to `src/storage/storage.service.ts`:

```ts
// Save AI extraction result to R2 (keyed by tenantId + messageId).
// Called after successful extraction to enable cache-on-retry.
async saveExtractionCache(result: Record<string, unknown>, tenantId: string, messageId: string): Promise<void> {
  const key = `emails/${tenantId}/${messageId}/extraction.json`;
  await this.s3Client.send(
    new PutObjectCommand({
      Bucket: this.config.get<string>('R2_BUCKET_NAME')!,
      Key: key,
      Body: JSON.stringify(result),
      ContentType: 'application/json',
    }),
  );
  this.logger.log(`Cached extraction result at ${key}`);
}

// Load cached extraction result from R2. Returns null on cache miss (NoSuchKey).
async loadExtractionCache(tenantId: string, messageId: string): Promise<Record<string, unknown> | null> {
  const key = `emails/${tenantId}/${messageId}/extraction.json`;
  try {
    const response = await this.s3Client.send(
      new GetObjectCommand({
        Bucket: this.config.get<string>('R2_BUCKET_NAME')!,
        Key: key,
      }),
    );
    const body = await response.Body!.transformToString();
    return JSON.parse(body) as Record<string, unknown>;
  } catch (err: any) {
    if (err.name === 'NoSuchKey') return null;
    throw err;
  }
}
```

### Step group: ExtractionAgentService refactor

- [ ] **Step 3: Write the failing tests for the new extraction interface**

In `src/ingestion/services/extraction-agent.service.spec.ts`, replace the OpenRouter mock with a Vercel AI SDK mock:

```ts
// Replace the existing jest.mock('@openrouter/sdk', ...) block with:
import { generateObject } from 'ai';

jest.mock('ai', () => ({
  generateObject: jest.fn(),
}));

jest.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: jest.fn().mockReturnValue({
    chat: jest.fn().mockReturnValue('mocked-model'),
  }),
}));

const mockGenerateObject = generateObject as jest.MockedFunction<typeof generateObject>;
```

Update `makeService()` to accept `storageService`:

```ts
function makeService(storageService?: Partial<StorageService>): ExtractionAgentService {
  const configService = {
    get: jest.fn().mockReturnValue('fake-openrouter-key'),
  } as unknown as ConfigService;
  const mockStorage = {
    loadExtractionCache: jest.fn().mockResolvedValue(null),
    saveExtractionCache: jest.fn().mockResolvedValue(undefined),
    ...(storageService ?? {}),
  } as unknown as StorageService;
  return new ExtractionAgentService(configService, mockStorage);
}
```

Add extraction metadata to `DEFAULT_METADATA`:

```ts
const DEFAULT_METADATA = {
  subject: 'Test Subject',
  fromEmail: 'test@example.com',
  tenantId: 'tenant-uuid',
  messageId: 'msg-uuid',
};
```

Add new tests:

```ts
it('extract calls generateObject and returns structured result', async () => {
  const expectedResult = {
    full_name: 'Dana Cohen',
    email: 'dana@gmail.com',
    phone: '+972-52-1234567',
    current_role: 'Engineer',
    years_experience: 5,
    location: 'Tel Aviv, Israel',
    skills: ['node.js'],
    ai_summary: 'Senior engineer.',
    source_hint: 'direct' as const,
    source_agency: null,
  };
  mockGenerateObject.mockResolvedValueOnce({ object: expectedResult } as any);

  const service = makeService();
  const result = await service.extract('cv text', false, DEFAULT_METADATA);

  expect(result).toMatchObject({ ...expectedResult, suspicious: false });
  expect(mockGenerateObject).toHaveBeenCalledTimes(1);
});

it('extract returns cached result from R2 without calling generateObject', async () => {
  const cached = {
    full_name: 'Cached Name',
    email: null,
    phone: null,
    current_role: null,
    years_experience: null,
    location: null,
    skills: [],
    ai_summary: null,
    source_hint: null,
    source_agency: null,
  };
  const mockStorage = {
    loadExtractionCache: jest.fn().mockResolvedValue(cached),
    saveExtractionCache: jest.fn(),
  };
  const service = makeService(mockStorage);

  const result = await service.extract('cv text', false, DEFAULT_METADATA);

  expect(result.full_name).toBe('Cached Name');
  expect(mockGenerateObject).not.toHaveBeenCalled();
});

it('extract saves result to R2 cache after successful AI call', async () => {
  const aiResult = {
    full_name: 'New Candidate',
    email: null,
    phone: null,
    current_role: null,
    years_experience: null,
    location: null,
    skills: [],
    ai_summary: null,
    source_hint: null,
    source_agency: null,
  };
  mockGenerateObject.mockResolvedValueOnce({ object: aiResult } as any);
  const mockStorage = {
    loadExtractionCache: jest.fn().mockResolvedValue(null),
    saveExtractionCache: jest.fn().mockResolvedValue(undefined),
  };
  const service = makeService(mockStorage);

  await service.extract('cv text', false, DEFAULT_METADATA);

  expect(mockStorage.saveExtractionCache).toHaveBeenCalledWith(
    expect.objectContaining({ full_name: 'New Candidate' }),
    'tenant-uuid',
    'msg-uuid',
  );
});
```

- [ ] **Step 4: Run the new tests to verify they fail**

```bash
npx jest src/ingestion/services/extraction-agent.service.spec.ts --no-coverage 2>&1 | tail -20
```

Expected: new tests fail (service not yet updated).

- [ ] **Step 5: Refactor ExtractionAgentService to use generateObject + R2 cache**

Replace `src/ingestion/services/extraction-agent.service.ts` class body:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { generateObject } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { z } from 'zod';
import { StorageService } from '../../storage/storage.service';

// (keep CandidateExtractSchema, CandidateExtract type, KNOWN_AGENCY_DOMAINS, resolveAgencyFromEmail, buildInstructions as-is)

export interface ExtractionMetadata {
  subject: string;
  fromEmail: string;
  tenantId: string;
  messageId: string;
}

@Injectable()
export class ExtractionAgentService {
  private readonly logger = new Logger(ExtractionAgentService.name);
  private readonly openrouter: ReturnType<typeof createOpenRouter>;

  constructor(
    private readonly config: ConfigService,
    private readonly storageService: StorageService,
  ) {
    this.openrouter = createOpenRouter({ apiKey: config.get<string>('OPENROUTER_API_KEY')! });
  }

  async extract(fullText: string, suspicious: boolean, metadata: ExtractionMetadata): Promise<CandidateExtract> {
    // Check R2 cache first — avoid re-calling AI on retry
    const cached = await this.storageService.loadExtractionCache(metadata.tenantId, metadata.messageId);
    if (cached !== null) {
      this.logger.log(`Extraction cache hit for ${metadata.messageId}`);
      const parsed = CandidateExtractSchema.parse(cached);
      return { ...parsed, suspicious };
    }

    const extracted = await this.callAI(fullText, metadata);

    // Cache result to R2 — retries will use this instead of calling AI again
    await this.storageService.saveExtractionCache(extracted, metadata.tenantId, metadata.messageId);

    return { ...extracted, suspicious };
  }

  private async callAI(fullText: string, metadata: ExtractionMetadata): Promise<Omit<CandidateExtract, 'suspicious'>> {
    const MAX_INPUT_LENGTH = 20_000;
    const safeFullText = fullText.substring(0, MAX_INPUT_LENGTH);

    const resolvedAgency = resolveAgencyFromEmail(metadata.fromEmail);

    const metadataLines = [`--- Email Metadata ---`, `Subject: ${metadata.subject}`, `From: ${metadata.fromEmail}`];
    if (resolvedAgency !== null) {
      metadataLines.push(`Resolved Agency Name: ${resolvedAgency}`);
    }

    const prompt = [...metadataLines, ``, `--- CV / Email Content ---`, safeFullText].join('\n');
    const instructions = buildInstructions(new Date().getFullYear());

    const { object } = await generateObject({
      model: this.openrouter.chat('openai/gpt-4o-mini'),
      schema: CandidateExtractSchema,
      schemaName: 'CandidateExtract',
      system: instructions,
      prompt,
      temperature: 0,
    });

    this.logger.log(`OpenRouter extraction successful for ${metadata.messageId}`);

    if (resolvedAgency !== null) {
      return { ...object, source_hint: 'agency', source_agency: resolvedAgency };
    }
    return object;
  }

  // REMOVED: extractDeterministically — use R2-cached result on retry instead (P2)
  // REMOVED: getFallback — no longer needed
}
```

- [ ] **Step 6: Similarly refactor ScoringAgentService to use generateObject**

In `src/scoring/scoring.service.ts`, replace the `score()` method body:

```ts
import { generateObject } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';

@Injectable()
export class ScoringAgentService {
  private readonly logger = new Logger(ScoringAgentService.name);
  private readonly openrouter: ReturnType<typeof createOpenRouter>;

  constructor(private readonly config: ConfigService) {
    this.openrouter = createOpenRouter({ apiKey: config.get<string>('OPENROUTER_API_KEY')! });
  }

  async score(input: ScoringInput): Promise<ScoreResult & { modelUsed: string }> {
    const MAX_CV_LENGTH = 15_000;
    const MAX_JOB_DESC_LENGTH = 15_000;

    const safeCvText = input.cvText.substring(0, MAX_CV_LENGTH);
    const safeJobDesc = (input.job.description ?? '').substring(0, MAX_JOB_DESC_LENGTH);

    const candidateSection = [
      `Candidate:`,
      `- Current Role: ${input.candidateFields.currentRole ?? 'Unknown'}`,
      `- Years of Experience: ${input.candidateFields.yearsExperience ?? 'Unknown'}`,
      `- Skills: ${input.candidateFields.skills.length > 0 ? input.candidateFields.skills.join(', ') : 'None listed'}`,
      ``,
      `CV Text:`,
      safeCvText,
    ].join('\n');

    const jobSection = [
      `Job:`,
      `- Title: ${input.job.title}`,
      `- Description: ${safeJobDesc || 'N/A'}`,
      `- Requirements: ${input.job.requirements.length > 0 ? input.job.requirements.join(', ') : 'None specified'}`,
    ].join('\n');

    const { object } = await generateObject({
      model: this.openrouter.chat('openai/gpt-4o-mini'),
      schema: ScoreSchema,
      schemaName: 'CandidateScore',
      system: SCORING_INSTRUCTIONS,
      prompt: `${candidateSection}\n\n${jobSection}`,
      temperature: 0,
    });

    this.logger.log(`Scored candidate — score: ${object.score}`);
    return { ...object, modelUsed: 'openai/gpt-4o-mini' };
  }
}
```

- [ ] **Step 7: Update ingestion.processor.ts to pass tenantId+messageId to extract(), remove deterministic fallback**

In `src/ingestion/ingestion.processor.ts`:

**Update the extract() call** to use the new `ExtractionMetadata` shape:

```ts
// BEFORE:
extraction = await this.extractionAgent.extract(context.fullText, context.suspicious, {
  subject: payload.Subject ?? '',
  fromEmail: payload.From,
});
```

```ts
// AFTER:
extraction = await this.extractionAgent.extract(context.fullText, context.suspicious, {
  subject: payload.Subject ?? '',
  fromEmail: payload.From,
  tenantId,
  messageId: payload.MessageID,
});
```

**Replace the catch block** — remove the `extractDeterministically` fallback entirely:

```ts
// BEFORE (lines ~130-165):
} catch (err) {
  if (job.attemptsMade >= (job.opts?.attempts ?? 3) - 1) {
    this.pinoLogger.warn({ messageId: payload.MessageID }, 'AI extraction failed on final attempt — trying deterministic fallback');
    try {
      const deterministicResult = this.extractionAgent.extractDeterministically(context.fullText);
      extraction = { ...deterministicResult, suspicious: context.suspicious, source_hint: null };
    } catch (fallbackErr) {
      await this.prisma.emailIntakeLog.update({ ... });
      this.pinoLogger.error(...);
      return;
    }
  } else {
    await this.prisma.emailIntakeLog.update({ ... });
    this.pinoLogger.error(...);
    throw err;
  }
}
```

```ts
// AFTER: always re-throw — BullMQ retries will use cached extraction.json if AI succeeded on prior attempt
} catch (err) {
  await this.prisma.emailIntakeLog.update({
    where: { idx_intake_message_id: { tenantId, messageId: payload.MessageID } },
    data: { processingStatus: 'failed', errorMessage: (err as Error).message },
  });
  this.pinoLogger.error(
    { messageId: payload.MessageID, attempt: job.attemptsMade + 1, error: (err as Error).message },
    'AI extraction failed',
  );
  throw err; // BullMQ retries; on final attempt moves job to failed state
}
```

- [ ] **Step 8: Run all tests**

```bash
npx jest --no-coverage 2>&1 | tail -30
```

Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json src/storage/storage.service.ts src/ingestion/services/extraction-agent.service.ts src/ingestion/services/extraction-agent.service.spec.ts src/scoring/scoring.service.ts src/ingestion/ingestion.processor.ts
git commit -m "feat(p2): structured AI output via generateObject, R2 extraction cache — no AI re-run on retry"
```

---

## Task 5: P3 — Parallel Scoring (H3)

**Independent of P1/P2 — can be merged separately.**

**Files:**

- Modify: `src/ingestion/ingestion.processor.ts`

**What changes:** The sequential `for` loop over matched jobs is replaced with `Promise.all()`. N scoring calls run concurrently instead of N × 3–8 s sequentially.

- [ ] **Step 1: Write a test verifying scoring calls are concurrent**

In `src/ingestion/ingestion.processor.spec.ts`, add:

```ts
it('scores multiple matched jobs in parallel — all scoring calls start before any complete', async () => {
  // Arrange: two matched jobs, scoring takes 50ms each
  const delays: number[] = [];
  const startTime = Date.now();
  mockScoringService.score.mockImplementation(async () => {
    await new Promise((r) => setTimeout(r, 50));
    delays.push(Date.now() - startTime);
    return { score: 75, reasoning: 'ok', strengths: [], gaps: [], modelUsed: 'test' };
  });
  // ... set up job + two matched jobs ...

  const elapsed = Date.now() - startTime;
  // Parallel: both calls start at ~0ms, finish at ~50ms total
  expect(elapsed).toBeLessThan(150); // sequential would be ~100ms minimum
  expect(delays).toHaveLength(2);
});
```

Note: this test is illustrative — adapt to match the test harness in the spec file.

- [ ] **Step 2: Replace the for loop with Promise.all in ingestion.processor.ts**

Locate the scoring loop (starting around line 388 in the current file):

```ts
// BEFORE:
let maxAiScore = -1;

for (const activeJob of matchedJobs) {
  const application = await this.prisma.application.upsert({
    where: { idx_applications_unique: { tenantId, candidateId: context.candidateId, jobId: activeJob.id } },
    create: { tenantId, candidateId: context.candidateId, jobId: activeJob.id, stage: 'new' },
    update: {},
    select: { id: true },
  });

  let scoreResult: ScoreResult & { modelUsed: string };
  try {
    scoreResult = await this.scoringService.score({
      cvText: context.cvText,
      candidateFields: {
        currentRole: extraction!.current_role ?? null,
        yearsExperience: extraction!.years_experience ?? null,
        skills: extraction!.skills ?? [],
      },
      job: {
        title: activeJob.title,
        description: activeJob.description ?? null,
        requirements: activeJob.requirements,
      },
    } satisfies ScoringInput);
  } catch (err) {
    this.pinoLogger.error(
      {
        messageId: payload.MessageID,
        candidateId: context.candidateId,
        jobId: activeJob.id,
        error: (err as Error).message,
      },
      'Scoring failed',
    );
    await this.prisma.emailIntakeLog.update({
      where: { idx_intake_message_id: { tenantId, messageId: payload.MessageID } },
      data: { processingStatus: 'failed', errorMessage: (err as Error).message },
    });
    throw err;
  }

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

  maxAiScore = Math.max(maxAiScore, scoreResult.score);

  this.pinoLogger.log(
    { messageId: payload.MessageID, candidateId: context.candidateId, jobId: activeJob.id, score: scoreResult.score },
    'Phase 7 scored',
  );
}
```

```ts
// AFTER:
let scores: number[];
try {
  scores = await Promise.all(
    matchedJobs.map(async (activeJob) => {
      const application = await this.prisma.application.upsert({
        where: { idx_applications_unique: { tenantId, candidateId: context.candidateId, jobId: activeJob.id } },
        create: { tenantId, candidateId: context.candidateId, jobId: activeJob.id, stage: 'new' },
        update: {},
        select: { id: true },
      });

      const scoreResult = await this.scoringService.score({
        cvText: context.cvText,
        candidateFields: {
          currentRole: extraction!.current_role ?? null,
          yearsExperience: extraction!.years_experience ?? null,
          skills: extraction!.skills ?? [],
        },
        job: {
          title: activeJob.title,
          description: activeJob.description ?? null,
          requirements: activeJob.requirements,
        },
      } satisfies ScoringInput);

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

      this.pinoLogger.log(
        {
          messageId: payload.MessageID,
          candidateId: context.candidateId,
          jobId: activeJob.id,
          score: scoreResult.score,
        },
        'Phase 7 scored',
      );

      return scoreResult.score;
    }),
  );
} catch (err) {
  this.pinoLogger.error(
    { messageId: payload.MessageID, candidateId: context.candidateId, error: (err as Error).message },
    'Scoring failed for one or more jobs',
  );
  await this.prisma.emailIntakeLog.update({
    where: { idx_intake_message_id: { tenantId, messageId: payload.MessageID } },
    data: { processingStatus: 'failed', errorMessage: (err as Error).message },
  });
  throw err;
}

const maxAiScore = Math.max(-1, ...scores);
```

- [ ] **Step 3: Run full test suite**

```bash
npx jest --no-coverage 2>&1 | tail -30
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/ingestion/ingestion.processor.ts
git commit -m "perf(p3): score multiple matched jobs in parallel via Promise.all"
```

---

## Task 6: Fix CandidateJobScore Duplicate Rows on Retry (Kimi: CRITICAL)

**Source:** kimi2.6.md — CRITICAL: "Scoring creates duplicates on retry"

**Files:**

- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_add_score_unique_constraint/migration.sql`
- Modify: `src/ingestion/ingestion.processor.ts`
- Modify: `src/ingestion/ingestion.processor.spec.ts`

**Bug:** `candidateJobScore.create()` runs inside the scoring loop (Task 5 converts this to `Promise.all`). If one parallel scoring call fails, BullMQ retries the whole job. On retry, `application.upsert()` no-ops but `candidateJobScore.create()` inserts **duplicate rows** for every previously-succeeded job. `CandidateJobScore` has no unique constraint on `(tenantId, applicationId)`.

- [ ] **Step 1: Add `upsert` to the Prisma mock — then write the failing test**

In `src/ingestion/ingestion.processor.spec.ts`, add `upsert` to the `candidateJobScore` mock object inside `beforeEach`:

```ts
// BEFORE:
candidateJobScore: { create: jest.fn().mockResolvedValue({}) },
```

```ts
// AFTER:
candidateJobScore: {
  create: jest.fn().mockResolvedValue({}),
  upsert: jest.fn().mockResolvedValue({}),
},
```

Then add this test after the existing scoring tests:

```ts
it('uses candidateJobScore.upsert instead of create — prevents duplicate rows on retry', async () => {
  const activeJob = {
    id: 'job-uuid',
    title: 'Software Engineer',
    description: null,
    requirements: [],
    shortId: '100',
    hiringStages: [{ id: 'stage-uuid' }],
  };
  prisma.job.findMany.mockResolvedValue([activeJob]);
  dedupService.insertCandidate.mockResolvedValue('candidate-uuid');
  prisma.application.upsert.mockResolvedValue({ id: 'app-uuid' });

  // Job data shape after Task 3 (P1): { tenantId, messageId }
  const job = {
    data: { tenantId: 'test-tenant-id', messageId: 'msg-1' },
    id: 'job-1',
    name: 'ingest-email',
    attemptsMade: 0,
    opts: { attempts: 3 },
  } as any;

  await processor.process(job);

  expect(prisma.candidateJobScore.upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { idx_scores_unique_per_app: { tenantId: 'test-tenant-id', applicationId: 'app-uuid' } },
      update: {},
    }),
  );
  expect(prisma.candidateJobScore.create).not.toHaveBeenCalled();
});
```

Note: if Task 3 (P1) is complete, the processor reads payload from R2 via `storageService.downloadPayload`. Ensure `storageService.downloadPayload` is mocked (added in Task 3, Step 11) and `prisma.emailIntakeLog.findUnique` returns `{ candidateId: null, cvFileKey: null }` for the intake fetch at the top of `process()`.

- [ ] **Step 2: Run test to confirm it currently fails**

```bash
npx jest src/ingestion/ingestion.processor.spec.ts --no-coverage 2>&1 | tail -20
```

Expected: the new test fails — `upsert` not called, `create` IS called.

- [ ] **Step 3: Add unique constraint to CandidateJobScore in schema.prisma**

In `prisma/schema.prisma`, inside the `CandidateJobScore` model, add the `@@unique` after the existing `@@index`:

```prisma
// BEFORE:
  @@index([applicationId], name: "idx_scores_application")
  @@map("candidate_job_scores")
```

```prisma
// AFTER:
  @@index([applicationId], name: "idx_scores_application")
  @@unique([tenantId, applicationId], name: "idx_scores_unique_per_app")
  @@map("candidate_job_scores")
```

- [ ] **Step 4: Create migration file**

Create `prisma/migrations/20260426140000_add_score_unique_constraint/migration.sql`:

```sql
-- Prevents duplicate CandidateJobScore rows when BullMQ retries the scoring phase.
-- One score row per application (candidate-job pair) per tenant.
CREATE UNIQUE INDEX idx_scores_unique_per_app
ON candidate_job_scores(tenant_id, application_id);
```

> **Note:** If migration fails with `duplicate key value`, existing duplicate rows must be removed first. In dev: `docker exec -it redis redis-cli FLUSHDB && npm run db:reset`. In production: remove duplicates keeping the oldest `scored_at` per `application_id`.

- [ ] **Step 5: Run migration**

```bash
npm run db:migrate
```

Verify:

```bash
docker exec -it postgres psql -U postgres -d talentosdb -c "\d candidate_job_scores"
```

Expected: `idx_scores_unique_per_app` visible as a unique index.

- [ ] **Step 6: Change `candidateJobScore.create()` → `candidateJobScore.upsert()` in ingestion.processor.ts**

In `src/ingestion/ingestion.processor.ts`, locate `candidateJobScore.create` inside the `Promise.all` scoring map (post-Task-5 state):

```ts
// BEFORE:
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

```ts
// AFTER:
await this.prisma.candidateJobScore.upsert({
  where: { idx_scores_unique_per_app: { tenantId, applicationId: application.id } },
  create: {
    tenantId,
    applicationId: application.id,
    score: scoreResult.score,
    reasoning: scoreResult.reasoning,
    strengths: scoreResult.strengths,
    gaps: scoreResult.gaps,
    modelUsed: scoreResult.modelUsed,
  },
  update: {}, // no-op on retry — existing score preserved
});
```

Also remove the `metadata: Prisma.JsonNull` line from the `candidate.update` call (the field is `Json?` — no Prisma sentinel needed; omit the key entirely):

```ts
// BEFORE:
data: {
  ...
  metadata: Prisma.JsonNull, // D-03: deferred to future phase (Prisma requires JsonNull not null)
},
```

```ts
// AFTER:
data: {
  ...
  // metadata: omitted — Json? column defaults to null, no sentinel needed
},
```

If `Prisma` from `@prisma/client` is no longer used after removing `Prisma.JsonNull`, remove the import:

```ts
// DELETE if unused:
import { Prisma } from '@prisma/client';
```

- [ ] **Step 7: Run all tests**

```bash
npx jest --no-coverage 2>&1 | tail -30
```

Expected: all tests pass including the new upsert test.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/ src/ingestion/ingestion.processor.ts src/ingestion/ingestion.processor.spec.ts
git commit -m "fix(scoring): prevent duplicate CandidateJobScore rows on retry — unique constraint + upsert"
```

---

## Task 7: Add Missing Partial Unique Email Index on Candidates (Kimi: CRITICAL)

**Source:** kimi2.6.md — CRITICAL: "Missing Unique Email Index on Candidates"

**Files:**

- Create: `prisma/migrations/<timestamp>_add_candidate_email_unique_index/migration.sql`

**Bug:** The `Candidate` model comment promises "Unique email per tenant (partial — only when email is not null, enforced via raw SQL index)" but no such index exists in any migration. Duplicate emails for the same tenant can be inserted, breaking dedup assumptions.

Prisma does not support partial indexes natively — this must be added via raw SQL.

- [ ] **Step 1: Create the migration file**

Create `prisma/migrations/20260426150000_add_candidate_email_unique_index/migration.sql`:

```sql
-- Partial unique index: one email address per tenant, enforced only when email IS NOT NULL.
-- Null emails (candidates without an extracted email) bypass this constraint intentionally.
-- Prisma cannot express partial indexes natively — maintained via raw SQL migration.
CREATE UNIQUE INDEX IF NOT EXISTS idx_candidates_tenant_email_unique
ON candidates(tenant_id, email)
WHERE email IS NOT NULL;
```

- [ ] **Step 2: Run migration**

```bash
npm run db:migrate
```

Verify:

```bash
docker exec -it postgres psql -U postgres -d talentosdb -c "\d candidates"
```

Expected: `idx_candidates_tenant_email_unique` visible with predicate `WHERE email IS NOT NULL`.

> **Note:** If migration fails with `duplicate key value`, inspect existing duplicates:
> ```sql
> SELECT tenant_id, email, COUNT(*)
> FROM candidates
> WHERE email IS NOT NULL
> GROUP BY tenant_id, email
> HAVING COUNT(*) > 1;
> ```
> In dev: `npm run db:reset`. In production: remove duplicate rows first (keep the oldest `created_at`).

- [ ] **Step 3: Commit**

```bash
git add prisma/migrations/
git commit -m "fix(db): add partial unique index on candidates(tenant_id, email) — enforces one email per tenant"
```

---

## Task 8: Extract Hardcoded AI Model Strings to Config (Kimi: MEDIUM)

**Source:** kimi2.6.md — MEDIUM: "Hardcoded Model String Across Services"

**Files:**

- Modify: `src/config/env.ts`
- Modify: `src/ingestion/services/extraction-agent.service.ts`
- Modify: `src/scoring/scoring.service.ts`
- Modify: `src/ingestion/services/extraction-agent.service.spec.ts`
- Modify: `src/scoring/scoring.service.spec.ts`

**Issue:** `'openai/gpt-4o-mini'` is hardcoded in multiple files. Changing models requires a code deploy instead of an env var change. Code snippets below assume **post-P2 state** (Task 4 complete — `createOpenRouter` + `generateObject`). If Task 4 is not done, the same pattern applies to the `callModel` path.

> **Dependency:** Run after Task 4 (P2) if P2 is implemented. Safe to run on the original code if P2 is not yet done — adjust the `callModel` line instead of `generateObject`.

- [ ] **Step 1: Add EXTRACTION_MODEL and SCORING_MODEL to env.ts**

In `src/config/env.ts`:

```ts
// BEFORE — no model config:
export const envSchema = z.object({
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  OPENROUTER_API_KEY: z.string().min(1),
  // ... rest
});
```

```ts
// AFTER — add two optional fields with defaults:
export const envSchema = z.object({
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  OPENROUTER_API_KEY: z.string().min(1),
  EXTRACTION_MODEL: z.string().default('openai/gpt-4o-mini'),
  SCORING_MODEL: z.string().default('openai/gpt-4o-mini'),
  // ... rest unchanged
});
```

- [ ] **Step 2: Run env config tests to confirm they still pass**

```bash
npx jest src/config/env.spec.ts --no-coverage 2>&1 | tail -10
```

Expected: all tests pass (defaults are backwards-compatible).

- [ ] **Step 3: Update ExtractionAgentService to read model from config**

In `src/ingestion/services/extraction-agent.service.ts`, add a `readonly` field and read from config in constructor:

```ts
// BEFORE — class body:
@Injectable()
export class ExtractionAgentService {
  private readonly logger = new Logger(ExtractionAgentService.name);
  private readonly openrouter: ReturnType<typeof createOpenRouter>;

  constructor(
    private readonly config: ConfigService,
    private readonly storageService: StorageService,
  ) {
    this.openrouter = createOpenRouter({ apiKey: config.get<string>('OPENROUTER_API_KEY')! });
  }
```

```ts
// AFTER:
@Injectable()
export class ExtractionAgentService {
  private readonly logger = new Logger(ExtractionAgentService.name);
  private readonly openrouter: ReturnType<typeof createOpenRouter>;
  private readonly extractionModel: string;

  constructor(
    private readonly config: ConfigService,
    private readonly storageService: StorageService,
  ) {
    this.openrouter = createOpenRouter({ apiKey: config.get<string>('OPENROUTER_API_KEY')! });
    this.extractionModel = config.get<string>('EXTRACTION_MODEL') ?? 'openai/gpt-4o-mini';
  }
```

Then in `callAI()`:

```ts
// BEFORE:
const { object } = await generateObject({
  model: this.openrouter.chat('openai/gpt-4o-mini'),
```

```ts
// AFTER:
const { object } = await generateObject({
  model: this.openrouter.chat(this.extractionModel),
```

- [ ] **Step 4: Update ScoringAgentService to read model from config**

In `src/scoring/scoring.service.ts`:

```ts
// BEFORE — class body:
@Injectable()
export class ScoringAgentService {
  private readonly logger = new Logger(ScoringAgentService.name);
  private readonly openrouter: ReturnType<typeof createOpenRouter>;

  constructor(private readonly config: ConfigService) {
    this.openrouter = createOpenRouter({ apiKey: config.get<string>('OPENROUTER_API_KEY')! });
  }

  async score(input: ScoringInput): Promise<ScoreResult & { modelUsed: string }> {
    // ...
    const { object } = await generateObject({
      model: this.openrouter.chat('openai/gpt-4o-mini'),
    // ...
    return { ...object, modelUsed: 'openai/gpt-4o-mini' };
  }
```

```ts
// AFTER:
@Injectable()
export class ScoringAgentService {
  private readonly logger = new Logger(ScoringAgentService.name);
  private readonly openrouter: ReturnType<typeof createOpenRouter>;
  private readonly scoringModel: string;

  constructor(private readonly config: ConfigService) {
    this.openrouter = createOpenRouter({ apiKey: config.get<string>('OPENROUTER_API_KEY')! });
    this.scoringModel = config.get<string>('SCORING_MODEL') ?? 'openai/gpt-4o-mini';
  }

  async score(input: ScoringInput): Promise<ScoreResult & { modelUsed: string }> {
    // ...
    const { object } = await generateObject({
      model: this.openrouter.chat(this.scoringModel),
    // ...
    return { ...object, modelUsed: this.scoringModel };
  }
```

- [ ] **Step 5: Update ConfigService mocks in spec files**

In `src/ingestion/services/extraction-agent.service.spec.ts`, update the `configService` mock inside `makeService()` to return the model key:

```ts
// BEFORE:
const configService = {
  get: jest.fn().mockReturnValue('fake-openrouter-key'),
} as unknown as ConfigService;
```

```ts
// AFTER:
const configService = {
  get: jest.fn().mockImplementation((key: string) => {
    if (key === 'EXTRACTION_MODEL') return 'openai/gpt-4o-mini';
    return 'fake-openrouter-key'; // default for OPENROUTER_API_KEY
  }),
} as unknown as ConfigService;
```

In `src/scoring/scoring.service.spec.ts`, apply the same pattern to the ConfigService mock.

- [ ] **Step 6: Run all tests**

```bash
npx jest --no-coverage 2>&1 | tail -30
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/config/env.ts src/ingestion/services/extraction-agent.service.ts src/scoring/scoring.service.ts src/ingestion/services/extraction-agent.service.spec.ts src/scoring/scoring.service.spec.ts
git commit -m "feat(config): extract AI model strings to EXTRACTION_MODEL/SCORING_MODEL env vars with defaults"
```

---

## Task 9: Configure BullMQ Failed Job Retention (Kimi: HIGH — DLQ-lite)

**Source:** kimi2.6.md — HIGH: "No Dead-Letter Queue for Permanent Failures"

**Files:**

- Modify: `src/webhooks/webhooks.service.ts`

**Issue:** After 3 BullMQ attempts, failed jobs are silently removed from Redis. There is no way to inspect, replay, or alert on permanently failed emails. This is a BullMQ `removeOnFail` config change — no new dependencies, no API changes.

> **Dependency:** If Task 3 (P1) is complete, apply to the new `IngestJobData` enqueue call in `webhooks.service.ts`. Code below assumes post-P1 state.

- [ ] **Step 1: Add retention options to ingestQueue.add() in webhooks.service.ts**

In `src/webhooks/webhooks.service.ts`, update both enqueue calls (new job + re-enqueue for pending) to include retention options:

```ts
// BEFORE (new job enqueue):
await this.ingestQueue.add('ingest-email', { tenantId, messageId } satisfies IngestJobData, {
  jobId: messageId,
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
});
```

```ts
// AFTER:
await this.ingestQueue.add('ingest-email', { tenantId, messageId } satisfies IngestJobData, {
  jobId: messageId,
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { count: 1000 }, // keep last 1000 completed — audit trail
  removeOnFail: { count: 500 },      // keep last 500 failed — post-mortem inspection
});
```

Apply the same options to the re-enqueue block (the `existing.processingStatus === 'pending'` branch) — search for the second `this.ingestQueue.add(` call and apply identical options.

> **Why `{ count: 500 }` not `false`:** `removeOnFail: false` keeps ALL failed jobs forever, growing Redis memory without bound. `{ count: 500 }` keeps the most recent 500 and is safe for production.

- [ ] **Step 2: Run the full test suite**

```bash
npx jest --no-coverage 2>&1 | tail -30
```

Expected: all tests pass. (BullMQ options are passed through to the mocked queue — the mock doesn't validate option shapes.)

- [ ] **Step 3: Commit**

```bash
git add src/webhooks/webhooks.service.ts
git commit -m "fix(queue): retain last 500 failed BullMQ jobs for post-mortem inspection"
```

---

## Self-Review

**Spec coverage check:**

| Finding                            | Addressed                                    | Task                                          |
| ---------------------------------- | -------------------------------------------- | --------------------------------------------- |
| H1 auth truncation                 | ✅                                           | Task 1                                        |
| H4 per-call OpenRouter client      | ✅                                           | Task 2                                        |
| M5 throttler before auth           | ✅                                           | Task 2                                        |
| M6 dual loggers                    | ✅                                           | Task 2                                        |
| C1 base64 in Redis                 | ✅                                           | Task 3                                        |
| M3 R2 orphan on Phase 6 fail       | ✅                                           | Task 3 (CV uploaded in webhook before DB row) |
| H5 JSON parse hack                 | ✅                                           | Task 4                                        |
| C2 AI re-runs on retry             | ✅                                           | Task 4                                        |
| H3 sequential scoring              | ✅                                           | Task 5                                        |
| P2 ordering dependency             | ✅                                           | Task 4 explicitly gated on Task 3             |
| Kimi: Score row duplicates on retry | ✅                                          | Task 6                                        |
| Kimi: Missing candidate email index | ✅                                          | Task 7                                        |
| Kimi: Hardcoded model strings      | ✅                                           | Task 8                                        |
| Kimi: No failed job retention      | ✅                                           | Task 9                                        |
| Sandboxed processors               | Skipped — breaks NestJS DI                   |                                               |
| candidate_ranked view              | Skipped — full query audit needed            |                                               |
| Multi-tenant slug URL              | Skipped — needs Postmark dashboard change    |                                               |
| Kimi: Circuit breaker on OpenRouter | Skipped — adds opossum dep, complex         |                                               |
| Kimi: Split scoring into own queue | Skipped — architectural change              |                                               |
| Kimi: cvFileUrl rename             | Skipped — breaking schema + code rename     |                                               |
| Kimi: Worker health HTTP endpoint  | Skipped — NestJS shutdown hooks cover this  |                                               |

**Dependency order:**

- Task 1 → independent
- Task 2 → independent
- Task 3 → independent (but must be drained + deployed before Task 4 ships)
- Task 4 → requires Task 3 complete
- Task 5 → independent
- Task 6 → best run after Task 5 (targets post-P3 `Promise.all` scoring code)
- Task 7 → independent (DB migration only)
- Task 8 → best run after Task 4 (targets post-P2 `generateObject` service code)
- Task 9 → best run after Task 3 (targets new `IngestJobData` enqueue call in webhooks.service.ts)

**Type consistency check:**

- `ExtractionMetadata` interface added in `extraction-agent.service.ts` — used in `extract()` call in `ingestion.processor.ts` ✅
- `IngestJobData` interface exported from `webhooks.service.ts` — used as `Job<IngestJobData>` in processor ✅
- `StorageService` methods `uploadPayload/downloadPayload/saveExtractionCache/loadExtractionCache` defined in Task 3/4 and consumed in Task 3/4 ✅
- `scores: number[]` from `Promise.all` used in `Math.max(-1, ...scores)` ✅
- `idx_scores_unique_per_app` unique name in `schema.prisma` matches the `where` clause in `candidateJobScore.upsert()` ✅
- `EXTRACTION_MODEL` / `SCORING_MODEL` in `env.ts` match `config.get<string>('EXTRACTION_MODEL')` calls ✅
