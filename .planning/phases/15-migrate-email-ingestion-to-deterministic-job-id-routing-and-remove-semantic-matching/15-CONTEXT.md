# Phase 15: Migrate email ingestion to deterministic Job ID routing — Context

**Gathered:** 2026-03-31
**Status:** Ready for planning

<domain>
## Phase Boundary

Remove semantic job title matching (Phase 6.5 JobTitleMatcherService) and replace it with deterministic Job ID extraction from email subject lines.

**Current state:** IngestionProcessor fetches all active jobs and calls JobTitleMatcherService (OpenRouter LLM) to semantically match the candidate's job title hint against each job title. This is expensive (1 API call per candidate per active job) and adds latency.

**Target state:** Extract Job ID directly from email subject via regex pattern `[Job ID: 12345]` or `[JID: DEV-01]`. Look up the job by a new `shortId` field. Assign candidate to that job atomically. If no Job ID in subject, skip scoring entirely and store candidate as unmatched (jobId = null). This is faster, cheaper, deterministic, and gives recruiters control over candidate-job routing.

After this phase:
- No more JobTitleMatcherService LLM calls
- Candidates routed via email metadata, not semantic inference
- New `Job.shortId` field (hybrid: semantic prefix + unique identifier, e.g., "DEV-8A2F" or "DEV-104")
- Unmatched candidates stored and visible in UI for recruiter triage

</domain>

<decisions>
## Implementation Decisions

### Job ID Extraction
- **D-01:** Extract Job ID from email subject using regex pattern: `\[(?:Job\s*ID|JID):\s*([a-zA-Z0-9\-]+)\]` (case insensitive)
- **D-02:** Extraction happens in IngestionProcessor before LLM extraction — pure regex, no LLM involvement, no new fields in CandidateExtract schema
- **D-03:** Pattern matches: `[Job ID: 12345]`, `[job id: DEV01]`, `[JID: a8f9k]` etc. Capture group 1 is the Job ID value

### Job Model Schema Extension
- **D-04:** Add `shortId: string` field to Job model (unique across tenant, indexed for fast lookup)
- **D-05:** Hybrid generation algorithm:
  - Extract semantic prefix from job title (first letters of words, e.g., "Senior Backend Developer" → "SBD", "Frontend Engineer" → "FE")
  - Append unique suffix: either auto-incrementing integer per prefix (e.g., SBD-1, SBD-2) OR short random alphanumeric (e.g., SBD-8A2F)
  - Ensures human readability + strict uniqueness without recruiter input
- **D-06:** shortId displayed prominently in job card and detail views (UI responsibility, noted for Phase 16+ recruiter UI work)

### Extraction Schema Changes
- **D-07:** Remove `job_title_hint` field entirely from CandidateExtractSchema
  - Do NOT add `job_id_hint` to LLM extraction schema
  - Job ID is extracted outside the LLM path via regex
  - This keeps the extraction schema focused on CV data, not routing metadata

### Routing & Job Assignment
- **D-08:** IngestionProcessor regex extracts jobId from subject → looks up Job by shortId → sets candidate.jobId and candidate.hiringStageId
- **D-09:** If Job not found by shortId (e.g., stale email, typo), log warning and set candidate.jobId = null
- **D-10:** If regex finds no Job ID in subject, set candidate.jobId = null

### Unmatched Candidate Handling
- **D-11:** When candidate.jobId = null, SKIP scoring process entirely (no applications created, no scoring calls)
- **D-12:** Follow existing codebase behavior for unmatched candidates (assumed: candidate stored, visible in API, recruiter can manually assign job later via UI)
- **D-13:** No new status field or 'deferred' stage needed — leverage existing null jobId handling

### Backward Compatibility
- **D-14:** Leave existing candidates as-is — no backfill of job assignments from Phase 6.5 semantic matching
- **D-15:** New routing applies only to emails processed after Phase 15 deployment
- **D-16:** No legacy/migration marking — Phase 6.5 and Phase 15 candidates coexist with different routing origins

### Service Removal
- **D-17:** Delete JobTitleMatcherService entirely (`src/scoring/job-title-matcher.service.ts` and `.spec.ts`)
- **D-18:** Remove JobTitleMatcherService from IngestionModule imports and provider declarations
- **D-19:** Remove JobTitleMatcherService from IngestionProcessor constructor and all `await this.jobTitleMatcher.matchJobTitles()` calls

## Claude's Discretion

- **shortId generation algorithm detail:** Whether to use auto-incrementing integers (SBD-1) or random alphanumeric (SBD-8A2F) for the unique suffix — both guarantee uniqueness and are human-readable. Incrementing is simpler to implement; random is harder to enumerate/brute-force. Choose based on engineering preference during planning.
- **Duplicate Job shortId handling:** If two jobs generate the same prefix (unlikely but possible), conflict resolution is Claude's choice (e.g., append tenant_id, use hash, retry generation).
- **Regex case sensitivity:** The pattern is case-insensitive, but should email subjects be normalized? (e.g., always uppercase Job ID before lookup?) Left to implementation judgment.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Existing Services to Modify
- `src/ingestion/ingestion.processor.ts` — Remove JobTitleMatcherService dependency, add regex extraction logic for Job ID from subject, update job assignment flow
- `src/ingestion/services/extraction-agent.service.ts` — Remove `job_title_hint` from CandidateExtractSchema and fallback; simplify INSTRUCTIONS
- `prisma/schema.prisma` — Add `shortId` field to `Job` model with UNIQUE constraint (tenant_id, shortId)

### Services to Remove
- `src/scoring/job-title-matcher.service.ts` (entire file + .spec.ts) — No longer needed after Phase 15

### Files to Update
- `src/ingestion/ingestion.module.ts` — Remove JobTitleMatcherService from providers
- `src/scoring/scoring.module.ts` — Remove JobTitleMatcherService export (if exported)

### Postmark Webhook Format (unchanged)
- Payload includes `Subject`, `From`, `MessageID`, `MailboxHash`, body, attachments
- Subject line is where Job ID is extracted — processor already receives this in `payload.Subject`

### Phase 14 Context (prior phase decision)
- See `.planning/phases/14-wire-openrouter-extraction-pipeline-email-llm-dedup-scoring-ui/14-CONTEXT.md` for extraction pipeline, scoring, and error handling patterns

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **IngestionProcessor:** Already has email metadata (subject, from) available from Postmark payload; regex extraction fits naturally into the job-matching phase
- **Prisma client:** Already handles unique constraints; shortId index can be added via Prisma migration
- **Job lookup pattern:** Existing code pattern for `findUnique` by job.id can be adapted to `findUnique({where: {shortId_tenantId}})` for lookup

### Established Patterns
- **Job assignment:** IngestionProcessor already sets `candidate.jobId` and `candidate.hiringStageId` in Phase 7 enrichment
- **Null jobId handling:** Existing code already treats `jobId = null` as valid (no job assigned); scoring logic already skips when `jobId = null` (verified in PR 260329-kxa commit)
- **Schema changes:** Prisma migrations handled consistently (Phase 11 added screening_questions, Phase 13 added hiring_stage_id); shortId follows same pattern

### Integration Points
- **Email subject access:** IngestionProcessor receives full Postmark payload in `process()` method — subject already accessible via `payload.Subject`
- **Job lookup:** Processor uses PrismaService for job queries; shortId lookup is an additional `prisma.job.findUnique()` call
- **No API changes:** REST endpoints unchanged (shortId is internal; UI displays it via GET /jobs/:id response)

</code_context>

<specifics>
## Specific Ideas & Constraints

### Email Subject Pattern Examples
- `Subject: [Job ID: 12345] Your CV for Backend Developer role` ✓ Matches
- `Subject: [jid: DEV-01] Applicant submission` ✓ Matches (case insensitive)
- `Subject: [Job ID: a8f9k] Please review` ✓ Matches
- `Subject: New applicant for Backend role [Job ID: xyz]` ✓ Matches (anywhere in subject)
- `Subject: Your CV submission` ✗ No match → jobId = null

### shortId Display
- Job card in UI: "DEV-8A2F" (right of job title, clear and compact)
- Copy-to-clipboard button for recruiters to paste into email subject when forwarding CVs
- RECRUITMENT_GUIDE.md (Phase 16) should document: "Include [Job ID: DEV-8A2F] in the subject when forwarding CVs to the system"

### Cost & Performance Impact
- **Before Phase 15:** 1 OpenRouter LLM call per candidate per active job (e.g., 5 candidates × 3 open jobs = 15 API calls)
- **After Phase 15:** 0 LLM calls for job routing (pure regex + DB lookup, ~1-2ms per candidate)
- **Savings:** ~$0.0003-0.0005 per candidate (5 open jobs avg), plus latency reduction

### Testing Checklist (Phase 15 acceptance criteria)
- [ ] CandidateExtractSchema validates without `job_title_hint` field
- [ ] Regex extracts Job ID correctly from various subject formats
- [ ] IngestionProcessor looks up Job by (shortId, tenantId) and sets candidate.jobId
- [ ] No job found → candidate stored with jobId = null
- [ ] No Job ID in subject → candidate stored with jobId = null
- [ ] Scoring is skipped for candidates with jobId = null (no applications created, no score calls)
- [ ] JobTitleMatcherService file removed from src/
- [ ] No imports or references to JobTitleMatcherService remain in src/
- [ ] Prisma migration adds Job.shortId field with UNIQUE(tenantId, shortId) constraint
- [ ] Existing candidates unaffected (no backfill)
- [ ] E2E test: email with [Job ID: shortId] in subject → candidate created + assigned to correct job + scored
- [ ] E2E test: email without Job ID → candidate created + unmatched (jobId = null) + no scoring

</specifics>

<deferred>
## Deferred Ideas

- **Admin UI for shortId management** — Phase 16 (Recruiter UI); shortId generation is automated, but recruiters may want to rename/edit shortIds later
- **Job ID search/discovery in candidate inbox** — Phase 16; UI could show "Which job is this for?" dropdown when recruiter manually assigns jobs
- **Bulk email forwarding with auto-injected Job ID** — Phase 2+ (Outreach); system forwards CV to candidates with [Job ID: XYZ] pre-populated
- **Fallback to semanticmatching if no Job ID found** — Explicitly deferred; Phase 15 is deterministic-only, no LLM fallback
- **Legacy job ID format migration** — Future if Job IDs change format; for now, regex is flexible

</deferred>

---

*Phase: 15-migrate-email-ingestion-to-deterministic-job-id-routing-and-remove-semantic-matching*
*Context gathered: 2026-03-31 (discuss mode)*
