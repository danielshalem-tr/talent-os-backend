---
phase: 06-duplicate-detection
verified: 2026-03-23T12:00:00Z
status: passed
score: 8/8 must-haves verified
re_verification: false
---

# Phase 06: Duplicate Detection Verification Report

**Phase Goal:** Detect duplicate candidates before insert using pg_trgm fuzzy matching on name + exact email match. Score confidence, upsert existing records, create duplicate flags. Pipeline continues for all cases.

**Verified:** 2026-03-23T12:00:00Z
**Status:** PASSED
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Duplicate detection runs entirely in PostgreSQL via pg_trgm — no candidates loaded into app memory | ✓ VERIFIED | `src/dedup/dedup.service.ts` line 38 uses `$queryRaw` template literal with `similarity()` function and `%` operator |
| 2 | Exact email match returns DedupResult with confidence=1.0 and fields=['email'] | ✓ VERIFIED | `src/dedup/dedup.service.ts` lines 27-34 check exact email first; unit test at line 75 confirms return value |
| 3 | Fuzzy name match > 0.7 similarity returns DedupResult with fields=['name'] and confidence < 1.0 | ✓ VERIFIED | `src/dedup/dedup.service.ts` lines 48-53 return fuzzy match with confidence = name_sim; unit test at line 91 confirms |
| 4 | No match returns null | ✓ VERIFIED | `src/dedup/dedup.service.ts` line 56 returns null; unit test at line 108 confirms |
| 5 | Exact email match triggers UPSERT of existing candidate (fullName + phone only) | ✓ VERIFIED | `src/ingestion/ingestion.processor.ts` lines 148-152: exact match (confidence==1.0) calls `upsertCandidate()`; integration test at line 387 confirms behavior |
| 6 | Fuzzy name match triggers INSERT new candidate + createFlag for human review | ✓ VERIFIED | `src/ingestion/ingestion.processor.ts` lines 153-162: fuzzy match (confidence<1.0) calls `insertCandidate()` then `createFlag()`; integration test at line 486 confirms |
| 7 | No match triggers INSERT new candidate | ✓ VERIFIED | `src/ingestion/ingestion.processor.ts` lines 163-166: else branch calls `insertCandidate()`; integration test at line 368 confirms |
| 8 | email_intake_log.candidate_id is set immediately after candidate INSERT/UPSERT (D-10) — no orphaned logs | ✓ VERIFIED | `src/ingestion/ingestion.processor.ts` lines 170-173: `emailIntakeLog.update()` with candidateId called before Phase 7 work |

**Score:** 8/8 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/dedup/dedup.module.ts` | NestJS module exporting DedupService | ✓ VERIFIED | Class exists, exports DedupService, follows StorageModule pattern |
| `src/dedup/dedup.service.ts` | Full DedupService implementation (check, insertCandidate, upsertCandidate, createFlag) | ✓ VERIFIED | All 4 methods fully implemented, no stubs, pg_trgm integration present |
| `src/dedup/dedup.service.spec.ts` | 5 passing unit tests (DEDUP-01 through DEDUP-05) + mockCandidateDedupExtract factory | ✓ VERIFIED | All 5 tests passing, factory exported for Plan 02 integration tests |
| `src/ingestion/ingestion.processor.ts` | ProcessingContext.candidateId field + DedupService injection + Phase 6 logic | ✓ VERIFIED | candidateId field at line 18; DedupService injected at line 32; logic at lines 144-180 |
| `src/ingestion/ingestion.module.ts` | DedupModule in imports array | ✓ VERIFIED | DedupModule imported at line 8, in imports array at line 14 |
| `src/ingestion/ingestion.processor.spec.ts` | 3 passing integration tests (6-02-01, 6-02-02, 6-02-03) | ✓ VERIFIED | All 3 tests passing, describe block at line 297 |
| `prisma/schema.prisma` | Candidate model with aiSummary nullable TEXT field | ✓ VERIFIED | aiSummary at line 66: `String? @map("ai_summary") @db.Text` |
| `prisma/migrations/20260323070504_add_ai_summary/` | Migration SQL for ai_summary column | ✓ VERIFIED | Directory exists, contains `ALTER TABLE candidates ADD COLUMN ai_summary TEXT` |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| DedupService.check() | PostgreSQL pg_trgm | $queryRaw with similarity() + % operator | ✓ WIRED | Template literal at lines 38-46 executes fuzzy match in DB |
| DedupService.check() | candidate.findFirst | Exact email match before fuzzy | ✓ WIRED | Lines 27-34: if candidate.email exists, runs findFirst |
| DedupService.createFlag() | duplicateFlag.upsert | idx_duplicates_pair constraint | ✓ WIRED | Lines 99-112: upsert where clause targets idx_duplicates_pair |
| DedupService.upsertCandidate() | candidate.update | Update fullName + phone only | ✓ WIRED | Lines 83-90: update.data contains only fullName and phone |
| IngestionProcessor.process() | dedupService.check() | Dependency injection | ✓ WIRED | Constructor param at line 32; called at line 144 |
| IngestionProcessor.process() | emailIntakeLog.update | Set candidateId immediately | ✓ WIRED | Lines 170-173: update after INSERT/UPSERT, before Phase 7 |
| IngestionModule | DedupModule | NestJS imports | ✓ WIRED | DedupModule imported at line 8, in imports array at line 14 |
| ProcessingContext | Phase 7 consumer | candidateId field | ✓ WIRED | Field at line 18; set at line 176 in processor |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|-------------------|--------|
| DedupService.check() | fuzzy[] result | prisma.$queryRaw with similarity() | Yes — query runs in PostgreSQL, returns actual matching candidates | ✓ FLOWING |
| DedupService.insertCandidate() | created.id | prisma.candidate.create() | Yes — creates real candidate record with tenantId, fullName, email, phone, source, sourceEmail | ✓ FLOWING |
| DedupService.upsertCandidate() | update result | prisma.candidate.update() | Yes — updates existing candidate record | ✓ FLOWING |
| DedupService.createFlag() | upsert result | prisma.duplicateFlag.upsert() | Yes — creates/updates duplicate flag record with reviewed=false | ✓ FLOWING |
| IngestionProcessor.process() | context.candidateId | dedupService methods (insert/upsert) | Yes — set from real candidate ID returned by dedup service | ✓ FLOWING |
| emailIntakeLog.update() | candidateId in data | context.candidateId | Yes — non-null UUID string passed from dedup result | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| TypeScript compilation succeeds | `npx tsc --noEmit` | Exit 0, no errors | ✓ PASS |
| All tests pass | `npm test` | 83 tests passing, 12 suites, 0 failures | ✓ PASS |
| DedupModule exports DedupService | `grep "exports: \[DedupService\]" src/dedup/dedup.module.ts` | Match found | ✓ PASS |
| pg_trgm $queryRaw present | `grep "\$queryRaw" src/dedup/dedup.service.ts` | Match found | ✓ PASS |
| similarity() function used | `grep "similarity" src/dedup/dedup.service.ts` | Match found | ✓ PASS |
| NULL email guard present | `grep "if (candidate.email)" src/dedup/dedup.service.ts` | Match found | ✓ PASS |
| idx_duplicates_pair in createFlag | `grep "idx_duplicates_pair" src/dedup/dedup.service.ts` | Match found | ✓ PASS |
| createFlag reviewed=false | `grep "reviewed: false" src/dedup/dedup.service.ts` | Match found | ✓ PASS |
| upsert no-op update | `grep "update: {}" src/dedup/dedup.service.ts` | Match found | ✓ PASS |
| candidateId in ProcessingContext | `grep "candidateId: string" src/ingestion/ingestion.processor.ts` | Match found | ✓ PASS |
| emailIntakeLog.candidateId set | `grep "data: { candidateId }" src/ingestion/ingestion.processor.ts` | Match found | ✓ PASS |
| 5 DEDUP unit tests | `grep -c "it('DEDUP-" src/dedup/dedup.service.spec.ts` | 5 matches | ✓ PASS |
| 3 integration tests | `grep -c "6-02-" src/ingestion/ingestion.processor.spec.ts` | 3 matches | ✓ PASS |
| GIN index on full_name | `grep "idx_candidates_name_trgm" prisma/migrations/20260322110817_init/migration.sql` | Match found | ✓ PASS |
| GIN index on phone | `grep "idx_candidates_phone_trgm" prisma/migrations/20260322110817_init/migration.sql` | Match found | ✓ PASS |

### Requirements Coverage

| Requirement | Phase Plan | Description | Status | Evidence |
|-------------|-----------|-------------|--------|----------|
| DEDUP-01 | 06-01 | Dedup runs entirely in PostgreSQL via pg_trgm — no candidates loaded into app memory | ✓ SATISFIED | `src/dedup/dedup.service.ts` line 38: `$queryRaw` with `similarity()` and `%` operator executes in DB |
| DEDUP-02 | 06-01 | Exact email match (confidence = 1.0) → UPSERT existing candidate record | ✓ SATISFIED | `src/dedup/dedup.service.ts` lines 27-34: exact email check, returns confidence 1.0; `src/ingestion/ingestion.processor.ts` lines 148-152: calls upsertCandidate |
| DEDUP-03 | 06-01 | Fuzzy name match (similarity > 0.7, confidence < 1.0) → INSERT new candidate + create duplicate_flags | ✓ SATISFIED | `src/dedup/dedup.service.ts` lines 48-53: fuzzy match logic; `src/ingestion/ingestion.processor.ts` lines 153-162: calls insertCandidate + createFlag |
| DEDUP-04 | 06-01 | No match → INSERT new candidate record | ✓ SATISFIED | `src/dedup/dedup.service.ts` line 56: returns null; `src/ingestion/ingestion.processor.ts` lines 163-166: calls insertCandidate |
| DEDUP-05 | 06-01 | System never auto-merges on fuzzy match — creates duplicate_flags with reviewed = false | ✓ SATISFIED | `src/dedup/dedup.service.ts` lines 99-112: createFlag upserts with reviewed=false; no auto-merge code path exists |
| DEDUP-06 | 06-00 | pg_trgm GIN indexes on candidates.full_name and candidates.phone are created in migration | ✓ SATISFIED | Phase 1 migration `prisma/migrations/20260322110817_init/migration.sql` contains both GIN indexes: idx_candidates_name_trgm and idx_candidates_phone_trgm |

**All 6 requirements satisfied.**

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| None detected | — | — | — | Phase 06 implementation is complete and clean — no TODO/FIXME comments, no placeholder returns, no hardcoded empty data, no disconnected props |

### Human Verification Required

None — all automated checks passed; no visual, real-time, or external service integration needed for Phase 06 verification.

### Gaps Summary

**No gaps found.** Phase 06 goal fully achieved:

1. **Duplicate detection pipeline complete:** DedupService fully implements exact email + fuzzy name matching via pg_trgm
2. **All dedup outcomes wired:** No match → INSERT, exact match → UPSERT, fuzzy match → INSERT + flag
3. **Candidate ID immediately linked:** email_intake_log.candidate_id set right after INSERT/UPSERT, preventing orphaned logs if Phase 7 fails
4. **Database schema extended:** aiSummary column added and migrated; pg_trgm GIN indexes present from Phase 1
5. **Full test coverage:** 5 unit tests + 3 integration tests cover all dedup paths and branching logic
6. **All 6 requirements satisfied:** DEDUP-01 through DEDUP-06 all verified in code

---

## Verification Summary

**Phase Goal:** ✓ ACHIEVED
- Duplicate candidates detected before insert via pg_trgm fuzzy matching on name + exact email match
- Confidence scored; existing records upserted; duplicate flags created for human review
- Pipeline continues for all cases (no matches, exact matches, fuzzy matches)

**Artifacts:** ✓ 8/8 VERIFIED
- DedupModule and DedupService fully implemented and wired
- ProcessingContext extended with candidateId for Phase 7
- All 8 required files/modifications present and functional

**Tests:** ✓ 83/83 PASSING
- 5 unit tests for DedupService (DEDUP-01 through DEDUP-05)
- 3 integration tests for IngestionProcessor (6-02-01, 6-02-02, 6-02-03)
- 75 existing tests still passing (no regressions)

**Requirements:** ✓ 6/6 SATISFIED
- DEDUP-01: pg_trgm in PostgreSQL
- DEDUP-02: Exact email match → UPSERT
- DEDUP-03: Fuzzy match → INSERT + flag
- DEDUP-04: No match → INSERT
- DEDUP-05: Never auto-merge (reviewed=false)
- DEDUP-06: GIN indexes present

**Quality:** ✓ NO ISSUES
- TypeScript compilation passes
- No anti-patterns or stubs
- Data flows correctly through entire pipeline
- All 3 dedup outcomes implemented and tested

---

_Verified: 2026-03-23T12:00:00Z_
_Verifier: Claude (gsd-verifier)_
