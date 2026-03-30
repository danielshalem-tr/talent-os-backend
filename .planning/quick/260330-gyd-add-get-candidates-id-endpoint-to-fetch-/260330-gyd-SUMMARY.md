---
phase: quick-260330-gyd
plan: 01
subsystem: candidates-api
tags: [rest-api, candidates, endpoint]
dependency_graph:
  requires: []
  provides: [GET /candidates/:id]
  affects: [candidates.service.ts, candidates.controller.ts, PROTOCOL.md]
tech_stack:
  added: []
  patterns: [NestJS controller route, Prisma findFirst with tenant isolation, NotFoundException standard format]
key_files:
  created: []
  modified:
    - src/candidates/candidates.service.ts
    - src/candidates/candidates.controller.ts
    - PROTOCOL.md
decisions:
  - "Placed @Get(':id') before @Get(':id/cv-url') in controller to ensure NestJS route matching order is explicit"
  - "Reused exact select block from findAll() to keep response shape consistent"
metrics:
  duration: "5 minutes"
  completed_date: "2026-03-30"
  tasks_completed: 2
  files_modified: 3
---

# Phase quick-260330-gyd Plan 01: Add GET /candidates/:id Endpoint Summary

**One-liner:** GET /candidates/:id fetching a single CandidateResponse by ID with tenant isolation and standard 404 error format.

## What Was Built

Added `GET /candidates/:id` endpoint to the candidates API:

- `findOne(candidateId)` method in `CandidatesService` — queries by `{ id, tenantId }` using the same select block as `findAll()`, computes `ai_score` as MAX of all application scores, maps to snake_case `CandidateResponse`
- `@Get(':id')` route in `CandidatesController` placed before `@Get(':id/cv-url')` to maintain correct NestJS route resolution order
- PROTOCOL.md updated with `GET /candidates/:id` section including response shape and 404 error documentation

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 | b19fb39 | feat(quick-260330-gyd): add GET /candidates/:id endpoint |
| 2 | 13a8ec6 | docs(quick-260330-gyd): document GET /candidates/:id in PROTOCOL.md |

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Self-Check: PASSED

- `src/candidates/candidates.service.ts` — findOne method added, TypeScript compiles clean
- `src/candidates/candidates.controller.ts` — @Get(':id') route added before @Get(':id/cv-url')
- `PROTOCOL.md` — GET /candidates/:id section present at line 60
- Commits b19fb39 and 13a8ec6 verified in git log
