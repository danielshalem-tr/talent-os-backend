# Audit Verification Fixes — Implementation Plan

**Date:** 2026-04-07
**Scope:** 6 issues from AUDIT-VERIFICATION.md
**Success Criteria:** All 6 issues resolved, 249 tests passing, no regressions

---

## Fix Order & Dependencies

1. **Fix #1** (Issue #4) — Unbounded Context Window
2. **Fix #2** (Issue #6) — Overly Strict Zod Validation
3. **Fix #3** (Issue #2) — TOCTOU Race Condition
4. **Fix #4** (Issue #1) — Broken Idempotency on BullMQ Retries
5. **Fix #5** (Issue #7) — Fragile Deterministic Fallback Logic
6. **Fix #6** (Issue #3) — O(N) Job Matching Performance

---

## Critical Notes (read before starting)

1. **Migrations:** The dev server runs in Docker. Use `npm run db:migrate` (check `package.json` for the exact script), **NOT** `npx prisma migrate dev`.
2. **No schema migrations needed.** Fix #3 uses advisory locks, not a unique constraint. No Prisma schema changes anywhere in this plan.
3. **Method names in codebase:** Scoring uses `score()` (not `scoreCandidate`). Extraction uses `callAI()` (private) called via `extract()`. The LLM client uses `client.callModel()` + `result.getText()` (OpenRouter SDK), NOT `openRouter.messages.create()`.
4. **Schema names:** Extraction schema is `CandidateExtractSchema` (not `ExtractionSchema`). Fields use snake_case: `full_name`, `years_experience`, `current_role`, `ai_summary`, `source_hint`, `source_agency`.
5. **`extractAllJobIdsFromEmailText` signature:** Takes `(subject: string | null | undefined, body: string | null | undefined, tenantId: string)` — three parameters, not one.
6. **`tenantId` source:** Comes from `this.config.get<string>('TENANT_ID')` in the processor, not from the payload.
7. **No `normalProcessFlow` or `scoreAndStoreResults` methods exist** on the processor. All logic is inline in `process()`.
8. **Existing test mocks MUST be updated for Fix #3 and #4.** After these fixes, `process()` calls new methods that existing mocks don't cover. If you don't update the mocks, ALL existing processor tests will throw `TypeError`. See the dedicated section below.
9. **Existing Phase 15 tests MUST be rewritten for Fix #6.** The current tests use alphanumeric shortIds (`'se-1'`, `'pm-2'`). The new `extractCandidateShortIds()` only matches numeric tokens. All 6 Phase 15 tests will fail unless rewritten with numeric shortIds (`'100'`, `'245'`).

---

## Fix #1: Issue #4 — Unbounded Context Window

**Problem:** `cvText` + `job.description` passed to LLM without length limits → 400/413 errors on oversized inputs.

**Solution:** Truncate inputs before building LLM prompt. Wrap LLM calls in try-catch for HTTP 400/413.

### Task 1.1: Scoring service — truncate inputs

**File:** `src/modules/scoring/scoring.service.ts`

In the `score()` method (line ~53), add truncation constants and truncate before building the prompt sections:

```typescript
// Add at top of score() method, before building candidateSection
const MAX_CV_LENGTH = 15_000;
const MAX_JOB_DESC_LENGTH = 15_000;

const safeCvText = input.cvText.substring(0, MAX_CV_LENGTH);
const safeJobDesc = (input.job.description ?? '').substring(0, MAX_JOB_DESC_LENGTH);
```

Then replace `input.cvText` → `safeCvText` and `input.job.description` → `safeJobDesc` in the two section builders (lines ~58-72).

The existing `candidateSection` array (line ~58) currently ends with `input.cvText`. Change that reference to `safeCvText`.

The existing `jobSection` array (line ~67) uses `input.job.description ?? 'N/A'`. Change to `safeJobDesc || 'N/A'`.

Wrap the `client.callModel()` + `result.getText()` + JSON parse block in try-catch:

````typescript
try {
  const result = client.callModel({
    model: 'openai/gpt-4o-mini',
    instructions: SCORING_INSTRUCTIONS,
    input: userMessage,
  });

  const raw = await result.getText();
  const json = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  const parseResult = ScoreSchema.safeParse(JSON.parse(json));

  if (!parseResult.success) {
    this.logger.error('Scoring LLM returned invalid JSON', parseResult.error.issues);
    throw new Error(`Scoring output validation failed: ${parseResult.error.message}`);
  }

  this.logger.log(`Scored candidate — score: ${parseResult.data.score}`);
  return { ...parseResult.data, modelUsed: 'openai/gpt-4o-mini' };
} catch (error) {
  if (error instanceof Error && (error.message.includes('400') || error.message.includes('413'))) {
    this.logger.error(`LLM context window exceeded: ${error.message}`);
    throw new Error('SCORING_CONTEXT_EXCEEDED');
  }
  throw error;
}
````

### Task 1.2: Extraction service — truncate input

**File:** `src/modules/extraction/extraction-agent.service.ts`

In the private `callAI()` method (line ~92), add truncation before building `userMessage`:

```typescript
const MAX_INPUT_LENGTH = 20_000;
const safeFullText = fullText.substring(0, MAX_INPUT_LENGTH);
```

Then in the `userMessage` array (line ~101), replace `fullText` → `safeFullText`.

Wrap the `client.callModel()` block in try-catch (same pattern as scoring):

```typescript
try {
  const result = client.callModel({ ... });
  const raw = await result.getText();
  // ... existing JSON strip + parse logic
} catch (error) {
  if (error instanceof Error && (error.message.includes('400') || error.message.includes('413'))) {
    this.logger.error(`LLM context window exceeded: ${error.message}`);
    throw new Error('EXTRACTION_CONTEXT_EXCEEDED');
  }
  throw error;
}
```

### Tests

**`scoring.service.spec.ts`:**

```typescript
describe('score() - context limits', () => {
  it('should not throw on 50K char cvText (truncated internally)', async () => {
    const input: ScoringInput = {
      cvText: 'a'.repeat(50_000),
      candidateFields: { currentRole: 'Dev', yearsExperience: 5, skills: ['ts'] },
      job: { title: 'Engineer', description: 'b'.repeat(50_000), requirements: [] },
    };
    // Mock callModel to capture the input and verify truncation
    // The test verifies the method doesn't throw a context error
    await expect(service.score(input)).resolves.toBeDefined();
  });
});
```

**`extraction-agent.service.spec.ts`:**

```typescript
describe('extract() - context limits', () => {
  it('should not throw on 100K char fullText (truncated internally)', async () => {
    const longText = 'a'.repeat(100_000);
    await expect(service.extract(longText, false, { subject: 'Test', fromEmail: 'a@b.com' })).resolves.toBeDefined();
  });
});
```

### Commit

```
fix(audit): Issue #4 — add context limits to LLM calls

- Truncate cvText/job.description to 15K chars in scoring service
- Truncate fullText to 20K chars in extraction service
- Catch HTTP 400/413 errors, throw typed errors for caller handling
```

---

## Fix #2: Issue #6 — Overly Strict Zod Validation

**Problem:** `.int()` rejects LLM float outputs (e.g. `score: 85.5`) → validation failure → retry loop.

**Solution:** Replace `.int()` with `.transform(Math.round)`. Keep `.min()` and `.max()` before the transform so range validation runs on the raw number.

### Task 2.1: Scoring schema

**File:** `src/modules/scoring/scoring.service.ts`, line 7

Current:

```typescript
score: z.number().int().min(0).max(100),
```

Change to:

```typescript
score: z.number().min(0).max(100).transform(Math.round),
```

**Why this order:** `.min(0).max(100)` validates the raw number first, then `.transform(Math.round)` coerces to integer. `85.5` → passes min/max → rounds to `86`. `150.5` → fails max(100). This is correct.

### Task 2.2: Extraction schema

**File:** `src/modules/extraction/extraction-agent.service.ts`, line 11

Current:

```typescript
years_experience: z.number().int().min(0).max(50).nullable(),
```

Change to:

```typescript
years_experience: z.number().min(0).max(50).transform(Math.round).nullable(),
```

**How `.nullable()` works here:** Zod's `.nullable()` wraps the entire pipeline. If input is `null`, it short-circuits and returns `null`. If input is a number, the inner chain (min → max → round) runs. `6.7` → passes min/max → rounds to `7`. `null` → returns `null`.

### Tests

**`scoring.service.spec.ts`:**

```typescript
import { ScoreSchema } from './scoring.service';

describe('ScoreSchema - float coercion', () => {
  it('should coerce 85.5 to 86', () => {
    const result = ScoreSchema.parse({ score: 85.5, reasoning: 'ok', strengths: [], gaps: [] });
    expect(result.score).toBe(86);
  });

  it('should reject score > 100', () => {
    expect(() => ScoreSchema.parse({ score: 150, reasoning: 'ok', strengths: [], gaps: [] })).toThrow();
  });

  it('should accept integer score unchanged', () => {
    const result = ScoreSchema.parse({ score: 85, reasoning: 'ok', strengths: [], gaps: [] });
    expect(result.score).toBe(85);
  });
});
```

**`extraction-agent.service.spec.ts`:**

```typescript
import { CandidateExtractSchema } from './extraction-agent.service';

describe('CandidateExtractSchema - float coercion', () => {
  const validBase = {
    full_name: 'Test User',
    email: null,
    phone: null,
    current_role: null,
    location: null,
    skills: [],
    ai_summary: null,
    source_hint: null,
    source_agency: null,
  };

  it('should coerce years_experience 6.7 to 7', () => {
    const result = CandidateExtractSchema.parse({ ...validBase, years_experience: 6.7 });
    expect(result.years_experience).toBe(7);
  });

  it('should accept years_experience null', () => {
    const result = CandidateExtractSchema.parse({ ...validBase, years_experience: null });
    expect(result.years_experience).toBeNull();
  });

  it('should reject years_experience > 50', () => {
    expect(() => CandidateExtractSchema.parse({ ...validBase, years_experience: 75 })).toThrow();
  });
});
```

### Commit

```
fix(audit): Issue #6 — coerce LLM float outputs to integers

- Replace .int() with .transform(Math.round) in ScoreSchema and CandidateExtractSchema
- Range validation (.min/.max) runs before rounding
- .nullable() still works correctly (null short-circuits the pipeline)
```

---

## Fix #3: Issue #2 — TOCTOU Race Condition

**Problem:** `dedupService.check()` runs OUTSIDE the transaction. Two workers both see `null` → both insert duplicates.

**Solution:** Move `check()` inside the transaction + use PostgreSQL advisory lock on phone hash to serialize concurrent access.

**Why NOT a unique constraint:** The current dedup logic (lines 255-270 in processor) _intentionally_ inserts a new candidate with the same phone when `dedupResult.confidence === 1.0`, then creates a duplicate flag. A unique constraint on `(tenantId, phone)` — even partial — would break this intentional behavior. Advisory locks prevent the race without changing business logic.

**No migration needed.** `pg_advisory_xact_lock` is a built-in PostgreSQL function.

### Task 3.1: Add `tx` parameter to `DedupService.check()`

**File:** `src/modules/dedup/dedup.service.ts`

Current signature (line ~13):

```typescript
async check(
  candidate: CandidateExtract,
  tenantId: string,
): Promise<DedupResult | null> {
```

Change to:

```typescript
async check(
  candidate: CandidateExtract,
  tenantId: string,
  tx?: Prisma.TransactionClient,
): Promise<DedupResult | null> {
  const client = tx ?? this.prisma;
```

Then replace `this.prisma.$queryRaw` (line ~21) with `client.$queryRaw`:

```typescript
const phoneMatches = await client.$queryRaw<{ id: string }[]>`
  SELECT id::text
  FROM candidates
  WHERE tenant_id = ${tenantId}::uuid
    AND regexp_replace(phone, '[^0-9]', '', 'g') = regexp_replace(${candidate.phone}, '[^0-9]', '', 'g')
  LIMIT 1
`;
```

The `insertCandidate` and `createFlag` methods already accept `tx` — no changes needed there.

### Task 3.2: Move dedup check inside transaction with advisory lock

**File:** `src/modules/ingestion/ingestion.processor.ts`

Current flow (lines ~213-280):

```
dedupService.check()          ← OUTSIDE transaction (BUG)
$transaction {
  if (dedupResult === null) → insertCandidate
  if (phone_missing) → insertCandidate + createFlag
  if (confidence === 1.0) → insertCandidate + createFlag
  emailIntakeLog.update
}
```

Change to:

```
$transaction {
  pg_advisory_xact_lock()     ← lock on phone hash
  dedupService.check(tx)      ← INSIDE transaction
  if (dedupResult === null) → insertCandidate
  if (phone_missing) → insertCandidate + createFlag
  if (confidence === 1.0) → insertCandidate + createFlag
  emailIntakeLog.update
}
```

**Concrete changes in `ingestion.processor.ts`:**

1. **Remove** the `dedupService.check()` call and its try-catch block that currently sits BEFORE the transaction (lines ~213-228).

2. **Remove** the `let dedupResult` declaration above the transaction.

3. **Inside** the existing `this.prisma.$transaction(async (tx) => {` block, add at the very top:

```typescript
await this.prisma.$transaction(async (tx) => {
  // Advisory lock: serialize concurrent workers processing the same phone
  // Lock is automatically released when the transaction commits/rollbacks
  if (extraction!.phone?.trim()) {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${extraction!.phone}))`;
  }

  // Dedup check — now INSIDE the transaction, protected by advisory lock
  let dedupResult: DedupResult | null = null;
  try {
    dedupResult = await this.dedupService.check(extraction!, tenantId, tx);
  } catch (err) {
    this.logger.error(
      `Dedup check failed for MessageID: ${payload.MessageID} — ${(err as Error).message}`,
      (err as Error).stack,
    );
    throw err; // Transaction will rollback
  }

  // ... rest of existing if/else logic (dedupResult === null, phone_missing, confidence === 1.0)
  // This logic stays EXACTLY as-is. No changes to the branching or insertCandidate/createFlag calls.
  // ...
});
```

**How this prevents the race:**

- Worker A acquires advisory lock on `hashtext('+972-52-1234567')`, runs check(), gets null, inserts candidate, commits → lock released.
- Worker B tries to acquire the same lock → **waits** until Worker A commits.
- Worker B's check() now sees Worker A's insert → returns `confidence: 1.0` → follows case 3 (intentional duplicate + flag). No accidental duplicate.

**What if phone is null?** The advisory lock is skipped (no phone to lock on). Case 2 (phone_missing) always inserts a new candidate, which is correct — there's no uniqueness constraint on null phones.

### Tests

**`ingestion.processor.spec.ts`:**

```typescript
describe('Phase 6 - TOCTOU race prevention', () => {
  it('should call dedupService.check() inside the transaction with tx client', async () => {
    const checkSpy = jest.spyOn(dedupService, 'check');

    await processor.process(job);

    // Verify check() was called with a transaction client (3rd argument)
    expect(checkSpy).toHaveBeenCalledWith(
      expect.any(Object), // extraction
      expect.any(String), // tenantId
      expect.any(Object), // tx (transaction client)
    );
  });

  it('should acquire advisory lock before dedup check when phone exists', async () => {
    const queryRawSpy = jest.spyOn(prismaClient, '$queryRaw');

    await processor.process(job);

    // Verify pg_advisory_xact_lock was called
    expect(queryRawSpy).toHaveBeenCalledWith(
      expect.arrayContaining([expect.stringContaining('pg_advisory_xact_lock')]),
      expect.any(String), // phone
    );
  });
});
```

### Commit

```
fix(audit): Issue #2 — prevent TOCTOU race with advisory lock

- Move dedupService.check() inside the transaction
- Add pg_advisory_xact_lock(hashtext(phone)) before check
- Serializes concurrent workers processing the same phone number
- No schema changes, no business logic changes
- Advisory lock auto-releases on transaction commit/rollback
```

---

## Fix #4: Issue #1 — Broken Idempotency on BullMQ Retries

**Problem:** Job fails at Phase 7 → BullMQ retries → re-enters Phase 6 → dedup runs again on the same candidate → creates self-duplicate.

**Solution:** At the start of Phase 6, check if the intake already has a `candidateId` (set by a previous attempt). If yes, skip the transaction and use the existing `candidateId`.

**Why this minimal approach works:** Everything after Phase 6 is safe to re-run:

- Phase 7 enrichment: `candidate.update()` overwrites same data (idempotent).
- Phase 15: DB query (idempotent).
- Scoring: `application.upsert()` is idempotent. `candidateJobScore.create()` appends a new score row, which is acceptable (append-only by design per SCOR-04).

**No new columns or methods needed.** The intake record already stores `candidateId` (set inside the Phase 6 transaction at line ~275).

### Task 4.1: Add idempotency guard before Phase 6 transaction

**File:** `src/modules/ingestion/ingestion.processor.ts`

Add the guard **after** Phase 4 (extraction) and **before** Phase 6 (dedup transaction). Currently the dedup check + transaction starts around line ~213. Insert this block right before it:

```typescript
// === IDEMPOTENCY GUARD ===
// If this is a BullMQ retry and Phase 6 already completed (candidateId is set),
// skip the entire dedup + insert transaction and reuse the existing candidateId.
const existingIntake = await this.prisma.emailIntakeLog.findUnique({
  where: { idx_intake_message_id: { tenantId, messageId: payload.MessageID } },
  select: { candidateId: true },
});

if (existingIntake?.candidateId) {
  this.logger.log(
    `Idempotency guard: intake ${payload.MessageID} already has candidateId ${existingIntake.candidateId}. Skipping Phase 6.`,
  );
  candidateId = existingIntake.candidateId;
} else {
  // Normal Phase 6 flow: dedup check + transaction (existing code)
  // ... the entire existing dedup + transaction block goes here ...
}

// Phase 15 + Phase 7 continue as normal below (they are safe to re-run)
```

**Note about `candidateId` variable:** There's already a `let candidateId!: string;` declaration at line ~231. The guard sets it directly. The existing Phase 6 code inside the `else` block also sets it. Everything downstream uses `candidateId` normally.

**What about `extraction` on retry?** Phase 4 (AI extraction) runs again on retry. This costs an LLM call, but:

- It's unavoidable without storing the raw extraction result (which adds DB schema complexity).
- Retries are rare (only on Phase 7 failures).
- The extraction result is used for Phase 7 enrichment (overwrites), so a slightly different result is acceptable.

### Tests

**`ingestion.processor.spec.ts`:**

```typescript
describe('Phase 6 - idempotency guard', () => {
  it('should skip Phase 6 when intake already has candidateId (retry scenario)', async () => {
    // Mock: intake already has candidateId from previous attempt
    jest.spyOn(prismaClient.emailIntakeLog, 'findUnique').mockResolvedValueOnce({
      candidateId: 'existing-candidate-id',
    });

    const dedupCheckSpy = jest.spyOn(dedupService, 'check');
    const transactionSpy = jest.spyOn(prismaClient, '$transaction');

    await processor.process(job);

    // Phase 6 (dedup + transaction) should NOT be called
    expect(dedupCheckSpy).not.toHaveBeenCalled();
    expect(transactionSpy).not.toHaveBeenCalled();
  });

  it('should run Phase 6 normally on first attempt (no candidateId)', async () => {
    jest.spyOn(prismaClient.emailIntakeLog, 'findUnique').mockResolvedValueOnce({
      candidateId: null, // First attempt
    });

    const dedupCheckSpy = jest.spyOn(dedupService, 'check');

    await processor.process(job);

    // Phase 6 should run
    expect(dedupCheckSpy).toHaveBeenCalled();
  });

  it('should not create self-duplicate on retry', async () => {
    jest.spyOn(prismaClient.emailIntakeLog, 'findUnique').mockResolvedValueOnce({
      candidateId: 'existing-candidate-id',
    });

    const createSpy = jest.spyOn(prismaClient.candidate, 'create');

    await processor.process(job);

    expect(createSpy).not.toHaveBeenCalled();
  });
});
```

### Commit

```
fix(audit): Issue #1 — add idempotency guard before Phase 6

- Check if intake already has candidateId before running dedup + transaction
- If candidateId exists (retry): skip Phase 6, reuse existing candidateId
- Phase 15 (job matching) and Phase 7 (enrichment + scoring) re-run safely
- Prevents self-duplicate candidates on BullMQ retries
```

---

## REQUIRED: Update Existing Test Mocks (after Fix #3 + #4)

Fix #3 and #4 introduce new method calls inside `process()` that existing mocks don't cover. Without these updates, **every existing processor test that calls `processor.process()` will fail** with `TypeError: ... is not a function`.

### What changed and why mocks break

**Fix #3** moves dedup inside the transaction → the `txClient` mock now needs `$queryRaw` (for the advisory lock).

**Fix #4** adds `this.prisma.emailIntakeLog.findUnique()` at the start of `process()` → the existing `prisma` mock has `emailIntakeLog: { update: jest.fn() }` but no `findUnique`.

### Changes to `ingestion.processor.spec.ts`

**In every `beforeEach` block** that sets up the processor (the spec file has ~4 of these), add:

```typescript
// 1. Add $queryRaw to the transaction client mock (Fix #3: advisory lock)
const txClient = {
  emailIntakeLog: { update: jest.fn().mockResolvedValue({}) },
  $queryRaw: jest.fn().mockResolvedValue([]), // advisory lock — returns empty, no-op
};

// 2. Add findUnique to emailIntakeLog mock (Fix #4: idempotency guard)
// Default: candidateId is null (first attempt — normal flow)
prisma.emailIntakeLog.findUnique = jest.fn().mockResolvedValue({ candidateId: null });
```

**For retry-specific tests** (Fix #4), override the default:

```typescript
prisma.emailIntakeLog.findUnique = jest.fn().mockResolvedValue({
  candidateId: 'existing-candidate-id', // Retry scenario — Phase 6 will be skipped
});
```

**Check the `$transaction` mock:** It must pass `txClient` to the callback. The existing mock likely looks like:

```typescript
prisma.$transaction = jest.fn().mockImplementation((cb) => cb(txClient));
```

Verify that `txClient` now includes `$queryRaw`. If the mock uses `mockResolvedValue` instead of `mockImplementation`, it won't execute the callback at all — the advisory lock and dedup check inside the transaction won't run. Make sure it uses `mockImplementation((cb) => cb(txClient))`.

### Changes to Phase 15 tests (Fix #6)

The existing Phase 15 tests (lines ~776-953) use alphanumeric shortIds like `'se-1'`, `'pm-2'`, `'job-id-1'`. The new `extractCandidateShortIds()` only matches numeric tokens (`/\b(\d{3,})\b/g`), so these tests will all fail silently (no matches found).

**Rewrite all Phase 15 test data** to use numeric shortIds:

```typescript
// OLD test data:
const jobs = [
  { id: 'job-uuid-1', shortId: 'se-1', title: 'Senior Engineer', ... },
  { id: 'job-uuid-2', shortId: 'pm-2', title: 'Product Manager', ... },
];
const emailBody = 'Applying for se-1 and pm-2';

// NEW test data:
const jobs = [
  { id: 'job-uuid-1', shortId: '100', title: 'Senior Engineer', ... },
  { id: 'job-uuid-2', shortId: '101', title: 'Product Manager', ... },
];
const emailBody = 'Applying for position 100 and 101';
```

**Update the `findMany` mock:** The old method called `findMany` twice (once inside `extractAllJobIdsFromEmailText` to get all jobs, once in `process()` to get full job data). The new flow calls `findMany` only once (in `process()`). Remove the first `mockResolvedValueOnce` and keep only the second one. Also verify the mock expects `status: 'open'` in the `where` clause.

---

## Fix #5: Issue #7 — Fragile Deterministic Fallback Logic

**Problem:** `extractDeterministically()` assumes first real line is the name. CVs starting with "Curriculum Vitae", "CONFIDENTIAL", dates, etc. produce garbage. Current logic only handles ASCII — fails on Hebrew and Arabic names.

**Solution:** Expand header filter. Add `looksLikeName()` heuristic with Unicode support (`\p{L}` flag). Require 2-5 words to avoid false positives ("Summary", "Jerusalem") while allowing multi-part names ("Maria de la Cruz", "عبد الرحمن"). Fallback to "Unknown Candidate".

### Task 5.1: Update `extractDeterministically()`

**File:** `src/modules/extraction/extraction-agent.service.ts`

In the `extractDeterministically()` method (line ~122), make these changes:

**1. Expand the header filter** (currently lines ~130-136). Add more patterns:

```typescript
const realLines = lines.filter(
  (line) =>
    !line.startsWith('--- Email Body ---') &&
    !line.startsWith('--- Attachment') &&
    !line.startsWith('--- Email Metadata ---') &&
    !line.startsWith('Subject:') &&
    !line.startsWith('From:') &&
    !/^(Curriculum Vitae|Professional Summary|CONFIDENTIAL|Private & Confidential|Resume|CV)\b/i.test(line),
);
```

**2. Replace the name extraction** (currently line ~140: `const fullName = realLines[0] || '';`):

```typescript
/**
 * Heuristic: a line "looks like a name" if it has 2-5 short words,
 * contains at least one Unicode letter, and doesn't look like a date,
 * year, greeting, or sentence.
 * Supports Latin ("John Doe"), Hebrew ("אבי לוי"), Arabic ("محمد علي"),
 * hyphenated names ("Jean-Pierre Dupont"), and multi-part names ("Maria de la Cruz").
 */
const looksLikeName = (line: string): boolean => {
  const trimmed = line.trim();
  const words = trimmed.split(/\s+/);

  if (
    trimmed.length < 3 ||
    trimmed.length > 80 ||
    /^\d{1,2}[/.-]\d{1,2}/.test(trimmed) || // date patterns: 01/15, 15-01
    /\d{4}/.test(trimmed) || // contains a year
    /^(dear|hello|hi|to|from|subject|re:|tel:|phone:|email:)/i.test(trimmed) ||
    words.length < 2 || // single word: "Summary", "Jerusalem"
    words.length > 5 // 6+ words = likely a sentence
  ) {
    return false;
  }

  return /\p{L}/u.test(trimmed);
};

const fullName = realLines.find((line) => looksLikeName(line)) || 'Unknown Candidate';
```

**3. Keep the rest of the method unchanged** (email regex, phone regex, skills matching, return statement). Only the `fullName` assignment changes.

### Tests

**`extraction-agent.service.spec.ts`:**

```typescript
describe('extractDeterministically() - name detection', () => {
  let service: ExtractionAgentService;

  beforeEach(() => {
    service = new ExtractionAgentService(configService);
  });

  it('should skip CONFIDENTIAL header and find name', () => {
    const result = service.extractDeterministically('CONFIDENTIAL\nJohn Doe\nSenior Engineer\njohn@test.com');
    expect(result.full_name).toBe('John Doe');
  });

  it('should skip date line and find name', () => {
    const result = service.extractDeterministically('01/15/2024\nJane Smith\nEngineer');
    expect(result.full_name).toBe('Jane Smith');
  });

  it('should detect Hebrew name', () => {
    const result = service.extractDeterministically('אבי לוי\nמהנדס תוכנה\navi@test.com');
    expect(result.full_name).toBe('אבי לוי');
  });

  it('should detect Arabic name', () => {
    const result = service.extractDeterministically('محمد علي\nمهندس برمجيات');
    expect(result.full_name).toBe('محمد علي');
  });

  it('should handle hyphenated names', () => {
    const result = service.extractDeterministically('Jean-Pierre Dupont\nEngineer');
    expect(result.full_name).toBe('Jean-Pierre Dupont');
  });

  it('should reject single-word lines as names', () => {
    const result = service.extractDeterministically(
      'Summary\nThis document contains a very long professional description that spans many words.\n',
    );
    expect(result.full_name).toBe('Unknown Candidate');
  });

  it('should fallback to Unknown Candidate when no name found', () => {
    const result = service.extractDeterministically(
      'CONFIDENTIAL\nProfessional Summary\nThis is a long description of the candidate profile and experience.',
    );
    expect(result.full_name).toBe('Unknown Candidate');
  });

  it('should skip Curriculum Vitae header', () => {
    const result = service.extractDeterministically('Curriculum Vitae\nDavid Cohen\nSoftware Developer');
    expect(result.full_name).toBe('David Cohen');
  });

  it('should accept multi-part names (Maria de la Cruz)', () => {
    const result = service.extractDeterministically('Maria de la Cruz\nSenior Engineer');
    expect(result.full_name).toBe('Maria de la Cruz');
  });

  it('should accept Arabic multi-part name (عبد الرحمن الحسيني)', () => {
    const result = service.extractDeterministically('عبد الرحمن الحسيني\nمهندس برمجيات');
    expect(result.full_name).toBe('عبد الرحمن الحسيني');
  });
});
```

### Commit

```
fix(audit): Issue #7 — Unicode-aware name detection in deterministic fallback

- Expand header filter: CONFIDENTIAL, Curriculum Vitae, Resume, CV, etc.
- Add looksLikeName() heuristic with \p{L} Unicode support
- Require 2-5 words (rejects single words; allows "Maria de la Cruz")
- Skip dates, years, greetings, sentences
- Supports Latin, Hebrew, Arabic, and all Unicode scripts
- Fallback to "Unknown Candidate" when no valid name found
```

---

## Fix #6: Issue #3 — O(N) Job Matching Performance

**Problem:** `extractAllJobIdsFromEmailText()` fetches ALL active jobs for the tenant, iterates all, regex-tests each. O(N) for 5000+ jobs. System short_ids are plain numbers starting from 100.

**Solution:** Extract numeric tokens from email text, return them as candidate short_ids. Let the existing downstream query (`prisma.job.findMany` at line ~302) validate them against the DB. The function becomes a pure text parser — no DB query needed.

### Task 6.1: Refactor `extractAllJobIdsFromEmailText()`

**File:** `src/modules/ingestion/ingestion.processor.ts`

Replace the entire method (lines ~53-92) with:

```typescript
/**
 * Extract candidate short_ids from combined subject + body text.
 * Short_ids are plain numbers >= 100 (e.g., 100, 245, 1053).
 * Returns array of candidate short_id strings (may include false positives
 * like years or zip codes — the downstream DB query filters those out).
 */
private extractCandidateShortIds(
  subject: string | null | undefined,
  body: string | null | undefined,
): string[] {
  const combinedText = [subject, body].filter(Boolean).join(' ');

  if (!combinedText) return [];

  // Match all 3+ digit numbers as word boundaries
  const numberPattern = /\b(\d{3,})\b/g;
  const matches = [...combinedText.matchAll(numberPattern)];

  if (matches.length === 0) return [];

  // Filter >= 100, deduplicate, keep as strings (shortId is string type in DB)
  return [...new Set(
    matches.map(m => m[1]).filter(s => parseInt(s, 10) >= 100)
  )];
}
```

**Key differences from old method:**

- No `async`, no DB query — pure text parsing.
- No `tenantId` parameter needed (no DB access).
- Returns `string[]` (same type as before — shortId strings).
- Method renamed to `extractCandidateShortIds` to reflect it's no longer doing DB queries.

### Task 6.2: Update the caller in `process()`

In the `process()` method, around line ~289, replace:

```typescript
// OLD:
const matchedShortIds = await this.extractAllJobIdsFromEmailText(payload.Subject, payload.TextBody, tenantId);
```

with:

```typescript
// NEW:
const matchedShortIds = this.extractCandidateShortIds(payload.Subject, payload.TextBody);
```

**No other changes needed.** The existing code at line ~302 already queries jobs by shortId:

```typescript
if (matchedShortIds.length > 0) {
  const jobsData = await this.prisma.job.findMany({
    where: {
      tenantId,
      shortId: { in: matchedShortIds },
    },
    // ...
  });
```

**Add `status: 'open'` to this existing query** (the old function filtered by status internally, but the caller's query doesn't). Change the `where` clause to:

```typescript
where: {
  tenantId,
  shortId: { in: matchedShortIds },
  status: 'open',  // ← ADD THIS
},
```

### Tests

**`ingestion.processor.spec.ts`:**

```typescript
describe('extractCandidateShortIds()', () => {
  let processor: IngestionProcessor;

  it('should extract 3+ digit numbers from email text', () => {
    const result = processor['extractCandidateShortIds']('Apply for job 245', 'Also position 1053 is open');
    expect(result).toEqual(expect.arrayContaining(['245', '1053']));
    expect(result).toHaveLength(2);
  });

  it('should return empty for no numbers', () => {
    const result = processor['extractCandidateShortIds']('Hello', 'I want to apply');
    expect(result).toEqual([]);
  });

  it('should filter out numbers < 100', () => {
    const result = processor['extractCandidateShortIds']('I am 25 years old', 'Position 50 is closed');
    expect(result).toEqual([]);
  });

  it('should include years (false positives filtered by DB)', () => {
    const result = processor['extractCandidateShortIds']('In 2024 I applied', 'Job 101 is open');
    expect(result).toEqual(expect.arrayContaining(['2024', '101']));
  });

  it('should deduplicate repeated numbers', () => {
    const result = processor['extractCandidateShortIds']('Job 245 and job 245', 'Position 245');
    expect(result).toEqual(['245']);
  });

  it('should handle null subject and body', () => {
    const result = processor['extractCandidateShortIds'](null, null);
    expect(result).toEqual([]);
  });

  it('should return strings (matching shortId DB type)', () => {
    const result = processor['extractCandidateShortIds']('Job 100', null);
    expect(result[0]).toBe('100');
    expect(typeof result[0]).toBe('string');
  });
});
```

### Commit

```
fix(audit): Issue #3 — optimize job matching from O(N) to O(1) text parse

- Replace DB-backed extractAllJobIdsFromEmailText (fetched all jobs, iterated)
  with extractCandidateShortIds (pure text parsing, no DB query)
- Extract 3+ digit numbers (>= 100) as candidate shortIds
- Downstream findMany query validates against DB (filters false positives)
- Add status: 'open' filter to downstream job query
- Performance: eliminates O(N) DB fetch + N regex tests for 5000+ jobs
```

---

## Final Validation

After all 6 fixes:

```bash
npm test
```

Expected: 249+ tests passing, zero regressions.

## Summary of all changes by file

| File                                                 | Fixes                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------- |
| `src/modules/scoring/scoring.service.ts`             | #1 (truncation), #2 (Zod coercion)                            |
| `src/modules/extraction/extraction-agent.service.ts` | #1 (truncation), #2 (Zod coercion), #5 (name detection)       |
| `src/modules/dedup/dedup.service.ts`                 | #3 (add `tx` param to `check()`)                              |
| `src/modules/ingestion/ingestion.processor.ts`       | #3 (advisory lock), #4 (idempotency guard), #6 (job matching) |

**No Prisma schema changes. No migrations.**
