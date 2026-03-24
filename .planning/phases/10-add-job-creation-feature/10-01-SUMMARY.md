---
phase: 10-add-job-creation-feature
plan: "01"
subsystem: database-schema
tags: [prisma, migration, schema, job-stages, screening-questions]
dependency_graph:
  requires: [10-00]
  provides: [JobStage table, ScreeningQuestion table, extended Job fields, Application.jobStageId]
  affects: [prisma-client, jobs-service, applications-service]
tech_stack:
  added: []
  patterns: [additive-schema-migration, coexistence-period, tenant-on-every-table]
key_files:
  created:
    - prisma/migrations/20260324080822_add_job_creation_models/migration.sql
  modified:
    - prisma/schema.prisma
decisions:
  - D-01: Kept description and requirements[] on Job — additive migration only
  - D-02: Kept Application.stage String alongside new nullable jobStageId FK — coexistence period
  - D-09: responsibleUserId is @db.Text (free text), not @db.Uuid — no User model exists
  - D-10: JobStage and ScreeningQuestion include tenant relations; Tenant adds back-relations
metrics:
  duration: "2 minutes"
  completed: "2026-03-24"
  tasks_completed: 2
  files_changed: 2
---

# Phase 10 Plan 01: Schema Migration — Job Creation Models Summary

Prisma schema extended with JobStage and ScreeningQuestion models plus 8 additive fields on Job and nullable jobStageId FK on Application; migration applied to PostgreSQL with all 114 tests passing.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Extend prisma/schema.prisma with new models and fields | 56de61f | prisma/schema.prisma |
| 2 | Run prisma migrate dev to generate and apply migration | 5269f96 | prisma/migrations/20260324080822_add_job_creation_models/migration.sql |

## What Was Built

### New Models

**JobStage** (`job_stages` table):
- Fields: id, tenantId, jobId, name, order (SmallInt), responsibleUserId (Text — free text per D-09), isCustom, createdAt, updatedAt
- Relations: tenant (Tenant), job (Job onDelete:Cascade), applications (Application[])
- Index: `idx_job_stages_job_order` on (jobId, order)

**ScreeningQuestion** (`screening_questions` table):
- Fields: id, tenantId, jobId, text, answerType, required, knockout, order (SmallInt), createdAt, updatedAt
- Relations: tenant (Tenant), job (Job onDelete:Cascade)
- Index: `idx_screening_questions_job` on (jobId)

### Extended Models

**Job** — 8 new optional fields added:
- roleSummary, responsibilities, whatWeOffer (Text nullable)
- mustHaveSkills, niceToHaveSkills, preferredOrgTypes (String[] default [])
- expYearsMin, expYearsMax (SmallInt nullable)
- hiringStages JobStage[] and screeningQuestions ScreeningQuestion[] relations
- description, requirements[] KEPT (D-01)

**Application** — jobStageId (UUID nullable FK to JobStage) added; original stage String field KEPT (D-02)

**Tenant** — jobStages JobStage[] and screeningQuestions ScreeningQuestion[] back-relations added (D-10)

## Verification

- `npx prisma validate` — passed (schema valid)
- `npx prisma migrate status` — "Database schema is up to date!" (3/3 migrations applied)
- `npm test` — 114 tests passed, 18 todo, 0 failures, 18 suites

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None — this plan is schema-only. No service or endpoint code.

## Self-Check: PASSED

- `prisma/schema.prisma` — FOUND (contains model JobStage, model ScreeningQuestion, roleSummary, jobStageId, stage String default "new", description String?, jobStages JobStage[], screeningQuestions ScreeningQuestion[], responsibleUserId @db.Text)
- `prisma/migrations/20260324080822_add_job_creation_models/migration.sql` — FOUND (contains CREATE TABLE job_stages, CREATE TABLE screening_questions, ALTER TABLE jobs ADD COLUMN role_summary, ALTER TABLE applications ADD COLUMN job_stage_id)
- Commit 56de61f — schema changes
- Commit 5269f96 — migration SQL
