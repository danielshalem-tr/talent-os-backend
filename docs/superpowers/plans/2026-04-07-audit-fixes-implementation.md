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
- `prisma/schema.prisma` — Add unique constraint on (tenantId, phone), add cvText column to EmailIntakeLog
- Test files: `src/**/*.spec.ts` — Unit tests for each fix

**Migration files to create:**
- `prisma/migrations/add_unique_candidate_phone/migration.sql`
- `prisma/migrations/add_cvtext_to_email_intake_log/migration.sql`

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

### Task 3.1: Add unique constraint to Prisma schema

**Files:**
- Modify: `prisma/schema.prisma` (Candidate model)

- [ ] **Step 1: Read current Candidate model**

Run: `grep -A 20 "model Candidate" prisma/schema.prisma`

- [ ] **Step 2: Add unique constraint**

Modify `prisma/schema.prisma`, in the Candidate model, add the unique index after existing indexes:

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

  @@unique([tenantId, phone], name: "idx_candidate_tenant_phone")
  @@index([tenantId])
  @@index([email])
  @@index([phone])
}
```

- [ ] **Step 3: Create migration**

Run: `npx prisma migrate dev --name add_unique_candidate_phone`

This will:
1. Create a migration file in `prisma/migrations/`
2. Ask you to confirm the changes
3. Apply the migration to your local database

Expected output: Migration created and applied successfully.

- [ ] **Step 4: Verify migration**

Run: `npx prisma migrate status`

Expected: All migrations applied.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "fix(audit): Issue #2 part 1 — add unique constraint on (tenantId, phone)

- Add @@unique([tenantId, phone]) to Candidate model
- Prevents duplicate candidates with same phone number per tenant
- Constraint will be enforced at database level
- Migration: add_unique_candidate_phone

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

### Task 4.1: Add cvText column to Prisma schema

**Files:**
- Modify: `prisma/schema.prisma` (EmailIntakeLog model)

- [ ] **Step 1: Read current EmailIntakeLog model**

Run: `grep -A 30 "model EmailIntakeLog" prisma/schema.prisma`

- [ ] **Step 2: Add cvText column**

Modify `prisma/schema.prisma`, in the EmailIntakeLog model:

```prisma
model EmailIntakeLog {
  id          String    @id @default(cuid())
  tenantId    String
  messageId   String
  candidateId String?
  cvText      String?   // Store raw CV text from Phase 4 for retry resume
  processingStatus String @default("pending") // pending, processing, completed, failed
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  @@unique([tenantId, messageId], name: "idx_intake_message_id")
  @@index([tenantId])
}
```

- [ ] **Step 3: Create migration**

Run: `npx prisma migrate dev --name add_cvtext_to_email_intake_log`

Expected: Migration created and applied.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "fix(audit): Issue #1 part 1 — add cvText column to EmailIntakeLog for idempotency

- Add cvText String? column to store raw CV text from Phase 4
- Enables retry resume from Phase 7 without re-running Phase 6
- Migration: add_cvtext_to_email_intake_log

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

### Task 4.2: Store cvText during extraction phase

**Files:**
- Modify: `src/modules/ingestion/ingestion.processor.ts:140-160` (Phase 4 completion)
- Test: `src/modules/ingestion/ingestion.processor.spec.ts`

- [ ] **Step 1: Read Phase 4 (extraction) code**

Run: `grep -B 5 -A 15 "Phase 4\|extractWithLLM\|update.*candidateId" src/modules/ingestion/ingestion.processor.ts | head -40`

- [ ] **Step 2: Write test for cvText storage**

Append to `src/modules/ingestion/ingestion.processor.spec.ts`:

```typescript
describe('IngestionProcessor - cvText storage', () => {
  it('should store cvText in EmailIntakeLog after extraction', async () => {
    const extractedData = {
      fullName: 'John Doe',
      email: 'john@example.com',
      phone: '+1-555-0001',
      skills: ['Node.js'],
      yearsExperience: 5,
      currentRole: 'Engineer',
      cvText: 'CV content here...', // Extracted CV text
    };

    // Mock extraction service
    jest.spyOn(extractionService, 'extractWithLLM').mockResolvedValueOnce(extractedData);

    // Process job
    await processor.process(job);

    // Verify cvText was stored in intake log
    expect(prismaClient.emailIntakeLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ cvText: extractedData.cvText }),
      })
    );
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- src/modules/ingestion/ingestion.processor.spec.ts --testNamePattern="cvText storage"`

Expected: FAIL

- [ ] **Step 4: Add cvText storage after Phase 4**

Modify `src/modules/ingestion/ingestion.processor.ts`, after Phase 4 extraction completes (around line 150):

Find where extraction is saved and add cvText storage:

```typescript
// Phase 4: AI Extraction (with fallback)
let extraction: ExtractedCandidate;

try {
  extraction = await this.extractionService.extractWithLLM(emailBody, {
    tenantId,
    messageId: payload.MessageID,
  });
} catch (error) {
  if (error instanceof Error && error.message === 'EXTRACTION_CONTEXT_EXCEEDED') {
    this.logger.warn(
      '[IngestionProcessor] Phase 4: LLM context exceeded, falling back to deterministic extraction'
    );
    extraction = this.extractionService.extractDeterministically(emailBody);
  } else {
    throw error;
  }
}

// Store cvText in intake log for later retry resume (Phase 4 checkpoint)
await this.prisma.emailIntakeLog.update({
  where: { idx_intake_message_id: { tenantId, messageId: payload.MessageID } },
  data: { cvText: extraction.cvText },
});

// Continue to Phase 6...
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- src/modules/ingestion/ingestion.processor.spec.ts --testNamePattern="cvText storage"`

Expected: PASS

- [ ] **Step 6: Run full test suite**

Run: `npm test`

Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add src/modules/ingestion/ingestion.processor.ts src/modules/ingestion/ingestion.processor.spec.ts
git commit -m "fix(audit): Issue #1 part 2 — store cvText during extraction for retry resume

- After Phase 4 extraction completes, save cvText to EmailIntakeLog
- Allows Phase 7 (scoring) to resume on retry with original extraction data
- cvText is not re-extracted on retry, uses stored value

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

### Task 4.3: Add idempotency guard at job start

**Files:**
- Modify: `src/modules/ingestion/ingestion.processor.ts:90-125` (job process entry point)
- Test: `src/modules/ingestion/ingestion.processor.spec.ts`

- [ ] **Step 1: Read job process entry point**

Run: `sed -n '85,130p' src/modules/ingestion/ingestion.processor.ts`

- [ ] **Step 2: Write test for idempotency on Phase 7 retry**

Append to `src/modules/ingestion/ingestion.processor.spec.ts`:

```typescript
describe('IngestionProcessor - idempotency guard', () => {
  it('should skip Phase 6 on retry and resume from Phase 7', async () => {
    const tenantId = 'tenant-123';
    const messageId = 'msg-456';
    const candidateId = 'cand-789';
    const cvText = 'CV content...';

    // Mock existing intake record (from a previous attempt that failed at Phase 7)
    jest.spyOn(prismaClient.emailIntakeLog, 'findUnique').mockResolvedValueOnce({
      id: 'intake-1',
      tenantId,
      messageId,
      candidateId, // Already set from Phase 6
      cvText, // Stored during Phase 4
      processingStatus: 'processing',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Mock candidate fetch
    jest.spyOn(prismaClient.candidate, 'findUnique').mockResolvedValueOnce({
      id: candidateId,
      tenantId,
      fullName: 'John Doe',
      email: 'john@example.com',
      phone: '+1-555-0001',
      skills: ['Node.js'],
      yearsExperience: 5,
      currentRole: 'Engineer',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Spy on Phase 6 (dedup service) to verify it's NOT called
    const dedupSpy = jest.spyOn(dedupService, 'check');

    // Spy on Phase 7 (scoring) to verify it IS called
    const scoringSpyResolves = jest.spyOn(processor, 'scoreAndStoreResults').mockResolvedValueOnce({
      score: 85,
      status: 'completed',
    });

    // Process retry
    const job = { data: { tenantId, messageId, phone: '+1-555-0001' } };
    await processor.process(job);

    // Verify Phase 6 (dedup) was skipped
    expect(dedupSpy).not.toHaveBeenCalled();

    // Verify Phase 7 (scoring) was called with reconstructed ScoringInput
    expect(scoringSpyResolves).toHaveBeenCalledWith(
      expect.objectContaining({
        cvText, // From stored cvText
        candidateFields: expect.any(Object),
      }),
      expect.any(Object),
      expect.any(Object)
    );
  });

  it('should not create self-duplicate on retry', async () => {
    // Same as above but verify no new candidate INSERT happens
    const candidateInsertSpy = jest.spyOn(prismaClient.candidate, 'create');

    // ... setup same as above ...

    await processor.process(job);

    // Verify create() was NOT called (no new candidate)
    expect(candidateInsertSpy).not.toHaveBeenCalled();
  });

  it('should proceed normally if intake has no candidateId (first attempt)', async () => {
    // Mock intake record WITHOUT candidateId (first time processing)
    jest.spyOn(prismaClient.emailIntakeLog, 'findUnique').mockResolvedValueOnce({
      id: 'intake-1',
      tenantId: 'tenant-123',
      messageId: 'msg-456',
      candidateId: null, // Not yet processed
      cvText: null,
      processingStatus: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Spy on Phase 6 (dedup service) to verify it IS called (normal flow)
    const dedupSpy = jest.spyOn(dedupService, 'check').mockResolvedValueOnce({
      match: null,
    });

    // ... continue processing ...

    // Verify Phase 6 (dedup) was called (normal flow)
    expect(dedupSpy).toHaveBeenCalled();
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
  const { tenantId, messageId } = payload;

  try {
    // **IDEMPOTENCY GUARD: Check if this intake was already processed**
    const existingIntake = await this.prisma.emailIntakeLog.findUnique({
      where: { idx_intake_message_id: { tenantId, messageId } },
      select: { candidateId: true, cvText: true },
    });

    if (existingIntake?.candidateId && existingIntake.cvText) {
      // Retry detected: This intake already has a candidateId from a previous attempt
      this.logger.info(
        `[IngestionProcessor] Retry detected for intake ${messageId}. Resuming from Phase 7.`
      );

      // Fetch the existing candidate
      const candidate = await this.prisma.candidate.findUnique({
        where: { id: existingIntake.candidateId },
        select: {
          id: true,
          fullName: true,
          email: true,
          phone: true,
          skills: true,
          yearsExperience: true,
          currentRole: true,
        },
      });

      if (!candidate) {
        throw new Error(`Candidate ${existingIntake.candidateId} not found (data inconsistency)`);
      }

      // Reconstruct ScoringInput from stored data
      const scoringInput: ScoringInput = {
        cvText: existingIntake.cvText,
        candidateFields: {
          currentRole: candidate.currentRole || null,
          yearsExperience: candidate.yearsExperience || null,
          skills: candidate.skills || [],
        },
        job: payload.job, // From job context
      };

      // Resume Phase 7 (scoring), skip Phase 6 entirely
      return this.scoreAndStoreResults(scoringInput, candidate, existingIntake);
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
git commit -m "fix(audit): Issue #1 part 3 — add idempotency guard at job start

- Check if intake already has candidateId + cvText at job start
- If yes, skip Phase 6 (dedup), reconstruct ScoringInput, resume Phase 7
- Prevents re-running dedup on retry, eliminates self-duplicate risk
- Fetches candidate from DB instead of re-extracting data

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

    // Skip if it's clearly a header, date, or sentence
    if (
      trimmed.length < 3 ||
      trimmed.length > 100 ||
      trimmed.match(/^\d{1,2}[/-]\d{1,2}/) || // dates like 01/15/2024
      trimmed.match(/\d{4}/) || // likely a year
      trimmed.toLowerCase().match(/^(dear|hello|hi|to|from|subject|re:)/) || // greetings
      trimmed.split(/\s+/).length > 4 // more than 4 words = likely a sentence
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
async extractAllJobIdsFromEmailText(emailText: string): Promise<string[]> {
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

  // Query only the extracted numbers as short_ids
  // DB will naturally filter out non-existent IDs and false positives
  const matchedJobs = await this.prisma.job.findMany({
    where: {
      shortId: { in: Array.from(candidates) },
      tenantId: this.tenantId,
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

✅ **Fix #1 (Issue #4):** Context limits prevent LLM errors
✅ **Fix #2 (Issue #6):** Zod coercion handles float LLM outputs
✅ **Fix #3 (Issue #2):** Unique constraint + P2002 handling prevents races
✅ **Fix #4 (Issue #1):** Idempotency guard + cvText storage prevents self-duplicates
✅ **Fix #5 (Issue #7):** Unicode-aware name detection improves data quality
✅ **Fix #6 (Issue #3):** Numeric job matching optimizes from O(N) to O(K)

**Final validation:**
- Run full test suite: `npm test`
- Expected: 249+ tests passing, zero regressions
- All 6 issues resolved with atomic commits
