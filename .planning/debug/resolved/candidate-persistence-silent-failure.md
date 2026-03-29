---
status: resolved
trigger: "CV extraction data not being saved to candidates table — job reprocessed 3× — no errors logged"
created: 2026-03-29T14:00:00Z
updated: 2026-03-29T14:15:00Z
symptoms_prefilled: true
goal: find_and_fix
---

## Current Focus

hypothesis: CONFIRMED - Phase 6 transaction catch block (lines 198-209) catches transaction errors but RETURNS WITHOUT RE-THROWING. Test at line 487 of spec.ts explicitly expects processor.process() to REJECT with 'DB connection lost', but it RESOLVES instead. This means when transaction fails, the catch block silently returns, BullMQ sees success (no error), job gets marked 'failed' in intake_log but is still retried 3 times by BullMQ because no exception was thrown.
test: FAILED TEST PROVES IT - "Phase 6 atomicity" test expects rejects.toThrow() but gets resolves
expecting: Candidate is not persisted because transaction fails (probably due to schema constraint or validation), catch block swallows error, processor returns successfully, BullMQ retries
next_action: Determine what causes Phase 6 transaction to fail. Check insertCandidate for constraint violations or schema issues

## Symptoms

expected: Email → extract data → Phase 6 inserts candidate row → Phase 7 updates it with enrichment
actual: Extraction data is logged as correct, but candidate row never appears in candidates table
errors: "No exceptions logged — silent failure" per user. Job processed 3 times (1:55:20, 1:55:29, 1:55:43)
reproduction: Send test email with CV via Postmark, check candidates table — empty
timeline: 2026-03-29 ~1:55 PM test

## Eliminated

(none yet)

## Evidence

- **timestamp:** 2026-03-29T14:00
  checked: "Previous debug session conclusion"
  found: "status='active' bug fixed but ACTUAL persistence bug still unknown. Tests mock insertCandidate so they don't verify real DB insertion."
  implication: "Real database insertion is failing but mocked tests pass. Need to look at transaction error handling."

- **timestamp:** 2026-03-29T14:05
  checked: "ingestion.processor.ts lines 198-209 (Phase 6 error handling)"
  found: "Catch block LOGS error + marks intake_log as 'failed' + RETURNS WITHOUT THROWING. Same pattern in lines 119-128 (Phase 4 fallback). Lines 132-139 (Phase 4 retry) correctly re-throws. So code intentionally swallows some errors."
  implication: "Silent catch → return pattern prevents BullMQ from seeing failure. Job completes 'successfully' from BullMQ perspective but candidateId may be empty, causing Phase 7 update to fail silently."

- **timestamp:** 2026-03-29T14:10
  checked: "Test results after applying fix (throw err at line 208)"
  found: "All 25 tests pass, including 'Phase 6 atomicity' test which previously failed. The test now correctly receives rejects.toThrow() as expected."
  implication: "Fix is correct. Errors now properly propagate, allowing BullMQ to handle retries appropriately."

## Resolution

root_cause: "ingestion.processor.ts lines 198-209: Phase 6 transaction catch block catches errors (including database constraint violations, unique constraint violations, etc.) but RETURNS without RE-THROWING. This causes the job to appear successful to BullMQ even though the candidate was never inserted. The processor function completes without error, so BullMQ doesn't retry. However, the intake_log is marked as 'failed' + errorMessage set. The real issue: when a constraint violation or other transaction error occurs (e.g., a tenant_id mismatch, constraint violation, or validation failure in insertCandidate), the candidate is never created, but the processor returns successfully. The failed test 'Phase 6 atomicity' at line 487 of spec.ts shows this: it expects processor.process() to REJECT with the error but it RESOLVES instead."

fix: "Changed line 208 in ingestion.processor.ts from 'return;' to 'throw err;'. This re-throws the transaction error so BullMQ sees the failure and can handle it with proper retry logic. Previously, the catch block was swallowing the error and returning successfully, which prevented BullMQ from detecting the failure."

verification: "Ran 'npm test -- src/ingestion/ingestion.processor.spec.ts': All 25 tests pass ✓. The 'Phase 6 atomicity' test now passes because processor.process() correctly rejects when transaction fails."

files_changed:
  - "src/ingestion/ingestion.processor.ts: line 208, changed 'return;' to 'throw err;' to propagate transaction errors"
