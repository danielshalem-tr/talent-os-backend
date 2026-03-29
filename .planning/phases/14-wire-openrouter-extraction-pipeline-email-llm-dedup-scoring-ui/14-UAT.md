---
status: testing
phase: 14-wire-openrouter-extraction-pipeline-email-llm-dedup-scoring-ui
source: [14-01-SUMMARY.md, 14-02-SUMMARY.md, 14-03-SUMMARY.md]
started: 2026-03-29T11:13:00Z
updated: 2026-03-29T11:13:00Z
---

## Current Test

<!-- OVERWRITE each test - shows where we are -->

number: 2
name: AI Extraction - 10 Fields Validation
expected: |
Send an email with a CV attachment. The ExtractionAgentService should extract all 10 fields: `full_name`, `email`, `phone`, `current_role`, `years_experience` (integer), `location`, `job_title_hint`, `skills`, `ai_summary`, and `source_hint`.

Verify in DB: The candidate record has these fields populated correctly from the CV content.
awaiting: user response

## Tests

### 1. Cold Start Smoke Test

expected: |
Kill any running server/service. Clear ephemeral state (temp DBs, caches, lock files). Start the application from scratch. Server boots without errors, any seed/migration completes, and a primary query (health check, homepage load, or basic API call) returns live data.
result: pass
reason: "User skipped seeding to start completely fresh."

### 2. AI Extraction - 10 Fields Validation

expected: |
Send an email with a CV attachment. The ExtractionAgentService should extract all 10 fields: `full_name`, `email`, `phone`, `current_role`, `years_experience` (integer), `location`, `job_title_hint`, `skills`, `ai_summary`, and `source_hint`.

Verify in DB: The candidate record has these fields populated correctly from the CV content.
result: [pending]

### 3. AI Extraction - Metadata Detection

expected: |
Send an email where important context (like the role being applied for or the source) is only in the Subject or From address, not the body.

Verify: The `extract()` call includes Subject/From in the user message, and the LLM correctly uses this metadata to populate `job_title_hint` or `source_hint`.
result: [pending]

### 4. Job Matching (Levenshtein Similarity)

expected: |
Create an active job "Frontend Developer". Send a CV with `job_title_hint` "React Developer".

Verify: The IngestionProcessor matches the candidate to the "Frontend Developer" job using Levenshtein similarity (Phase 6.5) and assigns `jobId` and `hiringStageId` to the candidate record.
result: [pending]

### 5. AI Scoring - Real OpenRouter Call

expected: |
Ensure `OPENROUTER_API_KEY` is configured. Process a candidate against an active job.

Verify: The `ScoringAgentService` calls `google/gemini-2.0-flash`. The resulting score is dynamic (not hardcoded 72) and includes reasoning, strengths, and gaps.
result: [pending]

### 6. Deterministic Fallback on Final Attempt

expected: |
Force the OpenRouter API to fail (e.g., by providing an invalid key or mocking a 401). Let BullMQ retry until the final attempt (3/3).

Verify: On the final attempt, the processor calls `extractDeterministically()`. The candidate is still created, but with `suspicious: true` and partial data (null for most fields).
result: [pending]

### 7. End-to-End Pipeline Integrity

expected: |
Send a real-world CV.
Verify:

- Extraction (10 fields)
- Dedup (check for existing)
- Job Matching (auto-assignment)
- Scoring (real AI score)
- Terminal status updated in `email_intake_log`
  result: [pending]

## Summary

total: 7
passed: 1
issues: 0
pending: 6
skipped: 0

## Gaps

[none yet]
