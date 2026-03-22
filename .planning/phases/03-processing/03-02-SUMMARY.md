---
phase: 03-processing
plan: "02"
subsystem: ingestion
tags: [pdf-parse, mammoth, nestjs, bullmq, text-extraction, attachment-parsing]

# Dependency graph
requires:
  - phase: 03-00
    provides: Wave 0 stubs for AttachmentExtractorService

provides:
  - AttachmentExtractorService with extract() method (pdf-parse@2.x + mammoth)
  - Per-file demarcation headers for multi-attachment emails
  - 5 passing unit tests (PROC-04 and PROC-05)

affects: [03-03, 04-ai-extraction]

# Tech tracking
tech-stack:
  added: []  # pdf-parse@2.4.5 and mammoth@1.12.0 were pre-installed per research
  patterns:
    - "pdf-parse@2.x class-based API: new PDFParse({ data: buffer }).getText()"
    - "mammoth.convertToHtml({ buffer }) + htmlToPlainText strip"
    - "Buffer.from(base64, 'base64') for Node.js native decode"
    - "Catch-log-skip pattern for corrupted files (D-06)"

key-files:
  created: []
  modified:
    - src/ingestion/services/attachment-extractor.service.ts
    - src/ingestion/services/attachment-extractor.service.spec.ts

key-decisions:
  - "pdf-parse@2.x uses PDFParse class not direct function call — updated from plan's import pdfParse from 'pdf-parse'"
  - "HTML-to-plain-text via regex stripping in htmlToPlainText() private method (D-05)"

patterns-established:
  - "AttachmentExtractorService pattern: skip+warn on unsupported/corrupted, never throw"
  - "Demarcation format: '--- Attachment: {Name} ---\\n{text}' joined with double newline"

requirements-completed: [PROC-04, PROC-05]

# Metrics
duration: 3min
completed: 2026-03-22
---

# Phase 03 Plan 02: AttachmentExtractorService Summary

**AttachmentExtractorService converts Postmark base64-encoded PDF and DOCX attachments to plain text via pdf-parse@2.x (PDFParse class) and mammoth, with per-file demarcation headers and graceful error handling.**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-22T15:33:52Z
- **Completed:** 2026-03-22T15:36:57Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- AttachmentExtractorService implemented with extract() accepting PostmarkAttachmentDto[]
- PDF extraction via pdf-parse@2.x PDFParse class API (getText() method)
- DOCX extraction via mammoth.convertToHtml + htmlToPlainText HTML stripping
- Graceful skip+warn for unsupported types and corrupted files — never throws
- 5 passing unit tests covering all behaviors (PROC-04, PROC-05, D-04, D-06)

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement AttachmentExtractorService** - `b2f8773` (feat)
2. **Task 2: Fill attachment-extractor.service.spec.ts with 5 passing tests** - `17aff1f` (test)

## Files Created/Modified

- `src/ingestion/services/attachment-extractor.service.ts` - AttachmentExtractorService with extract() method
- `src/ingestion/services/attachment-extractor.service.spec.ts` - 5 passing unit tests with mocked pdf-parse and mammoth

## Decisions Made

- **pdf-parse@2.x API deviation:** The plan's implementation specified `import pdfParse from 'pdf-parse'` and calling `pdfParse(buffer)`, but pdf-parse@2.4.5 uses a class-based API (`PDFParse` class with `getText()` method). Updated the implementation to use `new PDFParse({ data: buffer }).getText()`.
- **Test mock adjustment:** Test mocks updated to match PDFParse class pattern instead of function mock.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] pdf-parse@2.x uses class-based API, not callable function**
- **Found during:** Task 1 (TypeScript compilation check)
- **Issue:** Plan specified `import pdfParse from 'pdf-parse'` and `pdfParse(buffer)`, but pdf-parse@2.4.5 exports `PDFParse` class — calling it as a function produces TS2349 "not callable" error
- **Fix:** Changed import to `import { PDFParse } from 'pdf-parse'` and usage to `new PDFParse({ data: buffer }).getText()`
- **Files modified:** src/ingestion/services/attachment-extractor.service.ts
- **Verification:** `npx tsc --noEmit` produces no errors for attachment-extractor
- **Committed in:** b2f8773 (Task 1 commit)

**2. [Rule 1 - Bug] Test mock adjusted for class-based PDFParse**
- **Found during:** Task 2 (test implementation)
- **Issue:** Plan's test mock `jest.mock('pdf-parse', () => jest.fn().mockResolvedValue(...))` doesn't match class-based API
- **Fix:** Changed to `jest.mock('pdf-parse', () => ({ PDFParse: jest.fn().mockImplementation(() => ({ getText: jest.fn().mockResolvedValue(...) })) }))`
- **Files modified:** src/ingestion/services/attachment-extractor.service.spec.ts
- **Verification:** All 5 tests pass
- **Committed in:** 17aff1f (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (both Rule 1 - Bug: pdf-parse@2.x API mismatch between plan and installed version)
**Impact on plan:** Necessary corrections for the installed pdf-parse@2.4.5 version. No scope creep, all plan goals achieved.

## Issues Encountered

- pdf-parse was upgraded from v1.x (plan assumed v1 function API) to v2.4.5 which has a class-based API. TypeScript caught this immediately on `npx tsc --noEmit`. Fix was straightforward.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- AttachmentExtractorService ready for injection into IngestionProcessor (Plan 03-03)
- Plan 03-03 will wire: SpamFilterService.check() + AttachmentExtractorService.extract() + email body prepend into fullText
- No blockers

---
*Phase: 03-processing*
*Completed: 2026-03-22*
