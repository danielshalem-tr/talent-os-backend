---
phase: quick-260408-c3g
plan: "01"
subsystem: docs
tags: [docs, readme, system-flows, accuracy]
dependency_graph:
  requires: []
  provides: [accurate-readme, pipeline-flowchart-tab]
  affects: [README.md, docs/system-flows.html]
tech_stack:
  added: []
  patterns: []
key_files:
  created: []
  modified:
    - README.md
    - docs/system-flows.html
decisions:
  - "Used existing CSS variables for flowchart dark theme (no hardcoded light colors)"
  - "Flowchart implemented as styled HTML divs — no external libraries"
metrics:
  duration: "~10 minutes"
  completed: "2026-04-08T05:47:00Z"
  tasks_completed: 2
  tasks_total: 2
  files_changed: 2
---

# Phase quick-260408-c3g Plan 01: Audit and Fix README + Add Pipeline Flowchart Summary

**One-liner:** README accuracy fixes (OPENROUTER_API_KEY, gpt-4o-mini, remove defunct Makefile targets, Jenkins → GitHub Actions) plus ASCII flowchart in README and styled vertical flowchart tab in system-flows.html.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Fix README.md accuracy issues | 8b25837 | README.md |
| 2 | Add Pipeline Flowchart tab to docs/system-flows.html | bcf0e05 | docs/system-flows.html |

## What Was Done

### Task 1: Fix README.md accuracy issues

Applied 6 targeted fixes to README.md:

1. **Environment Variables table** — replaced `ANTHROPIC_API_KEY` row with `OPENROUTER_API_KEY` pointing to openai/gpt-4o-mini.
2. **Makefile Targets table** — removed 2 non-existent rows: `make migrate-prod` and `make ssl-setup DOMAIN=x EMAIL=y`.
3. **Architecture diagram** — updated both agent lines: `Claude Haiku` → `gpt-4o-mini via OpenRouter`, `Claude Sonnet` → `gpt-4o-mini via OpenRouter`.
4. **Deployment section** — removed the "Provision TLS certificate (once)" and "Run database migrations" subsections that referenced the deleted Makefile targets.
5. **CI/CD section** — replaced "CI/CD (Jenkins)" heading and all Jenkins-era content with GitHub Actions description referencing `.github/workflows/ci.yml`.
6. **Pipeline Flowchart** — added new `## Pipeline Flowchart` section with 10-step ASCII art showing the full email-to-DB pipeline with decision branches.

### Task 2: Add Pipeline Flowchart tab to docs/system-flows.html

- Added "Pipeline Flowchart" nav button after the "Data Models" tab button, wired to `showTab('flowchart')`.
- Added `<div id="tab-flowchart" class="section">` content panel with a vertical CSS flowchart.
- Flowchart uses existing dark theme CSS variables (`--surface`, `--surface2`, `--border`, `--accent-blue`, `--accent-purple`, `--accent-green`, `--accent-cyan`, `--accent-orange`, `--accent-red`, `--muted`, `--text`).
- 10 pipeline steps with 2 decision branches (idempotency check, DedupService duplicate detection) shown with red rejection indicators.
- Uses the existing `showTab()` JavaScript function — no second tab management system introduced.

## Verification Results

| Check | Expected | Actual | Pass |
|-------|----------|--------|------|
| OPENROUTER_API_KEY in README | >= 1 | 1 | Yes |
| ANTHROPIC_API_KEY in README | 0 | 0 | Yes |
| Claude Haiku/Sonnet in README | 0 | 0 | Yes |
| migrate-prod/ssl-setup in README | 0 | 0 | Yes |
| Pipeline Flowchart in README | >= 1 | 1 | Yes |
| Pipeline Flowchart in system-flows.html | >= 1 | 2 | Yes |
| gpt-4o-mini in system-flows.html | >= 1 | 2 | Yes |

## Deviations from Plan

None — plan executed exactly as written. The flowchart in system-flows.html uses dark theme CSS variables as instructed (overriding the light color suggestions in the plan's `<action>` block, which conflicted with the instruction to "match the dark theme").

## Known Stubs

None.

## Threat Flags

None — documentation-only changes, no new network endpoints or security surface.

## Self-Check: PASSED

- README.md modified: confirmed
- docs/system-flows.html modified: confirmed
- Commit 8b25837 exists: confirmed
- Commit bcf0e05 exists: confirmed
