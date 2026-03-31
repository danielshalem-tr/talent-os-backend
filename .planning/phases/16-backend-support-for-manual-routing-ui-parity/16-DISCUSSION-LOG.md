# Phase 16: Backend Support for Manual Routing & UI Parity — Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions captured in CONTEXT.md — this log preserves the discussion.

**Date:** 2026-03-31
**Phase:** 16-backend-support-for-manual-routing-ui-parity
**Mode:** discuss (interactive)
**Areas analyzed:** Manual Job Reassignment, Application Handling, Hiring Stage Management, Scope & API Surface

## Discussion Summary

Phase 15 completed: email routing is now deterministic (regex + shortId lookup). Unmatched candidates (jobId = null) exist in the DB but cannot be easily assigned to jobs. Phase 16 removes the ALREADY_ASSIGNED error and enables manual job reassignment.

## Gray Areas & User Decisions

### Area 1: Application Handling on Reassignment

**Gray Area:** When reassigning a candidate to a new job, what happens to the old Application record and scoring history?

**Options Presented:**
- Delete old, create new (loses history)
- Archive old, create new (preserves audit)
- Keep both, no rescore (hybrid)

**User Decision:** Keep old Application and scores intact. Create new Application for new job, trigger fresh scoring.
**Rationale (user notes):** "Keep the old Application and its scores intact for historical audit purposes. Simply create a new Application for the newly assigned job, trigger a fresh scoring process, and update the Candidate's primary jobId and hiringStageId pointers."

### Area 2: Hiring Stage Reset

**Gray Area:** Should the hiring stage be reset, preserved, or manually selected when reassigning?

**Options Presented:**
- Always reset to first stage
- Preserve if stage name exists in new job
- Manual stage selection (recruiter chooses)

**User Decision:** Always reset
**Rationale:** Simplest behavior, consistent, no stage name matching logic needed.

### Area 3: Unmatched Candidate UX

**Gray Area:** Should Phase 16 include bulk assignment functionality or focus on API only?

**Options Presented:**
- API only (single-candidate PATCH)
- Add bulk assignment endpoint (POST /bulk-assign)
- Frontend UI responsibility

**User Decision:** API only (single-candidate PATCH)
**Rationale:** Minimal scope. Bulk selection/assignment left to frontend UI layer.

### Area 4: Audit Trail

**Gray Area:** Should Phase 16 track who manually assigned candidates and when?

**Options Presented:**
- No audit trail
- Metadata field in Application
- New audit_logs table

**User Decision:** No audit trail
**Rationale:** Simplified schema. Rely on existing updatedAt timestamps on Application and CandidateJobScore records.

### Area 5: API Endpoint Design

**Gray Area:** Should reassignment use existing PATCH /candidates/:id or a dedicated endpoint?

**Options Presented:**
- Extend existing PATCH /candidates/:id
- Dedicated PATCH /candidates/:id/job
- POST /candidates/:id/reassign (explicit verb)

**User Decision:** Extend existing PATCH /candidates/:id
**Rationale:** Reuse UpdateCandidateSchema. Supports profile updates + reassignment atomically in one call.

### Area 6: Validation on No Stages

**Gray Area:** When reassigning, what if the new job has no enabled stages?

**Options Presented:**
- Reject with 400 error
- Allow, set hiringStageId to null
- Auto-create default stage

**User Decision:** Reject with 400 error
**Rationale:** Prevent orphaned candidates without valid hiring flow. Explicit validation.

## Decisions Locked

See CONTEXT.md `<decisions>` section for full list. Key locks:

- D-01: Extend PATCH /candidates/:id; remove ALREADY_ASSIGNED error
- D-03 to D-05: Keep old Application, create new, trigger fresh scoring
- D-06: Always reset hiringStageId to first enabled stage
- D-07: Reject (400) if new job has no enabled stages
- D-10 to D-12: API only; no bulk endpoint; no audit trail
- D-18 to D-19: Always rescore on reassignment; scoring failure logged but doesn't block

## No Corrections Made

All assumptions presented were validated by user. No deviations or "let me correct that" feedback.

---

*Phase: 16-backend-support-for-manual-routing-ui-parity*
*Context gathered: 2026-03-31*
