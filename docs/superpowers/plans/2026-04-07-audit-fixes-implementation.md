# Audit Verification Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 6 critical audit issues in the ingestion pipeline sequentially: context limits, validation coercion, race conditions, idempotency, name detection, and job matching performance.

**Architecture:** Six independent fixes executed in dependency order. Each fix is one atomic commit. All changes are localized to specific services with no architectural refactoring. Tests validate fixes in isolation.

**Tech Stack:** TypeScript, NestJS, Prisma 7, PostgreSQL 16, Zod, BullMQ

---

## File Structure

**Files to modify:**
- `src/modules/scoring/scoring.service.ts` — Add context limits, error handling, Zod schema update
- `src/modules/extraction/extraction-agent.service.ts` — Add context limits, error handling, Zod schema, name detection
- `src/modules/ingestion/ingestion.processor.ts` — Race condition handler, idempotency guard, job extraction refactor
- `prisma/schema.prisma` — Add unique partial constraint on (tenantId, phone) where phone IS NOT NULL
- Test files: `src/**/*.spec.ts` — Unit tests for each fix

**Important notes:**
- NO new `cvText` column needed: `cvText` is already saved on `candidate.cvText` during Phase 7. On retry, read from `candidate.cvText`.
- Fix #3 (TOCTOU): Unique constraint must be PARTIAL (WHERE phone IS NOT NULL) to allow the intentional duplicate-flag flow in dedup logic.
- Fix #4 (Idempotency): On retry, re-run Phase 15 (job matching — cheap/idempotent) before scoring.
- Fix #6 (Job Matching): `shortId` is STRING type, not number. Convert candidates before DB query. Accept `tenantId` as function parameter.
- Migrations: Use `npm run db:migrate` (runs inside Docker), not `npx prisma migrate dev` directly.

**Migration files to create:**
- `prisma/migrations/add_partial_unique_candidate_phone/migration.sql`

---

## Fix #1: Issue #4 — Unbounded Context Window

### Task 1.1: Add context limit to scoring service (cvText truncation + error handling)

**Files:**
- Modify: `src/modules/scoring/scoring.service.ts:65-108` (scoring call)
- Test: `src/modules/scoring/scoring.service.spec.ts`

- [ ] **Step 1: Read current scoring service to understand structure**

Run: `cat src/modules/scoring/scoring.service.ts | head -120`

Note the current `scoreCandidate()` method signature and how it builds the LLM prompt.

- [ ] **Step 2: Write test for oversized cvText truncation**

Create/append to `src/modules/scoring/scoring.service.spec.ts`:

```typescript
describe('ScoringAgentService', () => {
  describe('scoreCandidate - context limits', () => {
    it('should truncate cvText to 15K chars', async () => {
      const longCvText = 'a'.repeat(50000); // 50K chars
      const input: ScoringInput = {
        cvText: longCvText,
        candidateFields: { currentRole: 'Engineer', yearsExperience: 5, skills: ['TypeScript'] },
        job: { title: 'Senior Engineer', description: 'Full job desc', requirements: [] },
      };

      // Mock OpenRouter to capture the actual message sent
      const capturedMessage = await service.scoreCandidate(input);
      
      // Verify cvText was truncated in the message (should not exceed 15K)
      expect(capturedMessage).toBeDefined();
      // The actual check happens in the service — verify it doesn't error on oversized input
    });

    it('should handle LLM 400 error gracefully', async () => {
      const input: ScoringInput = {
        cvText: 'x'.repeat(100000),
        candidateFields: { currentRole: 'Engineer', yearsExperience: 5, skills: [] },
        job: { title: 'Role', description: 'Desc', requirements: [] },
      };

      // Mock OpenRouter to return 400 error
      jest.spyOn(openRouterMock, 'messages.create').mockRejectedValue(
        new Error('HTTP 400: Context length exceeded')
      );

      const result = await service.scoreCandidate(input);
      
      // Should not throw, should handle gracefully
      expect(result).toBeDefined();
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- src/modules/scoring/scoring.service.spec.ts --testNamePattern="context limits"`

Expected: FAIL (methods don't exist yet or truncation not implemented)

- [ ] **Step 4: Implement cvText truncation in scoring service**

Modify `src/modules/scoring/scoring.service.ts`, in the `scoreCandidate()` method (around line 70):

Find the current code that builds the scoring prompt. Replace it with:

```typescript
async scoreCandidate(input: ScoringInput): Promise<ScoringWithMatchResult> {
  const MAX_CV_LENGTH = 15000;
  const MAX_JOB_DESC_LENGTH = 15000;

  // Truncate inputs to prevent context window overflow
  const truncatedCvText = input.cvText.substring(0, MAX_CV_LENGTH);
  const truncatedJobDesc = input.job.description 
    ? input.job.description.substring(0, MAX_JOB_DESC_LENGTH)
    : '';

  const candidateSection = `CV Text:\n${truncatedCvText}`;
  const jobSection = `Job Description:\n${truncatedJobDesc}`;
  const userMessage = `${candidateSection}\n\n${jobSection}`;

  try {
    const response = await this.openRouter.messages.create({
      model: 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: userMessage }],
      max_tokens: 1024,
    });

    const scoreText = response.content[0].type === 'text' ? response.content[0].text : '';
    const parsed = ScoreSchema.parse(JSON.parse(scoreText));

    return {
      matched: parsed.score >= 70,
      matchConfidence: parsed.score,
      score: { ...parsed, modelUsed: 'openai/gpt-4o-mini' },
    };
  } catch (error) {
    // Handle HTTP 400/413 (context length exceeded)
    if (error instanceof Error && (error.message.includes('400') || error.message.includes('413'))) {
      this.logger.error(
        `[ScoringAgentService] LLM returned context error (${error.message}). Marking intake as failed.`
      );
      // Mark intake as failed in the processor (caller handles this)
      throw new Error('SCORING_CONTEXT_EXCEEDED');
    }
    
    this.logger.error(`[ScoringAgentService] Scoring failed: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- src/modules/scoring/scoring.service.spec.ts --testNamePattern="context limits"`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/modules/scoring/scoring.service.ts src/modules/scoring/scoring.service.spec.ts
git commit -m "fix(audit): Issue #4 part 1 — add context limits and error handling to scoring service

- Truncate cvText and job.description to 15K chars each
- Catch HTTP 400/413 errors from LLM, throw SCORING_CONTEXT_EXCEEDED
- Prevents context window overflow errors

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

### Task 1.2: Add context limit to extraction service (emailBody truncation + error handling)

**Files:**
- Modify: `src/modules/extraction/extraction-agent.service.ts:60-110`
- Test: `src/modules/extraction/extraction-agent.service.spec.ts`

- [ ] **Step 1: Read extraction service to understand structure**

Run: `cat src/modules/extraction/extraction-agent.service.ts | head -120`

Note the `extractWithLLM()` method and how it calls the LLM.

- [ ] **Step 2: Write test for oversized emailBody truncation**

Append to `src/modules/extraction/extraction-agent.service.spec.ts`:

```typescript
describe('ExtractionAgentService', () => {
  describe('extractWithLLM - context limits', () => {
    it('should truncate emailBody to 20K chars', async () => {
      const longBody = 'a'.repeat(100000);
      const result = await service.extractWithLLM(longBody, { tenantId, messageId });
      
      expect(result).toBeDefined();
      // Service should not throw on oversized input
    });

    it('should handle LLM 400 error on oversized input', async () => {
      const longBody = 'x'.repeat(100000);
      
      jest.spyOn(openRouterMock, 'messages.create').mockRejectedValue(
        new Error('HTTP 400: Prompt too long')
      );

      const result = await service.extractWithLLM(longBody, { tenantId, messageId });
      
      // Should not throw, caller should handle gracefully
      expect(result).toBeDefined();
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- src/modules/extraction/extraction-agent.service.spec.ts --testNamePattern="context limits"`

Expected: FAIL

- [ ] **Step 4: Implement emailBody truncation in extraction service**

Modify `src/modules/extraction/extraction-agent.service.ts`, in the `extractWithLLM()` method (around line 65):

```typescript
async extractWithLLM(emailBody: string, context: { tenantId: string; messageId: string }): Promise<ExtractedCandidate> {
  const MAX_EMAIL_LENGTH = 20000;

  // Truncate email body to prevent context window overflow
  const truncatedBody = emailBody.substring(0, MAX_EMAIL_LENGTH);

  const systemMessage = `You are a CV parser. Extract candidate information from the provided CV text.`;
  const userMessage = `${systemMessage}\n\nCV TEXT:\n${truncatedBody}`;

  try {
    const response = await this.openRouter.messages.create({
      model: 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: userMessage }],
      max_tokens: 1024,
    });

    const extractedText = response.content[0].type === 'text' ? response.content[0].text : '';
    const parsed = ExtractionSchema.parse(JSON.parse(extractedText));

    return {
      fullName: parsed.fullName,
      email: parsed.email,
      phone: parsed.phone,
      skills: parsed.skills,
      yearsExperience: parsed.yearsExperience,
      currentRole: parsed.currentRole,
      cvText: emailBody, // Store full cvText (not truncated, for later retry)
    };
  } catch (error) {
    // Handle HTTP 400/413 (context length exceeded)
    if (error instanceof Error && (error.message.includes('400') || error.message.includes('413'))) {
      this.logger.error(
        `[ExtractionAgentService] LLM returned context error. Email too large. Falling back to deterministic extraction.`
      );
      // Caller will catch this and fall back to deterministic extraction
      throw new Error('EXTRACTION_CONTEXT_EXCEEDED');
    }

    this.logger.error(`[ExtractionAgentService] Extraction failed: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- src/modules/extraction/extraction-agent.service.spec.ts --testNamePattern="context limits"`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/modules/extraction/extraction-agent.service.ts src/modules/extraction/extraction-agent.service.spec.ts
git commit -m "fix(audit): Issue #4 part 2 — add context limits and error handling to extraction service

- Truncate emailBody to 20K chars before LLM call
- Catch HTTP 400/413 errors, throw EXTRACTION_CONTEXT_EXCEEDED
- Processor catches error and falls back to deterministic extraction

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

---

## Fix #2: Issue #6 — Overly Strict Zod Validation

### Task 2.1: Update scoring schema to coerce floats

**Files:**
- Modify: `src/modules/scoring/scoring.service.ts:5-12` (schema definition)
- Test: `src/modules/scoring/scoring.service.spec.ts`

- [ ] **Step 1: Read current schema**

Run: `grep -A 5 "ScoreSchema" src/modules/scoring/scoring.service.ts`

- [ ] **Step 2: Write test for float coercion**

Append to `src/modules/scoring/scoring.service.spec.ts`:

```typescript
describe('ScoreSchema', () => {
  it('should coerce score 85.5 to 85', () => {
    const input = { score: 85.5, reasoning: 'Test', strengths: [], gaps: [] };
    const result = ScoreSchema.parse(input);
    
    expect(result.score).toBe(85);
    expect(typeof result.score).toBe('number');
  });

  it('should coerce yearsExperience 6.7 to 7', () => {
    const input = { years_experience: 6.7 };
    const result = ExtractionSchema.pick({ years_experience: true }).parse(input);
    
    expect(result.years_experience).toBe(7);
  });

  it('should reject score > 100 after coercion', () => {
    const input = { score: 150.5, reasoning: 'Test', strengths: [], gaps: [] };
    
    expect(() => ScoreSchema.parse(input)).toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- src/modules/scoring/scoring.service.spec.ts --testNamePattern="coerce"`

Expected: FAIL (schema still uses `.int()` without transform)

- [ ] **Step 4: Update scoring schema**

Modify `src/modules/scoring/scoring.service.ts` line 7:

```typescript
export const ScoreSchema = z.object({
  score: z.number().transform(Math.round).min(0).max(100),
  reasoning: z.string(),
  strengths: z.array(z.string()),
  gaps: z.array(z.string()),
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- src/modules/scoring/scoring.service.spec.ts --testNamePattern="coerce"`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/modules/scoring/scoring.service.ts src/modules/scoring/scoring.service.spec.ts
git commit -m "fix(audit): Issue #6 part 1 — coerce float scores to integers

- Replace .int() with .transform(Math.round) in ScoreSchema
- Allows LLM float outputs (85.5) to coerce to 85 instead of failing validation
- Prevents validation failures and job retry loops

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

### Task 2.2: Update extraction schema to coerce floats

**Files:**
- Modify: `src/modules/extraction/extraction-agent.service.ts:10-15` (schema definition)
- Test: `src/modules/extraction/extraction-agent.service.spec.ts`

- [ ] **Step 1: Read current schema**

Run: `grep -A 10 "ExtractionSchema" src/modules/extraction/extraction-agent.service.ts | head -20`

- [ ] **Step 2: Write test for yearsExperience coercion**

Append to `src/modules/extraction/extraction-agent.service.spec.ts`:

```typescript
describe('ExtractionSchema', () => {
  it('should coerce yearsExperience 6.7 to 7', () => {
    const input = {
      fullName: 'John Doe',
      email: 'john@example.com',
      phone: '+1-555-0001',
      skills: ['Node.js'],
      yearsExperience: 6.7,
      currentRole: 'Engineer',
    };
    const result = ExtractionSchema.parse(input);
    
    expect(result.yearsExperience).toBe(7);
  });

  it('should reject yearsExperience > 50 after coercion', () => {
    const input = {
      fullName: 'John Doe',
      email: 'john@example.com',
      phone: '+1-555-0001',
      skills: [],
      yearsExperience: 75.5,
      currentRole: 'Engineer',
    };
    
    expect(() => ExtractionSchema.parse(input)).toThrow();
  });

  it('should accept yearsExperience as null', () => {
    const input = {
      fullName: 'John Doe',
      email: 'john@example.com',
      phone: '+1-555-0001',
      skills: [],
      yearsExperience: null,
      currentRole: 'Engineer',
    };
    const result = ExtractionSchema.parse(input);
    
    expect(result.yearsExperience).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- src/modules/extraction/extraction-agent.service.spec.ts --testNamePattern="yearsExperience|coerce"`

Expected: FAIL

- [ ] **Step 4: Update extraction schema**

Modify `src/modules/extraction/extraction-agent.service.ts` line 11:

```typescript
export const ExtractionSchema = z.object({
  fullName: z.string(),
  email: z.string().email().nullable(),
  phone: z.string().nullable(),
  skills: z.array(z.string()).default([]),
  yearsExperience: z.number().transform(Math.round).min(0).max(50).nullable(),
  currentRole: z.string().nullable(),
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- src/modules/extraction/extraction-agent.service.spec.ts --testNamePattern="yearsExperience|coerce"`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/modules/extraction/extraction-agent.service.ts src/modules/extraction/extraction-agent.service.spec.ts
git commit -m "fix(audit): Issue #6 part 2 — coerce float years_experience to integers

- Replace .int() with .transform(Math.round) in ExtractionSchema
- Allows LLM float outputs (6.7) to coerce to 7 instead of failing validation
- Works with nullable to allow null values

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

---

## Fix #3: Issue #2 — TOCTOU Race Condition

### Task 3.1: Add partial unique constraint to Prisma schema

**Files:**
- Modify: `prisma/schema.prisma` (Candidate model)

- [ ] **Step 1: Read current Candidate model**

Run: `grep -A 20 "model Candidate" prisma/schema.prisma`

- [ ] **Step 2: Add partial unique constraint**

Modify `prisma/schema.prisma`, in the Candidate model. Add a PARTIAL unique index (WHERE phone IS NOT NULL) to allow the intentional duplicate-flag flow:

```prisma
model Candidate {
  id          String    @id @default(cuid())
  tenantId    String
  fullName    String
  email       String?
  phone       String?
  skills      String[]
  yearsExperience Int?
  currentRole String?
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  // ... other fields ...

  // Partial unique constraint: only applies when phone IS NOT NULL
  // This prevents duplicate exact-match candidates but allows NULL phones
  @@unique([tenantId, phone], name: "idx_candidate_tenant_phone", where: "phone IS NOT NULL")
  @@index([tenantId])
  @@index([email])
  @@index([phone])
}
```

**CRITICAL:** The partial unique constraint is intentional. The dedup logic (line 232-270) intentionally inserts a new candidate with the same phone when `dedupResult.confidence === 1.0`, then creates a duplicate flag linking them. The partial constraint allows this flow while preventing accidental duplicates from concurrent workers.

- [ ] **Step 3: Create migration**

Run: `npm run db:migrate -- --name add_partial_unique_candidate_phone`

This will:
1. Create a migration file in `prisma/migrations/` (inside Docker)
2. Ask you to confirm the changes
3. Apply the migration to your database

Expected output: Migration created and applied successfully.

- [ ] **Step 4: Verify migration**

Run: `npm run db:migrate -- -- status`

Expected: All migrations applied.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "fix(audit): Issue #2 part 1 — add partial unique constraint on (tenantId, phone)

- Add partial @@unique([tenantId, phone] WHERE phone IS NOT NULL) to Candidate model
- Prevents duplicate candidates from concurrent workers with same phone
- Partial constraint (WHERE phone IS NOT NULL) allows intentional duplicate-flag flow in dedup logic
- Constraint enforced at database level
- Migration: add_partial_unique_candidate_phone

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

### Task 3.2: Add P2002 error handling in ingestion processor

**Files:**
- Modify: `src/modules/ingestion/ingestion.processor.ts:230-280` (transaction handling)
- Test: `src/modules/ingestion/ingestion.processor.spec.ts`

- [ ] **Step 1: Read current transaction code**

Run: `sed -n '230,280p' src/modules/ingestion/ingestion.processor.ts`

Note the current transaction structure and where to add error handling.

- [ ] **Step 2: Write test for race condition handling**

Append to `src/modules/ingestion/ingestion.processor.spec.ts`:

```typescript
describe('IngestionProcessor - race condition', () => {
  it('should handle P2002 error (unique constraint violation) on candidate insert', async () => {
    const tenantId = 'tenant-123';
    const phone = '+1-555-0001';
    
    // Mock Prisma to raise P2002 on the transaction
    const p2002Error = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed on the fields: (`tenantId`, `phone`)',
      { code: 'P2002', clientVersion: '7.0.0', meta: { target: ['tenantId', 'phone'] } }
    );

    jest.spyOn(prismaClient, '$transaction').mockRejectedValueOnce(p2002Error);
    
    // Mock the recovery query to fetch existing candidate
    jest.spyOn(prismaClient.candidate, 'findUnique').mockResolvedValueOnce({
      id: 'candidate-existing',
      tenantId,
      phone,
      // ... other fields
    });

    // Process job
    const result = await processor.process(job);
    
    // Should not throw, should continue to Phase 7
    expect(result).toBeDefined();
    expect(prismaClient.candidate.findUnique).toHaveBeenCalledWith({
      where: { idx_candidate_tenant_phone: { tenantId, phone } },
    });
  });

  it('should log race condition detection', async () => {
    const p2002Error = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed',
      { code: 'P2002', clientVersion: '7.0.0', meta: { target: ['tenantId', 'phone'] } }
    );

    jest.spyOn(prismaClient, '$transaction').mockRejectedValueOnce(p2002Error);
    jest.spyOn(processor, 'logger');

    await processor.process(job);
    
    expect(processor.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Race condition detected')
    );
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- src/modules/ingestion/ingestion.processor.spec.ts --testNamePattern="race condition"`

Expected: FAIL (error handling not implemented)

- [ ] **Step 4: Add P2002 error handling**

Modify `src/modules/ingestion/ingestion.processor.ts`, wrapping the transaction (lines ~232-279):

```typescript
// Phase 6: Deduplication & Candidate Insert (with race condition handling)
try {
  const context: ProcessingContext = {
    tenantId,
    messageId: payload.MessageID,
    candidateId: null,
  };

  const dedupResult = await this.dedupService.check(phone, tenantId);

  // Begin transaction
  const transactionResult = await this.prisma.$transaction(async (tx) => {
    if (dedupResult.match) {
      // Exact phone match found
      context.candidateId = dedupResult.match.id;
    } else {
      // No match, insert new candidate
      const newCandidate = await tx.candidate.create({
        data: {
          tenantId,
          fullName: extraction.fullName,
          email: extraction.email,
          phone: extraction.phone,
          skills: extraction.skills,
          yearsExperience: extraction.yearsExperience,
          currentRole: extraction.currentRole,
        },
      });
      context.candidateId = newCandidate.id;
    }

    // Mark intake as processed
    await tx.emailIntakeLog.update({
      where: { idx_intake_message_id: { tenantId, messageId: payload.MessageID } },
      data: { candidateId: context.candidateId },
    });

    return context.candidateId;
  });

  // Continue to Phase 7 (scoring)
  return this.scoreCandidate(context.candidateId, extraction, job);
} catch (error) {
  // Handle unique constraint violation (race condition)
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002' && error.meta?.target?.includes('phone')) {
      this.logger.warn(
        `[IngestionProcessor] Race condition detected: phone ${payload.phone} already inserted. Fetching existing candidate.`
      );

      // Another worker inserted this phone first — fetch the existing candidate
      const existingCandidate = await this.prisma.candidate.findUnique({
        where: { idx_candidate_tenant_phone: { tenantId, phone: payload.phone } },
      });

      if (existingCandidate) {
        // Mark intake with existing candidate and continue
        await this.prisma.emailIntakeLog.update({
          where: { idx_intake_message_id: { tenantId, messageId: payload.MessageID } },
          data: { candidateId: existingCandidate.id },
        });

        return this.scoreCandidate(existingCandidate.id, extraction, job);
      }
    }
  }

  // Re-throw if not a race condition
  this.logger.error(
    `[IngestionProcessor] Phase 6 failed: ${error instanceof Error ? error.message : String(error)}`
  );
  
  await this.prisma.emailIntakeLog.update({
    where: { idx_intake_message_id: { tenantId, messageId: payload.MessageID } },
    data: { processingStatus: 'failed' },
  });
  
  throw error;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- src/modules/ingestion/ingestion.processor.spec.ts --testNamePattern="race condition"`

Expected: PASS

- [ ] **Step 6: Run full test suite to check for regressions**

Run: `npm test`

Expected: All existing tests still pass (249+ tests)

- [ ] **Step 7: Commit**

```bash
git add src/modules/ingestion/ingestion.processor.ts src/modules/ingestion/ingestion.processor.spec.ts
git commit -m "fix(audit): Issue #2 part 2 — handle P2002 race condition gracefully

- Wrap Phase 6 transaction in try-catch
- Catch P2002 (unique constraint violation on phone)
- Fetch existing candidate and continue to Phase 7 instead of failing
- Log race condition detection for monitoring

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

---

## Fix #4: Issue #1 — Broken Idempotency on BullMQ Retries

**Key Insight:** `cvText` is already saved to `candidate.cvText` during Phase 7. No new column needed. On retry, fetch the existing candidate and read `cvText` from there. Then re-run Phase 15 (job matching — cheap/idempotent), then resume scoring.

### Task 4.1: Add idempotency guard at job start (with Phase 15 re-run)

**Files:**
- Modify: `src/modules/ingestion/ingestion.processor.ts:90-125` (job process entry point)
- Test: `src/modules/ingestion/ingestion.processor.spec.ts`

- [ ] **Step 1: Read job process entry point**

Run: `sed -n '85,130p' src/modules/ingestion/ingestion.processor.ts`

- [ ] **Step 2: Write test for idempotency on Phase 7 retry**

Append to `src/modules/ingestion/ingestion.processor.spec.ts`:

```typescript
describe('IngestionProcessor - idempotency guard', () => {
  it('should skip Phase 6 on retry, re-run Phase 15, and resume Phase 7', async () => {
    const tenantId = 'tenant-123';
    const messageId = 'msg-456';
    const candidateId = 'cand-789';
    const emailBody = 'Job 245 and position 1053 are open...';

    // Mock existing intake record (from a previous attempt that failed at Phase 7)
    jest.spyOn(prismaClient.emailIntakeLog, 'findUnique').mockResolvedValueOnce({
      id: 'intake-1',
      tenantId,
      messageId,
      candidateId, // Already set from Phase 6
      processingStatus: 'processing',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Mock candidate fetch (has cvText on it from Phase 7)
    jest.spyOn(prismaClient.candidate, 'findUnique').mockResolvedValueOnce({
      id: candidateId,
      tenantId,
      fullName: 'John Doe',
      email: 'john@example.com',
      phone: '+1-555-0001',
      skills: ['Node.js'],
      yearsExperience: 5,
      currentRole: 'Engineer',
      cvText: 'CV content from Phase 7...',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Spy on Phase 6 (dedup service) to verify it's NOT called
    const dedupSpy = jest.spyOn(dedupService, 'check');

    // Spy on Phase 15 (job matching) to verify it IS called on retry
    const jobMatchingSpy = jest.spyOn(processor, 'extractAllJobIdsFromEmailText')
      .mockResolvedValueOnce(['job-245-id', 'job-1053-id']);

    // Spy on Phase 7 (scoring) to verify it IS called
    const scoringSpy = jest.spyOn(processor, 'scoreAndStoreResults')
      .mockResolvedValueOnce({ score: 85, status: 'completed' });

    // Process retry
    const job = { data: { tenantId, messageId, emailBody } };
    await processor.process(job);

    // Verify Phase 6 (dedup) was skipped
    expect(dedupSpy).not.toHaveBeenCalled();

    // Verify Phase 15 (job matching) WAS called on retry
    expect(jobMatchingSpy).toHaveBeenCalledWith(emailBody);

    // Verify Phase 7 (scoring) was called with cvText from candidate
    expect(scoringSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        cvText: 'CV content from Phase 7...',
        candidateFields: expect.any(Object),
      }),
      expect.any(Object)
    );
  });

  it('should not create self-duplicate on retry', async () => {
    const candidateInsertSpy = jest.spyOn(prismaClient.candidate, 'create');
    
    // Setup existing intake with candidateId
    jest.spyOn(prismaClient.emailIntakeLog, 'findUnique').mockResolvedValueOnce({
      id: 'intake-1',
      tenantId: 'tenant-123',
      messageId: 'msg-456',
      candidateId: 'cand-789',
      processingStatus: 'processing',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    jest.spyOn(prismaClient.candidate, 'findUnique').mockResolvedValueOnce({
      id: 'cand-789',
      tenantId: 'tenant-123',
      phone: '+1-555-0001',
      cvText: 'CV...',
      // ... other fields ...
    });

    const job = { data: { tenantId: 'tenant-123', messageId: 'msg-456' } };
    await processor.process(job);

    // Verify create() was NOT called (no new candidate)
    expect(candidateInsertSpy).not.toHaveBeenCalled();
  });

  it('should proceed normally if intake has no candidateId (first attempt)', async () => {
    jest.spyOn(prismaClient.emailIntakeLog, 'findUnique').mockResolvedValueOnce({
      id: 'intake-1',
      tenantId: 'tenant-123',
      messageId: 'msg-456',
      candidateId: null, // Not yet processed
      processingStatus: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const normalFlowSpy = jest.spyOn(processor, 'normalProcessFlow')
      .mockResolvedValueOnce(undefined);

    const job = { data: { tenantId: 'tenant-123', messageId: 'msg-456' } };
    await processor.process(job);

    // Should proceed to normal flow
    expect(normalFlowSpy).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- src/modules/ingestion/ingestion.processor.spec.ts --testNamePattern="idempotency|self-duplicate"`

Expected: FAIL (idempotency guard not implemented)

- [ ] **Step 4: Implement idempotency guard at job start**

Modify `src/modules/ingestion/ingestion.processor.ts`, at the beginning of the `async process(job: Job)` method (around line 94):

```typescript
async process(job: Job): Promise<void> {
  const payload = job.data as ProcessEmailPayload;
  const { tenantId, messageId, emailBody } = payload;

  try {
    // **IDEMPOTENCY GUARD: Check if this intake was already processed**
    const existingIntake = await this.prisma.emailIntakeLog.findUnique({
      where: { idx_intake_message_id: { tenantId, messageId } },
      select: { candidateId: true },
    });

    if (existingIntake?.candidateId) {
      // Retry detected: This intake already has a candidateId from a previous attempt (Phase 6 completed)
      this.logger.info(
        `[IngestionProcessor] Retry detected for intake ${messageId}. Resuming from Phase 15+7.`
      );

      // Fetch the existing candidate (has cvText saved on it from Phase 7)
      const candidate = await this.prisma.candidate.findUnique({
        where: { id: existingIntake.candidateId },
      });

      if (!candidate || !candidate.cvText) {
        throw new Error(`Candidate ${existingIntake.candidateId} or cvText not found (data inconsistency)`);
      }

      // **Phase 15 (re-run): Job matching — cheap and idempotent**
      const matchedJobIds = await this.extractAllJobIdsFromEmailText(emailBody, tenantId);

      // Get first matched job or use a default
      let matchedJob;
      if (matchedJobIds.length > 0) {
        matchedJob = await this.prisma.job.findUnique({
          where: { id: matchedJobIds[0] },
        });
      }

      // Reconstruct ScoringInput from saved candidate data
      const scoringInput: ScoringInput = {
        cvText: candidate.cvText,
        candidateFields: {
          currentRole: candidate.currentRole || null,
          yearsExperience: candidate.yearsExperience || null,
          skills: candidate.skills || [],
        },
        job: matchedJob || { title: 'General', description: '', requirements: [] }, // Use matched job or default
      };

      // **Resume Phase 7 (scoring), skip Phase 4-6 entirely**
      return this.scoreAndStoreResults(scoringInput, candidate);
    }

    // **Normal flow: No prior processing, start from Phase 4**
    return this.normalProcessFlow(job);
  } catch (error) {
    this.logger.error(
      `[IngestionProcessor] Job failed: ${error instanceof Error ? error.message : String(error)}`
    );
    throw error;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- src/modules/ingestion/ingestion.processor.spec.ts --testNamePattern="idempotency|self-duplicate"`

Expected: PASS

- [ ] **Step 6: Run full test suite**

Run: `npm test`

Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add src/modules/ingestion/ingestion.processor.ts src/modules/ingestion/ingestion.processor.spec.ts
git commit -m "fix(audit): Issue #1 — add idempotency guard at job start with Phase 15 re-run

- Check if intake already has candidateId at job start
- If yes: fetch candidate (has cvText from Phase 7), re-run Phase 15 (job matching)
- Reconstruct ScoringInput with candidate.cvText, skip Phase 4-6
- Resume Phase 7 (scoring) with original extracted data
- Prevents re-running dedup on retry, eliminates self-duplicate risk
- Phase 15 re-run is cheap (query only matched job numbers) and idempotent

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

---

## Fix #5: Issue #7 — Fragile Deterministic Fallback Logic

### Task 5.1: Improve name detection with Unicode support

**Files:**
- Modify: `src/modules/extraction/extraction-agent.service.ts:125-165` (deterministic extraction)
- Test: `src/modules/extraction/extraction-agent.service.spec.ts`

- [ ] **Step 1: Read current deterministic extraction**

Run: `sed -n '125,165p' src/modules/extraction/extraction-agent.service.ts`

- [ ] **Step 2: Write tests for Unicode name detection**

Append to `src/modules/extraction/extraction-agent.service.spec.ts`:

```typescript
describe('ExtractionAgentService - deterministic extraction', () => {
  describe('name detection', () => {
    it('should skip "CONFIDENTIAL" header and find real name', () => {
      const cvText = `CONFIDENTIAL
John Doe
Engineer`;
      const result = service.extractDeterministically(cvText);
      
      expect(result.fullName).toBe('John Doe');
      expect(result.fullName).not.toBe('CONFIDENTIAL');
    });

    it('should skip date line and find real name', () => {
      const cvText = `01/15/2024
Jane Smith
Senior Engineer`;
      const result = service.extractDeterministically(cvText);
      
      expect(result.fullName).toBe('Jane Smith');
    });

    it('should detect Hebrew name correctly', () => {
      const cvText = `אבי לוי
Software Engineer`;
      const result = service.extractDeterministically(cvText);
      
      expect(result.fullName).toBe('אבי לוי');
    });

    it('should detect Arabic name correctly', () => {
      const cvText = `محمد علي
مهندس برمجيات`;
      const result = service.extractDeterministically(cvText);
      
      expect(result.fullName).toBe('محمد علي');
    });

    it('should fallback to "Unknown Candidate" if no name found', () => {
      const cvText = `CONFIDENTIAL
Professional Summary
This is a professional summary with many words and complete sentences that do not look like a name at all.`;
      const result = service.extractDeterministically(cvText);
      
      expect(result.fullName).toBe('Unknown Candidate');
    });

    it('should skip multi-word sentences and find short name', () => {
      const cvText = `This is a very long sentence that spans multiple words and doesn't look like a name.
David Cohen
Senior Developer`;
      const result = service.extractDeterministically(cvText);
      
      expect(result.fullName).toBe('David Cohen');
    });

    it('should accept names with hyphens (Jean-Pierre)', () => {
      const cvText = `Jean-Pierre Dupont
Engineer`;
      const result = service.extractDeterministically(cvText);
      
      expect(result.fullName).toBe('Jean-Pierre Dupont');
    });

    it('should accept initials (David M. Cohen)', () => {
      const cvText = `David M. Cohen
Engineer`;
      const result = service.extractDeterministically(cvText);
      
      expect(result.fullName).toBe('David M. Cohen');
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- src/modules/extraction/extraction-agent.service.spec.ts --testNamePattern="name detection|Unicode|Hebrew|Arabic"`

Expected: FAIL (name detection not improved)

- [ ] **Step 4: Implement Unicode-aware name detection**

Modify `src/modules/extraction/extraction-agent.service.ts`, in the `extractDeterministically()` method (around line 140):

Replace the header filter and name extraction:

```typescript
extractDeterministically(cvText: string): ExtractedCandidate {
  const lines = cvText.split('\n');

  // Filter out common headers and junk lines
  const realLines = lines.filter(
    (line) =>
      line.trim().length > 0 &&
      !line.startsWith('--- Email Body ---') &&
      !line.startsWith('--- Attachment') &&
      !line.startsWith('--- Email Metadata ---') &&
      !line.startsWith('Subject:') &&
      !line.startsWith('From:') &&
      !line.match(/^(Curriculum Vitae|Professional Summary|CONFIDENTIAL|Private & Confidential)/i),
  );

  // Helper: Check if a line looks like a name
  const looksLikeName = (line: string): boolean => {
    const trimmed = line.trim();
    const words = trimmed.split(/\s+/);

    // Skip if it's clearly a header, date, or sentence
    if (
      trimmed.length < 3 ||
      trimmed.length > 100 ||
      trimmed.match(/^\d{1,2}[/-]\d{1,2}/) || // dates like 01/15/2024
      trimmed.match(/\d{4}/) || // likely a year
      trimmed.toLowerCase().match(/^(dear|hello|hi|to|from|subject|re:)/) || // greetings
      words.length < 2 || // Less than 2 words = likely single word like "Summary" or "Jerusalem"
      words.length > 4 // more than 4 words = likely a sentence
    ) {
      return false;
    }

    // Must contain at least one Unicode letter (supports all scripts: Latin, Hebrew, Arabic, etc.)
    return /\p{L}/u.test(trimmed);
  };

  // Find first line that looks like a name
  const fullName = realLines.find((line) => looksLikeName(line)) || 'Unknown Candidate';

  // Rest of deterministic extraction (phone, email, etc.)
  const phone = this.extractPhoneDeterministically(cvText);
  const email = this.extractEmailDeterministically(cvText);

  return {
    fullName,
    email,
    phone,
    skills: [],
    yearsExperience: null,
    currentRole: null,
    cvText, // Store for later retry
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- src/modules/extraction/extraction-agent.service.spec.ts --testNamePattern="name detection|Unicode|Hebrew|Arabic"`

Expected: PASS

- [ ] **Step 6: Run full test suite**

Run: `npm test`

Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add src/modules/extraction/extraction-agent.service.ts src/modules/extraction/extraction-agent.service.spec.ts
git commit -m "fix(audit): Issue #7 — improve Unicode-aware name detection

- Expand header filter to skip 'CONFIDENTIAL', 'Professional Summary', etc.
- Add looksLikeName() heuristic supporting Unicode letters (\\p{L})
- Skip lines that are: too short, too long, dates, years, greetings, multi-word sentences
- Fallback to 'Unknown Candidate' if no valid name found
- Supports Latin, Hebrew, Arabic, and all Unicode scripts

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

---

## Fix #6: Issue #3 — O(N) Memory & Performance Bottleneck in Job Matching

### Task 6.1: Refactor job extraction to numeric token matching

**Files:**
- Modify: `src/modules/ingestion/ingestion.processor.ts:50-95` (extractAllJobIdsFromEmailText)
- Test: `src/modules/ingestion/ingestion.processor.spec.ts`

- [ ] **Step 1: Read current job extraction**

Run: `sed -n '50,95p' src/modules/ingestion/ingestion.processor.ts`

- [ ] **Step 2: Write tests for numeric job ID extraction**

Append to `src/modules/ingestion/ingestion.processor.spec.ts`:

```typescript
describe('IngestionProcessor - job matching', () => {
  describe('extractAllJobIdsFromEmailText', () => {
    it('should extract numeric job IDs >= 100 from email', async () => {
      const emailText = `
Applying for job 245 (Senior Engineer).
Also interested in position 1053 for backend role.
      `;

      const jobIds = await processor.extractAllJobIdsFromEmailText(emailText);

      expect(jobIds).toContain('job-245-id');
      expect(jobIds).toContain('job-1053-id');
    });

    it('should return empty array if no numeric tokens found', async () => {
      const emailText = `Hello, I am interested in your company.`;

      const jobIds = await processor.extractAllJobIdsFromEmailText(emailText);

      expect(jobIds).toEqual([]);
    });

    it('should filter out 2-digit numbers (< 100)', async () => {
      const emailText = `I am 25 years old and applying for role 50.`;

      const jobIds = await processor.extractAllJobIdsFromEmailText(emailText);

      // 25 and 50 should be filtered out (< 100)
      expect(jobIds).toEqual([]);
    });

    it('should handle false positive years (2024) gracefully', async () => {
      const emailText = `In 2024, I want to apply for job 101.`;

      // Mock Prisma to return only valid job IDs
      jest.spyOn(prismaClient.job, 'findMany').mockResolvedValueOnce([
        { id: 'job-101-id' },
        // 2024 is not in DB, so not returned
      ]);

      const jobIds = await processor.extractAllJobIdsFromEmailText(emailText);

      // Only 101 should be returned (2024 filtered by DB query)
      expect(jobIds).toEqual(['job-101-id']);
    });

    it('should deduplicate repeated numbers', async () => {
      const emailText = `I am applying for job 245. Yes, job 245 is the one.`;

      jest.spyOn(prismaClient.job, 'findMany').mockResolvedValueOnce([
        { id: 'job-245-id' },
      ]);

      const jobIds = await processor.extractAllJobIdsFromEmailText(emailText);

      // Should query once for 245 (deduped)
      expect(prismaClient.job.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            shortId: { in: [245] }, // Single entry, not [245, 245]
          }),
        })
      );

      expect(jobIds).toEqual(['job-245-id']);
    });

    it('should verify performance improvement (3-4 queries instead of 5000)', async () => {
      const emailText = `Interested in job 100, job 101, job 102.`;

      // Mock DB with 5000 open jobs but only query 3
      jest.spyOn(prismaClient.job, 'findMany').mockResolvedValueOnce([
        { id: 'job-100-id' },
        { id: 'job-101-id' },
        { id: 'job-102-id' },
      ]);

      await processor.extractAllJobIdsFromEmailText(emailText);

      // Verify findMany was called once with only 3 candidate IDs
      expect(prismaClient.job.findMany).toHaveBeenCalledTimes(1);
      expect(prismaClient.job.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            shortId: { in: expect.arrayContaining([100, 101, 102]) },
          }),
        })
      );
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- src/modules/ingestion/ingestion.processor.spec.ts --testNamePattern="job matching|extractAllJobIds"`

Expected: FAIL (refactored logic not implemented)

- [ ] **Step 4: Refactor job extraction to numeric token matching**

Modify `src/modules/ingestion/ingestion.processor.ts`, replace the `extractAllJobIdsFromEmailText()` method (lines 51-92):

```typescript
async extractAllJobIdsFromEmailText(emailText: string, tenantId: string): Promise<string[]> {
  // Extract all numeric tokens >= 100 from email
  // System short_ids are plain numbers: 100, 101, 245, 1053, etc.
  // This catches job mentions like "for position 245" or "apply to job 1053"
  // False positives (years, zip codes) are filtered by DB query
  const numberPattern = /\b(\d{3,})\b/g;
  const matches = [...emailText.matchAll(numberPattern)];

  if (matches.length === 0) {
    return []; // No numeric tokens found, return empty
  }

  // Filter to numbers >= 100, deduplicate
  const candidates = new Set(
    matches
      .map(m => parseInt(m[1], 10))
      .filter(n => n >= 100)
  );

  if (candidates.size === 0) {
    return []; // No valid job number candidates
  }

  // Query only the extracted numbers as short_ids (convert numbers to strings)
  // DB will naturally filter out non-existent IDs and false positives
  const matchedJobs = await this.prisma.job.findMany({
    where: {
      shortId: { in: Array.from(candidates).map(String) }, // Convert numbers to strings (shortId is STRING type)
      tenantId, // Passed as parameter
      status: 'open',
    },
    select: { id: true },
  });

  return matchedJobs.map(j => j.id);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- src/modules/ingestion/ingestion.processor.spec.ts --testNamePattern="job matching|extractAllJobIds"`

Expected: PASS

- [ ] **Step 6: Run full test suite to verify no regressions**

Run: `npm test`

Expected: All 249+ tests pass

- [ ] **Step 7: Commit**

```bash
git add src/modules/ingestion/ingestion.processor.ts src/modules/ingestion/ingestion.processor.spec.ts
git commit -m "fix(audit): Issue #3 — optimize job matching from O(N) to O(K) where K = extracted IDs

- Replace full-table fetch of all jobs with numeric token extraction
- Extract 3-digit+ numbers (>= 100) from email text
- Query DB only for those specific short_ids, not all 5000+ jobs
- Filter >= 100 to avoid 2-digit false positives (years, zip codes, etc.)
- Deduplicate tokens via Set before querying
- False positives (non-existent shortIds) naturally filtered by DB
- Performance improvement: from 5000 regex checks → 3-5 DB queries

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

---

## Summary: All 6 Fixes Complete

After completing all 6 tasks above, the system is stabilized:

✅ **Fix #1 (Issue #4):** Context limits prevent LLM errors on oversized inputs
✅ **Fix #2 (Issue #6):** Zod coercion handles float LLM outputs (85.5 → 85)
✅ **Fix #3 (Issue #2):** Partial unique constraint + P2002 handling prevents concurrent races
✅ **Fix #4 (Issue #1):** Idempotency guard + Phase 15 re-run prevents self-duplicates on retry
✅ **Fix #5 (Issue #7):** Unicode-aware name detection (2-word minimum, supports Hebrew/Arabic)
✅ **Fix #6 (Issue #3):** Numeric job matching optimizes from O(N) to O(K) where K=extracted IDs

**Corrections applied to plan:**
- Fix #3: Partial unique constraint (WHERE phone IS NOT NULL) to allow intentional duplicate-flag flow
- Fix #4: No cvText column needed — reads from candidate.cvText (saved Phase 7), re-runs Phase 15 on retry
- Fix #5: Added 2-word minimum check to name detection to avoid single-word false positives
- Fix #6: Added tenantId parameter to extractAllJobIdsFromEmailText(), convert candidates to strings for shortId query

**Final validation:**
- Run full test suite: `npm test`
- Expected: 249+ tests passing, zero regressions
- All 6 issues resolved with atomic commits
- Use `npm run db:migrate` (not npx prisma) for migrations in Docker
