---
phase: 05-file-storage
plan: "01"
subsystem: storage
tags: [cloudflare-r2, aws-sdk, s3, file-upload, attachment-selection]

# Dependency graph
requires:
  - phase: 05-00
    provides: StorageService stub (storage.service.ts placeholder and spec stubs)
provides:
  - StorageService full R2 upload implementation with attachment selection and key construction
  - 5 passing unit tests covering STOR-01, STOR-02, D-07, D-11
affects:
  - 05-02 (IngestionProcessor integration wires StorageService.upload())
  - 05-03 (end-to-end verification)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "S3Client with region 'auto' for Cloudflare R2 (not a standard AWS region)"
    - "jest.mock factory pattern to keep PutObjectCommand real while mocking S3Client.send"
    - "R2 errors propagate uncaught to BullMQ caller (no try-catch around s3Client.send)"
    - "Attachment selection: filter PDF/DOCX by MIME, pick max ContentLength"

key-files:
  created: []
  modified:
    - src/storage/storage.service.ts
    - src/storage/storage.service.spec.ts

key-decisions:
  - "Use jest.mock factory (jest.requireActual) to keep PutObjectCommand as real class while mocking S3Client — auto-mock loses .input property on command instances"
  - "StorageService does not catch S3Client.send() errors — propagates to BullMQ for retry (D-07)"
  - "upload() returns null (not throws) when no PDF/DOCX attachment found — job continues normally (D-02)"

patterns-established:
  - "PutObjectCommand assertion pattern: expect(mockS3Send).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({...}) }))"
  - "R2 key format: cvs/${tenantId}/${messageId}${extension}"

requirements-completed: [STOR-01, STOR-02]

# Metrics
duration: 2min
completed: 2026-03-22
---

# Phase 05 Plan 01: StorageService R2 Upload Summary

**StorageService implementation with @aws-sdk/client-s3 PutObjectCommand, largest-PDF-DOCX attachment selection, cvs/{tenant}/{msg} key construction, and 5 passing unit tests replacing Wave 0 stubs**

## Performance

- **Duration:** ~2 min
- **Started:** 2026-03-22T18:24:18Z
- **Completed:** 2026-03-22T18:26:00Z
- **Tasks:** 2 completed
- **Files modified:** 2

## Accomplishments

- Full StorageService implementation replacing the Wave 0 stub: S3Client with R2 endpoint, selectLargestCvAttachment(), getExtension(), upload() returning key string or null
- All 5 unit tests pass green: STOR-01 (upload + null), STOR-02 (key-not-URL), D-11 (explicit ContentType), D-07 (error propagation)
- Full suite unchanged: 70 tests passing across 11 suites — no regressions

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement StorageService with full R2 upload logic** - `546a36f` (feat)
2. **Task 2: Update storage.service.spec.ts stubs to real assertions** - `902641a` (feat)

## Files Created/Modified

- `src/storage/storage.service.ts` - Full StorageService: S3Client constructor, upload(), selectLargestCvAttachment(), getExtension()
- `src/storage/storage.service.spec.ts` - 5 passing unit tests with real assertions replacing stub .rejects.toThrow()

## Decisions Made

- Used `jest.mock` factory with `jest.requireActual` to keep `PutObjectCommand` as the real class while mocking `S3Client` — the auto-mock approach loses the `.input` property on command instances, causing assertion failures. Switching to the factory pattern preserves `PutObjectCommand.input` so the `expect.objectContaining({ input: ... })` pattern works correctly.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] jest.mock factory required to preserve PutObjectCommand.input**
- **Found during:** Task 2 (Update spec stubs to real assertions)
- **Issue:** The plan specified `jest.mock('@aws-sdk/client-s3')` (full auto-mock), which replaces `PutObjectCommand` with a mock class whose instances have `resolveMiddleware` but no `.input` property — making `expect.objectContaining({ input: ... })` assertions fail
- **Fix:** Switched to `jest.mock('@aws-sdk/client-s3', () => ({ ...jest.requireActual('@aws-sdk/client-s3'), S3Client: jest.fn()... }))` to keep `PutObjectCommand` real
- **Files modified:** src/storage/storage.service.spec.ts
- **Verification:** All 5 tests pass; `npm test` exits 0 with 70 tests
- **Committed in:** 902641a (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 - bug in test mock pattern from plan)
**Impact on plan:** Required fix for correct test assertions. No scope creep.

## Issues Encountered

- `PutObjectCommand` auto-mock loses `.input` property — researched actual SDK command structure via `node -e` inspection, confirmed `input` exists on real instances, applied factory mock fix.

## Next Phase Readiness

- StorageService is complete and unit-tested — ready to be injected into IngestionProcessor in Phase 05-02
- STOR-01 and STOR-02 requirements fully satisfied at unit level

---
*Phase: 05-file-storage*
*Completed: 2026-03-22*
