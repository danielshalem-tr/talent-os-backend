# Phase 14: Wire OpenRouter extraction pipeline — Context

**Gathered:** 2026-03-29
**Status:** Ready for planning
**Source:** PRD Express Path (spec/PRD-extraction-pipeline-v2.md)

<domain>
## Phase Boundary

Fix bugs and gaps in the email-to-candidate extraction pipeline. The end-to-end pipeline already exists and runs, but has critical issues:

1. **Error handling bug** — extraction failures are silently swallowed, preventing BullMQ retries
2. **Incomplete schema** — LLM extracts only 5 fields; missing `currentRole`, `yearsExperience`, `location`, and source detection
3. **Weak prompt** — no few-shot examples, no field constraints, no email metadata passed to LLM
4. **Hardcoded mock scoring** — every candidate gets score=72 regardless of job or CV
5. **Dead fallback code** — deterministic extraction exists but is never called on final failure

After this phase, the pipeline will:
- Extract all candidate fields from CV + email metadata in a single Gemini LLM call
- Propagate extraction errors correctly so BullMQ retries on transient failures
- Use deterministic extraction as last-resort fallback before marking a job as failed
- Score candidates against each active job using real Gemini LLM (not mock), with OpenRouter free tier as primary, paid tier as fallback
- Stay within $5 OpenRouter budget: ~$0.0004 per extraction + ~$0.0004 per scoring call

**Tech:** `@openrouter/sdk`, OpenRouter free tier (`google/gemini-2.0-flash:free`), Zod schema validation, safeParse for resilience.

**Scope:** 4 files touched, 8 concrete tasks from PRD, ~4-5 hours estimated.

</domain>

<decisions>
## Implementation Decisions

### Error Handling & Retry Logic
- Remove try/catch in `ExtractionAgentService.extract()` — let errors propagate to processor, which retries via BullMQ
- On final BullMQ attempt (3/3), catch the error and try deterministic extraction as fallback
- Only mark job as `failed` if both AI and deterministic fail

### LLM Schema Extension
- Extend `CandidateExtractSchema` to include: `current_role`, `years_experience`, `location`, `source_hint`
- `years_experience` is single integer (e.g., convert "5-7 years" → 6)
- `source_hint` is enum: 'linkedin' | 'agency' | 'referral' | 'direct' | null
- All new fields are nullable except `skills` (array) and `full_name` (string)

### LLM Prompt Rewrite
- New prompt includes email metadata (Subject, From) as signals for source detection
- Includes few-shot example output showing all fields
- Specifies field constraints: years as single int, location as "City, Country", skills as 5-15 short tags
- ai_summary is exactly 2 sentences: role + experience, then skills/achievement

### Extraction Method Signature
- New signature: `extract(fullText, suspicious, metadata: { subject, fromEmail }): Promise<CandidateExtract>`
- Processor passes `payload.Subject` and `payload.From` from Postmark webhook
- `callAI()` constructs user message with metadata section, then CV content

### Scoring Service Wired
- Replace mock hardcoded return with real OpenRouter call
- Use same pattern as extraction: `google/gemini-2.0-flash:free` primary, paid fallback
- New `ScoreSchema` with fields: `score` (0-100), `reasoning`, `strengths[]`, `gaps[]`
- Processor tries/catches per-job; one failed score doesn't block others

### Processor Phase 7 Enrichment
- Phase 7 no longer hardcodes nulls for `currentRole`, `yearsExperience`, `location`
- Uses extracted values: `extraction.current_role`, `extraction.years_experience`, `extraction.location`
- Scoring input passes real extracted data instead of nulls

### Dedup Service
- `insertCandidate()` signature adds optional `source?: string | null` parameter
- Processor passes `extraction.source_hint` (can be null)
- Defaults to 'direct' if not provided

### Deterministic Fallback
- Make `extractDeterministically()` public
- Extend its return type to include new fields (current_role, years_experience, location, source_hint)
- Processor checks `job.attemptsMade >= 2` (final attempt) and tries it before marking failed

## Claude's Discretion

- **Error message detail level** — how verbose to be in logs when extraction fails multiple times (not specified in PRD)
- **Rate limit backoff strategy** — PRD says "BullMQ exponential backoff handles this naturally"; no override needed, but could add custom circuit breaker if free tier becomes consistently rate-limited (future)
- **Scoring timeout** — PRD doesn't specify timeout for scoring LLM call; processor should inherit existing timeout from BullMQ config (likely 30s)
- **Hebrew CV test strategy** — PRD says "test with real Hebrew CVs"; implementation should note in PR comments that manual testing was done, or add to test suite

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Prisma Schema & Type Definitions
- `prisma/schema.prisma` — `Candidate` model already has all fields (`currentRole`, `yearsExperience`, `location`); no schema changes needed
- `src/candidates/candidates.types.ts` — defines `CandidateExtract` (to be extended with new fields)

### Existing Services (No Rewrites)
- `src/webhooks/webhooks.service.ts` — enqueue() logic works; no changes
- `src/webhooks/webhooks.controller.ts` — Postmark webhook receiver; no changes
- `src/ingestion/services/spam-filter.service.ts` — keyword heuristic; no changes
- `src/ingestion/services/attachment-extractor.service.ts` — PDF/DOCX text extraction; no changes
- `src/storage/storage.service.ts` — R2 upload; no changes
- `src/dedup/dedup.service.ts` — fuzzy matching core logic correct; only signature change

### Files to Modify (8 Tasks)
1. `src/ingestion/services/extraction-agent.service.ts` — schema, prompt, error handling, signature
2. `src/ingestion/ingestion.processor.ts` — pass metadata, use extracted fields, deterministic fallback
3. `src/dedup/dedup.service.ts` — add source parameter
4. `src/scoring/scoring.service.ts` — replace mock with real OpenRouter call

### Postmark Webhook Format
- Payload includes `Subject`, `From`, `MessageID`, `MailboxHash`, body, attachments
- Processor already receives this as `payload`; no integration changes needed

</canonical_refs>

<specifics>
## Specific Ideas & Constraints

### OpenRouter Budget
- Free tier: `google/gemini-2.0-flash:free` with rate limits (~15 RPM typical)
- Paid fallback: `google/gemini-2.0-flash` (~$0.10/1M input tokens, ~$0.40/1M output)
- Per-candidate cost (extraction + scoring vs 5 jobs): ~$0.0024 on paid tier
- $5 budget covers ~2,000 full pipelines

### Extraction Prompt Example Output
```json
{
  "full_name": "Dana Cohen",
  "email": "dana.cohen@gmail.com",
  "phone": "+972-52-1234567",
  "current_role": "Senior Backend Developer",
  "years_experience": 6,
  "location": "Tel Aviv, Israel",
  "skills": ["node.js", "typescript", "postgresql", "docker", "aws", "system design"],
  "ai_summary": "Senior Backend Developer with 6 years of experience in server-side development. Specializes in Node.js and cloud infrastructure with a track record of leading microservices migrations.",
  "source_hint": "direct"
}
```

### Scoring Prompt Example Output
```json
{
  "score": 85,
  "reasoning": "Strong match. Candidate has 6 years backend experience with Node.js/TypeScript — both key requirements. Missing advanced system design experience.",
  "strengths": ["Node.js/TypeScript expertise", "PostgreSQL + AWS infrastructure", "6+ years relevant experience"],
  "gaps": ["No mention of microservices experience", "System design portfolio not detailed"]
}
```

### Testing Checklist (Acceptance Criteria)
- Extraction throws on API error (BullMQ retries)
- Extraction returns all new fields when LLM valid
- Extraction throws on malformed JSON (BullMQ retries)
- Deterministic fallback has new field types
- CandidateExtractSchema validates all types correctly
- DedupService uses provided source param
- ScoringAgentService returns real scores (not hardcoded 72)
- E2E: POST Postmark webhook with PDF → candidate row fully populated (all fields)
- E2E: Retry test — mock OpenRouter fail 2x, succeed 3x → candidate created
- E2E: Final failure test — mock OpenRouter fail 3x → deterministic fallback runs

</specifics>

<deferred>
## Deferred Ideas

- **Job matching from email content** — Phase 2; currently scores against all active jobs
- **Manual CV upload extraction** — Phase 2; `candidates.service.ts` accepts manual input but extraction not wired
- **Auth / multi-user** — Phase 2; single tenant, no auth in Phase 1
- **Screening questions** — schema exists in Prisma; extraction not wired
- **Webhook for scoring completion** — Phase 2; no notification to UI when scoring finishes
- **Model upgrade** — Gemini Flash is sufficient; config-only change if upgrading to Claude Haiku or other model
- **ScoringModule DI** — if `ScoringModule` doesn't import `ConfigModule`, add it for `ConfigService` injection

</deferred>

---

*Phase: 14-wire-openrouter-extraction-pipeline-email-llm-dedup-scoring-ui*
*Context gathered: 2026-03-29 via PRD Express Path*
