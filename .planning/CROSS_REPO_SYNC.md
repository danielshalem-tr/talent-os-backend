# Cross-Repo Synchronization: Stage Bank Expansion (Phase 7)

**Initiated:** 2026-03-25 (Frontend Phase 7, Plan 07-01)
**Frontend Context:** /Users/danielshalem/triolla/talent-os-client/.planning/phases/07-refactor-hiring-flow-to-stage-bank-model-with-per-job-stage-configuration/
**Backend Task:** Expand DEFAULT_HIRING_STAGES from 4 to 8 predefined stages

## Why These Changes

Frontend is implementing a Stage Bank model where each job can customize which of 8 predefined stages are enabled, reordered, and assigned interviewers. This backend task supports that by expanding the stage template available via /config endpoint.

## What Changed

- `src/jobs/jobs.service.ts` — DEFAULT_HIRING_STAGES expanded to 8 stages
- `src/config/app-config/app-config.service.ts` — hiring_stages_template expanded to 8 entries

## Stage Bank Composition (AUTHORITATIVE)

1. Application Review (enabled) | bg-zinc-400
2. Screening (enabled) | bg-blue-500
3. Interview (enabled) | bg-indigo-400
4. Offer (enabled) | bg-emerald-500
5. Hired (disabled) | bg-green-600
6. Rejected (disabled) | bg-red-500
7. Pending Decision (disabled) | bg-yellow-400
8. On Hold (disabled) | bg-gray-500

## Frontend Coordination

The frontend will:
- Load the 8-stage template via GET /config (via useConfig hook)
- Allow jobs to toggle stages, reorder, and assign interviewers
- Persist complete hiring_flow array (delete-all-recreate-new pattern)

No backend schema changes required (JobStage table already supports this).

## Verification

- Backend /config endpoint returns hiring_stages_template with 8 entries
- All 8 stages have correct names, colors, is_enabled values, order
- Backend compiles without errors
- Live API test confirmed on 2026-03-25 (curl response verified)

## Backend GSD Instance Action (if applicable)

If the backend's GSD instance needs a corresponding task for tracking:
- Consider adding a documentation phase or marking in STATE.md
- Reference this sync file and the frontend phase 7 planning artifacts
- Ensure both instances are aligned on the Stage Bank specification

**Source:** Frontend Phase 7 DECISIONS.md
**Last Updated:** 2026-03-25
