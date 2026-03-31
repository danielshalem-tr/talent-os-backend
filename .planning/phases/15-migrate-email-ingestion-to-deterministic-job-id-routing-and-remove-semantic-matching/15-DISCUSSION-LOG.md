# Phase 15: Migrate email ingestion to deterministic Job ID routing — Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the decision journey.

**Date:** 2026-03-31
**Phase:** 15-migrate-email-ingestion-to-deterministic-job-id-routing-and-remove-semantic-matching
**Mode:** discuss
**Areas discussed:** Job ID extraction, fallback behavior, schema changes, backward compatibility, service removal

---

## Gray Area 1: Job ID Extraction Source

| Option | Description | Selected |
|--------|-------------|----------|
| Email subject line pattern (e.g., [JID:12345]) | Parse a standardized pattern from the subject. Clear, recruiter-friendly, no infrastructure changes. | ✓ |
| Custom email header (X-Job-ID) | Accept a custom header from the email client. Requires recruiter config but very deterministic. | |
| Query parameter in Postmark webhook URL | Postmark allows dynamic webhook URLs. Clean from engineering but requires email client integration. | |

**User's choice:** Email subject line pattern

**Notes:** The pattern should be flexible: `\[(?:Job\s*ID|JID):\s*([a-zA-Z0-9\-]+)\]` (case insensitive) to match variants like `[Job ID: 12345]`, `[JID: DEV01]`, `[Job ID: a8f9k]`, etc.

**Key insight from user:** "The DB currently uses UUIDs, so you must add a short, human-readable 'shortId' field to the Job model to make this work, as users will not put full UUIDs in subject lines."

---

## Gray Area 2: Fallback When Job ID is Missing

| Option | Description | Selected |
|--------|-------------|----------|
| Store candidate unmatched (jobId=null, score against all active jobs) | Candidate created and scored. Flexible, allows recruiter to manually assign later. | |
| Skip processing entirely (don't create candidate) | Strictest approach — Job ID required for all emails. | |
| Use a default job (if configured) | Fall back to pre-configured default job for tenant. Practical for 1 main hiring flow. | |
| Create in 'unmatched' status (new DB status) | Store with 'unmatched_job' status for recruiter triage. Hybrid of flexibility + explicitness. | |
| **Store as unassigned, SKIP scoring entirely** | Create candidate with jobId=null, but do NOT score against any jobs. | ✓ |

**User's choice:** Store candidate as unassigned (jobId=null), SKIP scoring entirely. No scoring against any jobs.

**User note:** "This behavior (when candidate doesn't have job_id and send to ui for check) is already exist in code"

**Key insight:** This is a baseline for future unstructured agency submissions. The UI will show these unmatched candidates, allowing recruiters to review and assign jobs later.

---

## Gray Area 3: Schema Changes

| Option | Description | Selected |
|--------|-------------|----------|
| Replace job_title_hint → job_id_hint | Remove job_title_hint, add job_id_hint. Cleanest refactor. | |
| Keep both job_title_hint and job_id_hint | Add job_id_hint alongside. Safer backward compat, carries tech debt. | |
| Add job_id_hint, deprecate job_title_hint (warning) | Extract both, mark job_title_hint deprecated. Transition period. | |
| **Remove job_title_hint entirely, extract Job ID via regex separately** | Remove from LLM schema. Job ID extracted deterministically via regex in IngestionProcessor. | ✓ |

**User's choice:** Remove `job_title_hint` entirely from the LLM extraction schema. Job ID extraction must be done deterministically via regex on the email Subject line directly inside IngestionProcessor, completely independent of the LLM.

**Key insight:** Keeps extraction schema focused on CV data, not routing metadata. Job ID routing is a separate concern, handled at the processor level.

---

## Gray Area 4: Regex Pattern Detail

| Option | Description | Selected |
|--------|-------------|----------|
| [JID:###] (digits only) | `\[JID:(\d+)\]` — numeric IDs only. | |
| [JID:uuid] (UUID format) | `\[JID:([a-f0-9\-]{36})\]` — UUID format. | |
| Job ID prefix like 'JID-123' (no brackets) | `(?:JID\|job_?id)[:\-]?\s*([\w\-]+)` — flexible. | |
| **Flexible pattern with semantic + unique hybrid** | `\[(?:Job\s*ID\|JID):\s*([a-zA-Z0-9\-]+)\]` case-insensitive. Matches semantic prefixes like DEV-8A2F. | ✓ |

**User's choice:** Flexible pattern `\[(?:Job\s*ID|JID):\s*([a-zA-Z0-9\-]+)\]` (case insensitive)

**User note:** Supports semantic prefixes from job title (e.g., DEV) + unique identifier (random alphanumeric like 8A2F, or auto-increment like 104)

---

## Gray Area 5: Job shortId Generation

| Option | Description | Selected |
|--------|-------------|----------|
| User-provided (recruiter sets it) | Like 'DEV-2025' or 'SALES-Q1'. Flexible but requires UI/API change. | |
| Auto-generated from job title (deterministic) | System generates from word letters (SBD, FE). No user input. | |
| Auto-generated UUID shorthand (random token) | Short random like 'a8f9k'. Unique but no meaning. | |
| **Hybrid semantic + unique identifier** | Semantic prefix from job title (DEV) + random alphanumeric or auto-increment (8A2F or 104). | ✓ |

**User's choice:** Hybrid approach — auto-generated semantic prefix from job title + unique identifier (random alphanumeric like '8A2F' OR auto-incrementing integer like '104', e.g., 'DEV-8A2F' or 'DEV-104')

**Key constraints:**
- Ensures human readability while guaranteeing global uniqueness
- No recruiter input required during job creation
- UI displays this shortId prominently on job card and detail views

---

## Gray Area 6: Backward Compatibility with Phase 6.5 Semantic Matching

| Option | Description | Selected |
|--------|-------------|----------|
| Leave them as-is (no backfill) | Existing candidates keep semantic-matched job_id. New emails use deterministic. Two populations. | ✓ |
| Mark existing as 'legacy' (add flag) | Add semantically_matched=true for identification. | |
| Not applicable (greenfield) | No existing candidates yet. | |

**User's choice:** Leave existing candidates as-is. No backfill. No legacy flag.

**Key insight:** Phase 6.5 and Phase 15 candidates coexist with different routing origins. Only new emails after Phase 15 deployment use deterministic routing.

---

## Gray Area 7: Scoring Skip Details

| Option | Description | Selected |
|--------|-------------|----------|
| No applications created (jobId=null) | Never create application rows for unmatched. Cleaner but lose relationship. | |
| Create with 'deferred' stage (new status) | Create applications with special 'deferred' stage. Visible in Kanban. | |
| **Follow existing code behavior** | Use whatever the codebase already does for unmatched candidates. | ✓ |

**User's choice:** Follow existing code behavior. The ingestion processor already handles `jobId = null` correctly (scoring is skipped automatically).

**Key insight:** No new status field or 'deferred' stage needed. Leverage existing null jobId handling.

---

## Gray Area 8: JobTitleMatcherService Removal

| Option | Description | Selected |
|--------|-------------|----------|
| Delete entirely (Phase 15) | Remove src/scoring/job-title-matcher.service.ts and all imports. Clean break. | ✓ |
| Keep but disable (mark unused) | Leave file and imports, comment out usage. Easier rollback. | |
| Leave as-is for now | Don't remove. Keep available for future phases or A/B testing. | |

**User's choice:** Delete the service entirely (Phase 15)

**Implementation scope:**
- Remove `src/scoring/job-title-matcher.service.ts` (entire file + .spec.ts)
- Remove JobTitleMatcherService from IngestionModule imports and provider declarations
- Remove JobTitleMatcherService constructor injection from IngestionProcessor
- Remove all `await this.jobTitleMatcher.matchJobTitles()` calls

---

## Claude's Discretion Areas

The following areas are left to Claude's implementation judgment:

- **shortId generation algorithm:** Whether to use auto-incrementing integers (SBD-1) or random alphanumeric (SBD-8A2F) for the unique suffix
- **Duplicate shortId conflict resolution:** How to handle (unlikely) case where two jobs generate identical prefixes
- **Email subject normalization:** Whether to uppercase/normalize the extracted Job ID before lookup
- **Error logging verbosity:** How detailed to log when regex finds no Job ID or Job lookup fails

---

*Discussion Mode: Standard (no advisor research)*
*All assumptions confirmed by user without revisions*
*Ready for planning*
