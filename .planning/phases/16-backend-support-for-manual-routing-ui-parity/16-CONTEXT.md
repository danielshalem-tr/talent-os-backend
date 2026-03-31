# Phase 16: Backend Support for Manual Routing & UI Parity — Context

**Gathered:** 2026-03-31
**Status:** Ready for planning

<domain>
## Phase Boundary

Enable recruiters to manually assign candidates to jobs—both for unmatched candidates (jobId = null from Phase 15) and for reassigning candidates between jobs. Extend the PATCH /candidates/:id endpoint to support job reassignment while preserving full historical audit trail.

**Current state:** PATCH /candidates/:id only allows initial job assignment (jobId = null → jobId = X). Reassignment (jobId = X → jobId = Y) is blocked with ALREADY_ASSIGNED error. Unmatched candidates from Phase 15 exist but cannot be easily routed into the hiring pipeline.

**Target state:** Recruiters can manually assign any candidate to any job. When reassigned, the old Application record is preserved (historical audit), a new Application is created, and the candidate is re-scored against the new job's requirements. Hiring stage resets to first enabled stage of the new job.

</domain>

<decisions>
## Implementation Decisions

### Manual Job Reassignment
- **D-01:** Extend PATCH /candidates/:id endpoint to allow job_id updates even if candidate already has a job. Remove the ALREADY_ASSIGNED error for reassignment cases.
- **D-02:** UpdateCandidateSchema unchanged — job_id field already supports UUID validation and is optional.

### Application Handling on Reassignment
- **D-03:** When reassigning a candidate to a new job, keep the old Application record intact (DO NOT delete, UPDATE, or mark as archived). Preserve full historical scores and audit trail.
- **D-04:** Create a new Application record for the new job with stage = first enabled stage of the new job.
- **D-05:** Trigger ScoringAgentService.score() for the candidate against the new job's requirements. Store results in candidate_job_scores (append-only, as per Phase 7 constraints).

### Hiring Stage Management
- **D-06:** When reassigning, always reset candidate.hiringStageId to the first enabled stage (orderBy asc) of the new job. No stage preservation or name matching.
- **D-07:** If new job has no enabled stages, reject reassignment with 400 Bad Request. Do not allow orphaned candidates without a valid hiring flow.

### Candidate State & Jobid Update
- **D-08:** Update candidate.jobId to the new job UUID atomically within the same transaction as Application creation and score insertion.
- **D-09:** No new status fields or flags needed. Existing candidate.status = "active" remains.

### Scope & API Surface
- **D-10:** API only: single-candidate reassignment via PATCH /candidates/:id. No bulk assignment endpoint (left to frontend).
- **D-11:** No audit trail required. Rely on existing updatedAt timestamp on Application + CandidateJobScore records for historical reference.
- **D-12:** Response format: PATCH /candidates/:id returns CandidateResponse with updated jobId, hiringStageId. **CRITICAL: CandidateResponse DTO remains flattened—NO nested `applications` array. Returns only `ai_score` (calculated via Math.max of candidate_job_scores for current job).**
- **D-13:** GET /candidates endpoint supports native `unassigned` filter mapping to `{ jobId: null }`. Recruiters can retrieve unmatched candidates from Phase 15 via ?unassigned=true query param.
- **D-14:** Jobs endpoints expose `shortId` field in responses (used by Phase 15 email subject parsing; recruiters see this identifier). Candidates endpoints expose `sourceAgency` field (sourcing channel metadata).

### Validation & Error Handling
- **D-15:** When reassigning, validate that the target job exists and belongs to the same tenant (existing FK constraint).
- **D-16:** Validate that the target job has at least one enabled stage. If not, return 400 with code "NO_STAGES".
- **D-17:** If the job_id provided matches the existing jobId, treat as no-op for the job_id field (same as current behavior). Other profile fields still update if provided.

### Profile Updates + Reassignment
- **D-18:** PATCH /candidates/:id can atomically update profile fields (full_name, email, etc.) AND reassign job in one call. Handle both in single transaction.
- **D-19:** If job reassignment fails (e.g., validation error), the entire request fails and no profile updates are applied.

### Scoring & ScoringAgentService Integration
- **D-20:** Reassignment always triggers a fresh score call to ScoringAgentService.score() against the new job. Do not reuse old scores.
- **D-21:** Scoring failure does not block reassignment (log warning, continue). Candidate is assigned but score insertion fails gracefully (existing error handling from Phase 7).

## Claude's Discretion

- **ScoringAgentService.score() async handling:** Whether to await score insertion or fire-and-forget. Phase 7 already shows the pattern; use existing approach.
- **Application creation data:** Any default values for Application.stage or metadata when creating the new record during reassignment. Phase 7 shows the pattern.
- **Response optimization:** Whether to return nested Application[0] (latest) or all Applications (full history) in CandidateResponse during reassignment. Current GET endpoint probably already shows all; keep consistent.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Existing Services to Modify
- `src/candidates/candidates.service.ts:updateCandidate()` — Remove ALREADY_ASSIGNED error. Add reassignment flow: job validation, new Application creation, ScoringAgentService call.
- `src/candidates/candidates.service.ts:findAll()` — Add native support for `unassigned` filter query param, mapping to { jobId: null } in Prisma where clause.
- `src/candidates/candidates.controller.ts:updateCandidate()` — No changes (Zod validation already handles job_id).
- `src/candidates/candidates.controller.ts:findAll()` — Add query param parsing for `unassigned` boolean.

### Existing Patterns to Follow
- **Application creation:** Phase 7 (Candidate Storage & Scoring) shows `createApplication()` pattern
- **ScoringAgentService.score() call:** Phase 7 shows how to invoke and handle results
- **Error handling:** Use BadRequestException for 400 errors, NotFoundException for missing candidates/jobs
- **Transaction pattern:** Phase 6 and 7 show Prisma $transaction usage for atomic multi-table updates

### Files to Reference
- `src/candidates/dto/update-candidate.dto.ts` — UpdateCandidateSchema (no changes needed)
- `src/candidates/dto/candidate-response.dto.ts` — Response format **MUST be flattened, NO applications array. Add sourceAgency field.**
- `src/jobs/dto/job-response.dto.ts` — **Add shortId field to expose in GET /jobs and GET /jobs/:id responses.**
- `prisma/schema.prisma` — Application, Candidate, CandidateJobScore models (no schema changes)
- `src/scoring/scoring-agent.service.ts` — ScoringAgentService.score() signature and error handling

### Phase 15 Context (Prior Phase)
- See `.planning/phases/15-migrate-email-ingestion-to-deterministic-job-id-routing-and-remove-semantic-matching/15-CONTEXT.md` for unmatched candidate creation pattern and Job.shortId lookup pattern

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **CandidatesService.updateCandidate():** Already handles profile field updates atomically. Remove ALREADY_ASSIGNED error, add job reassignment branch.
- **CandidatesService.findOne():** Already returns full CandidateResponse with nested Applications + scores. Use existing query for response.
- **ScoringAgentService:** Already integrated in Phase 7. Pattern: `await this.scoringAgent.score(candidate, job)` returns { score, reasoning, strengths, gaps }.
- **JobStage lookup:** Phase 11 shows `findFirst({ where: { jobId, tenantId, isEnabled: true }, orderBy: { order: 'asc' } })` pattern for first enabled stage.

### Established Patterns
- **Tenant isolation:** All queries already filter by tenantId from ConfigService.get('TENANT_ID').
- **Atomic transactions:** Phase 6 shows Prisma.$transaction pattern for multi-table updates (Application + CandidateJobScore insertion).
- **Error responses:** BadRequestException used throughout; format: `{ error: { code, message, details } }`.
- **Validation:** Zod schemas for DTOs; safeParse used in controller before service call.

### Integration Points
- **ScoringAgentService:** Called from IngestionProcessor in Phase 7. Reassignment uses same call pattern.
- **Application creation:** CandidatesService.createCandidate() shows Application creation during initial job assignment. Reuse for reassignment.
- **Job lookup:** Existing `prisma.job.findFirst()` queries already filtered by (jobId, tenantId).

### No Schema Changes Required
- Candidate: Already has jobId, hiringStageId (both nullable)
- Application: Already exists with job_id FK. No new fields needed.
- CandidateJobScore: Append-only by design (Phase 7). Multiple scores per candidate-job pair allowed.
- No new audit table or metadata columns required (per D-11).

</code_context>

<specifics>
## Specific Ideas & Constraints

### Manual Reassignment Workflow (Backend)
1. Recruiter calls PATCH /candidates/{id} with `{ job_id: "new-job-uuid" }`
2. Backend validates:
   - Candidate exists and belongs to tenant
   - New job exists and belongs to tenant
   - New job has at least one enabled stage (400 if not)
3. Backend executes atomically:
   - Find first enabled stage of new job (orderBy asc)
   - Create new Application record (stage = first stage, created_at = now)
   - Call ScoringAgentService.score(candidate, newJob) — store results in candidate_job_scores
   - Update Candidate: jobId = newJob, hiringStageId = firstStage
4. Return updated CandidateResponse with new jobId + Applications + latest scores

### Unmatched Candidate Routing (Phase 15 → 16 flow)
- Phase 15 creates candidates with jobId = null (no Job ID in email subject)
- Phase 16 enables recruiting to manually assign these candidates: PATCH /candidates/{id} with job_id
- No bulk assignment endpoint (Phase 16); UI handles single assignments
- Bulk assignment (if needed) is left to Phase 2+ (UI responsibilities)

### Example Request/Response

```json
PATCH /candidates/550e8400-e29b-41d4-a716-446655440000

Request Body:
{
  "job_id": "660e8400-e29b-41d4-a716-446655440001"
}

Response 200 OK:
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "job_id": "660e8400-e29b-41d4-a716-446655440001",
  "hiring_stage_id": "first-stage-uuid",
  "full_name": "Jane Doe",
  "email": "jane@example.com",
  "source_agency": "LinkedIn",
  "is_duplicate": false,
  "is_rejected": false,
  "ai_score": 78,
  ...
}
```

**Note:** CandidateResponse DTO is **flattened** — does NOT include `applications` array. The `ai_score` field is calculated via `Math.max(candidate_job_scores[*].score)` for the current job at response time.

### Testing Checklist (Phase 16 acceptance criteria)
- [ ] PATCH /candidates/:id with job_id removes ALREADY_ASSIGNED error
- [ ] Reassignment creates new Application record
- [ ] Reassignment triggers ScoringAgentService.score() for new job
- [ ] Old Application + scores preserved (historical audit)
- [ ] hiringStageId set to first enabled stage of new job
- [ ] Validation: new job has at least one enabled stage (400 if not)
- [ ] Validation: new job exists and belongs to tenant (404 if not)
- [ ] Atomic transaction: all updates succeed or all fail
- [ ] **Response format: CandidateResponse is FLATTENED (NO nested applications array). Only ai_score returned, calculated via Math.max**
- [ ] Profile updates + job reassignment work atomically in single call
- [ ] Unmatched candidate (jobId = null) → can be assigned to any job
- [ ] Already-assigned candidate → can be reassigned to different job
- [ ] Same-job reassignment → no-op for job_id, other fields still update
- [ ] **GET /candidates?unassigned=true returns candidates with jobId = null**
- [ ] **Jobs endpoints expose shortId field in responses (e.g., GET /jobs, GET /jobs/:id)**
- [ ] **Candidates endpoints expose sourceAgency field in responses (e.g., GET /candidates, GET /candidates/:id)**

</specifics>

<deferred>
## Deferred Ideas

- **Bulk reassignment endpoint** — POST /candidates/bulk-assign — Phase 2+ (recruiter UI layer handles multi-select)
- **Stage preservation on reassignment** — "Keep stage if name exists in new job" — explicitly deferred; Phase 16 always resets to first stage
- **Audit trail / assigned_by tracking** — Explicitly deferred; Phase 16 has no audit metadata
- **Admin UI for shortId management** — Phase 16 mentions in deferred; left to later phases
- **Fallback to semantic matching if manual assignment fails** — Out of scope; Phase 15 removed semantic matching entirely

</deferred>

---

*Phase: 16-backend-support-for-manual-routing-ui-parity*
*Context gathered: 2026-03-31 (discuss mode)*
