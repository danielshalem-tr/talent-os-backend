---
phase: quick-260322-uov
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/ingestion/ingestion.processor.ts
  - src/ingestion/ingestion.processor.spec.ts
  - src/webhooks/webhooks.service.ts
  - src/webhooks/webhooks.service.spec.ts
autonomous: true
requirements: [BUG-CV-LOSS, BUG-RETRY, BUG-RACE]
must_haves:
  truths:
    - "If AI extraction fails, the CV file is still persisted in R2 before the error"
    - "Transient AI failures cause BullMQ to retry the job via exponential backoff"
    - "Simultaneous duplicate webhooks for the same MessageID produce exactly one job and one candidate row"
  artifacts:
    - path: "src/ingestion/ingestion.processor.ts"
      provides: "Fixed pipeline order: spam filter → R2 upload → AI extraction"
      contains: "storageService.upload"
    - path: "src/webhooks/webhooks.service.ts"
      provides: "BullMQ jobId deduplication + Prisma unique constraint handling"
      contains: "jobId: messageId"
  key_links:
    - from: "ingestion.processor.ts"
      to: "storageService.upload"
      via: "called before extractionAgent.extract"
      pattern: "storageService\\.upload.*extract"
    - from: "webhooks.service.ts"
      to: "ingestQueue.add"
      via: "jobId option set to messageId"
      pattern: "jobId.*messageId|messageId.*jobId"
---

<objective>
Fix three critical bugs in the implemented ingestion pipeline: permanent CV loss on extraction failure, broken BullMQ retry mechanism, and race condition causing duplicate candidates from simultaneous Postmark webhooks.

Purpose: These bugs cause data loss and duplicate records in production — they are correctness failures, not quality issues.
Output: Patched ingestion.processor.ts and webhooks.service.ts with updated tests confirming correct behavior.
</objective>

<execution_context>
@/Users/danielshalem/triolla/telent-os-backend/.claude/get-shit-done/workflows/execute-plan.md
@/Users/danielshalem/triolla/telent-os-backend/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md

<!-- Key interfaces the executor needs — extracted from codebase -->
<interfaces>
<!-- From src/ingestion/ingestion.processor.ts -->
The current pipeline order in IngestionProcessor.process():
  1. Spam filter (line 41)
  2. Update status → 'processing' (line 55)
  3. AttachmentExtractor.extract() (line 64)
  4. Build fullText + ProcessingContext (lines 69-83)
  5. ExtractionAgent.extract() (line 88) ← AI call
     catch → update status='failed', return  ← BUG: swallows error, returns null
  6. storageService.upload() (line 125) ← BUG: only reached if AI succeeds

Bug 1 fix: Move storageService.upload() to BEFORE ExtractionAgent.extract().
Bug 2 fix: In the catch block for ExtractionAgent.extract(), after updating status='failed',
  re-throw the error (do NOT return). The empty-fullName case is NOT a transient error —
  it should keep the current 'return' (permanent failure, no retry).

<!-- From src/webhooks/webhooks.service.ts — queue.add() calls -->
Current: queue.add('ingest-email', payload, { attempts: 3, backoff: ... })
Bug 3 fix (two parts):
  Part A — Add jobId to BOTH queue.add calls (line 68 and line 37):
    { jobId: messageId, attempts: 3, backoff: { type: 'exponential', delay: 5000 } }
  BullMQ deduplicates jobs with the same jobId — second add() is a no-op if job exists.

  Part B — Wrap prisma.emailIntakeLog.create in a try/catch that catches Prisma error
  code P2002 (unique constraint violation). On P2002, log and return { status: 'queued' }
  instead of crashing. This handles the race where two concurrent requests both pass the
  findUnique check before either has inserted.

<!-- Test impact -->
ingestion.processor.spec.ts test '4-02-01: extraction failure marks status failed':
  Current assertion: await processor.process(job) resolves normally (no throw).
  After fix (re-throw): it must be changed to:
    await expect(processor.process(job)).rejects.toThrow('LLM timeout')
  The 'prisma.update called with failed' assertion stays — it still fires before the re-throw.

ingestion.processor.spec.ts test '4-02-02: successful extraction does not update failed status':
  This test must be updated to assert storageService.upload is called BEFORE extraction
  (or at minimum is called on the happy path — add storageService mock to the first describe
  block that currently lacks it in the 'IngestionProcessor' suite).

webhooks.service.spec.ts:
  Add one new test: 'uses messageId as jobId to prevent duplicate enqueue'. Assert that
  queue.add is called with a third arg containing { jobId: 'msg-abc-123' }.
  Add one new test: 'handles P2002 unique constraint on concurrent create without crashing'.
  Simulate prisma.emailIntakeLog.create throwing a Prisma ClientKnownRequestError with
  code 'P2002' — assert service returns { status: 'queued' } without throwing.
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Fix processor pipeline order and retry behavior</name>
  <files>src/ingestion/ingestion.processor.ts, src/ingestion/ingestion.processor.spec.ts</files>
  <behavior>
    - Test BUG-CV-LOSS: storageService.upload is called even when extractionAgent.extract throws
    - Test BUG-RETRY: processor.process() rejects (throws) when extractionAgent.extract throws a transient error
    - Test PERMANENT-FAIL: processor.process() resolves (does NOT throw) when extraction returns empty fullName
    - Test HAPPY-PATH: storageService.upload is called before extractionAgent.extract on the success path
  </behavior>
  <action>
    In src/ingestion/ingestion.processor.ts, reorder the pipeline:

    1. Move the storageService.upload() block (currently lines 124-135) to BEFORE the
       ExtractionAgent.extract() call. The upload needs the attachments and context.fullText
       is already built at that point. Assign result to context.fileKey.

    2. In the existing catch block for ExtractionAgent.extract() (currently lines 92-104):
       - Keep the prisma.update({ data: { processingStatus: 'failed' } }) call
       - Keep the logger.error() call
       - CHANGE the final `return` to `throw err` — so BullMQ sees a failure and retries

    3. The empty-fullName block (lines 106-118) is a permanent failure — keep its `return`
       as-is (do not re-throw). Only transient/unexpected errors should be re-thrown.

    In src/ingestion/ingestion.processor.spec.ts:

    4. In the first describe block ('IngestionProcessor'), add storageService mock to the
       beforeEach providers (same pattern as Phase 5 describe block):
         { provide: StorageService, useValue: { upload: jest.fn().mockResolvedValue('cvs/test/msg.pdf') } }
       This is required because upload is now called on ALL non-spam paths, not just after extraction.

    5. Update test '4-02-01: extraction failure marks status failed':
       Change `await processor.process(job)` to:
         await expect(processor.process(job)).rejects.toThrow('LLM timeout')
       Keep the existing prisma.update assertions — they still fire before the re-throw.

    6. Add new test 'upload is called before extraction even when extraction fails':
       - Mock extractionAgent.extract to reject with 'LLM timeout'
       - Expect processor.process(job) to reject
       - Expect storageService.upload to have been called (called before the failed extraction)
  </action>
  <verify>
    <automated>cd /Users/danielshalem/triolla/telent-os-backend && npx jest src/ingestion/ingestion.processor.spec.ts --no-coverage 2>&1 | tail -20</automated>
  </verify>
  <done>
    All processor tests pass. New test confirms upload is called even when extraction throws.
    Test '4-02-01' now asserts rejects.toThrow instead of resolves.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Fix race condition deduplication in WebhooksService</name>
  <files>src/webhooks/webhooks.service.ts, src/webhooks/webhooks.service.spec.ts</files>
  <behavior>
    - Test JOB-ID: queue.add is called with { jobId: messageId } in both the fresh enqueue and the re-enqueue (pending) paths
    - Test P2002-RACE: when prisma.create throws a Prisma P2002 error, service returns { status: 'queued' } without throwing
    - Test P2002-NON-UNIQUE: when prisma.create throws a non-P2002 Prisma error, service still re-throws it
  </behavior>
  <action>
    In src/webhooks/webhooks.service.ts:

    1. Add { jobId: messageId } to the options object in BOTH queue.add calls:
       - Line ~37 (re-enqueue on pending): { jobId: messageId, attempts: 3, backoff: { type: 'exponential', delay: 5000 } }
       - Line ~68 (fresh enqueue): { jobId: messageId, attempts: 3, backoff: { type: 'exponential', delay: 5000 } }

    2. Wrap the prisma.emailIntakeLog.create() call (currently line ~54) in a try/catch:
       ```typescript
       try {
         await this.prisma.emailIntakeLog.create({ data: { ... } });
       } catch (err) {
         // P2002 = unique constraint violation — concurrent duplicate request won the race
         if ((err as any)?.code === 'P2002') {
           this.logger.log(`Concurrent duplicate for MessageID: ${messageId} — skipping`);
           return { status: 'queued' };
         }
         throw err; // All other DB errors propagate normally
       }
       ```
       Import from '@prisma/client' is NOT needed — checking `.code === 'P2002'` on the raw
       error is sufficient and avoids an extra import.

    In src/webhooks/webhooks.service.spec.ts:

    3. Update existing test 'calls queue.add with attempts=3...':
       Add jobId to the objectContaining matcher:
         expect.objectContaining({ jobId: 'msg-abc-123', attempts: 3, backoff: { type: 'exponential', delay: 5000 } })

    4. Add new test 'uses messageId as jobId on fresh enqueue':
       Assert queue.add was called with third arg containing { jobId: basePayload.MessageID }.

    5. Add new test 'uses messageId as jobId on re-enqueue (pending status)':
       Set findUnique to return { processingStatus: 'pending' }. Assert queue.add called
       with third arg containing { jobId: basePayload.MessageID }.

    6. Add new test 'handles concurrent P2002 unique constraint gracefully':
       Set findUnique to return null (first request passes check).
       Set prisma.create to throw { code: 'P2002', message: 'Unique constraint' }.
       Assert service returns { status: 'queued' } without throwing.

    7. Add new test 'rethrows non-P2002 db errors':
       Set prisma.create to throw { code: 'P2003', message: 'FK violation' }.
       Assert service.enqueue rejects.
  </action>
  <verify>
    <automated>cd /Users/danielshalem/triolla/telent-os-backend && npx jest src/webhooks/webhooks.service.spec.ts --no-coverage 2>&1 | tail -20</automated>
  </verify>
  <done>
    All webhooks service tests pass. Both queue.add calls include jobId. P2002 returns cleanly.
    Non-P2002 errors still propagate.
  </done>
</task>

<task type="auto">
  <name>Task 3: Full test suite green check</name>
  <files></files>
  <action>
    Run the full test suite to confirm no regressions were introduced by the changes in Tasks 1 and 2.
    Do not modify any files in this task — observation only. If failures exist, fix them before marking done.
  </action>
  <verify>
    <automated>cd /Users/danielshalem/triolla/telent-os-backend && npx jest --no-coverage 2>&1 | tail -30</automated>
  </verify>
  <done>
    All test suites pass. Total test count is >= 70 (the count after Phase 5). No suite reports failures.
  </done>
</task>

</tasks>

<verification>
- ingestion.processor.ts: storageService.upload appears before extractionAgent.extract in the process() method body
- ingestion.processor.ts: catch block for extractionAgent.extract ends with `throw err`, not `return`
- ingestion.processor.ts: empty-fullName block still ends with `return` (permanent failure, no retry)
- webhooks.service.ts: both queue.add calls include `jobId: messageId` in options
- webhooks.service.ts: prisma.emailIntakeLog.create is wrapped in try/catch with P2002 handling
- All tests pass: npx jest --no-coverage exits 0
</verification>

<success_criteria>
- Full jest suite exits 0 with >= 70 tests passing
- New tests cover: upload-before-extraction, transient error re-throw, jobId deduplication, P2002 graceful handling
- No existing tests were deleted (only the '4-02-01' assertion updated from resolves to rejects)
</success_criteria>

<output>
After completion, create `.planning/quick/260322-uov-fix-3-critical-bugs-in-implemented-phase/260322-uov-SUMMARY.md`
</output>
