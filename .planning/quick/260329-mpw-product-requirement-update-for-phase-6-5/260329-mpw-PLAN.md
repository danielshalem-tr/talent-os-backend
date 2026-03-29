---
phase: quick-260329-mpw
plan: 1
type: execute
wave: 1
depends_on: []
files_modified:
  - src/modules/scoring/job-title-matcher.service.ts
  - src/modules/scoring/scoring.module.ts
  - src/modules/scoring/scoring_agent.service.ts
  - src/modules/scoring/scoring_agent.service.spec.ts
  - prisma/schema.prisma
autonomous: true
requirements: []
user_setup: []
---

<objective>
Replace Levenshtein character-based job title matching with semantic matching for tech industry context. Eliminate false negatives like "Software Developer" vs "Senior Software Engineer" (0.46 → 1.0) while maintaining cost efficiency and performance.

Purpose: Current pg_trgm % operator scores "Software Developer" vs "Senior Software Engineer" at 0.46, below the 0.7 threshold, causing valid candidate-job matches to fail. Semantic matching understands title variations within the tech domain.

Output: JobTitleMatcherService integrated into ScoringAgentService, schema extended with match_confidence column, tests passing.
</objective>

<execution_context>
@/Users/danielshalem/triolla/telent-os-backend/.claude/get-shit-done/workflows/execute-plan.md
</execution_context>

<context>
@.planning/STATE.md (Phase 6 scoring architecture established, pg_trgm baseline working)
@CLAUDE.md (Locked tech stack: Claude Haiku/Sonnet via Vercel AI SDK, PostgreSQL only)

## Phase 6 Context

From STATE.md: Phase 07 (Candidate Scoring) complete with 48 tests. ScoringAgentService exists but uses basic Sonnet call. Current flow:
- IngestionProcessor enqueues scoring job
- ScoringAgentService.scoreCandidate() fetches candidate + all jobs
- For each job: calls Claude Sonnet with candidate + job prompt
- Returns: score (0-100) + reasoning

**No job title correlation yet** — Phase 6 only scores candidate fit for jobs already matched by pg_trgm dedup logic. This quick task adds semantic matching step BEFORE scoring.

## Design Decision: Haiku vs Sonnet

| Model | Cost | Latency | Accuracy | Use Case |
|-------|------|---------|----------|----------|
| Haiku | ~$0.0008/1K tokens | <100ms | 95% on task-specific | Job title semantic classification (domain-specific, narrow) |
| Sonnet | ~$0.003/1K tokens | ~150ms | 99% on complex reasoning | Candidate fit scoring (multi-factor reasoning needed) |

**Decision:** Use Haiku for job title matching (3.75x cheaper, fast enough, accurate for tech job classification). Sonnet remains for full candidate-job fit scoring.

Cost impact: +~$0.15–0.30/month at 100 CVs/month (assuming 10 jobs per CV, 2K tokens per match = 2M tokens/month).

## Wiring

1. Schema: Add `match_confidence` to `candidate_job_scores` (null if no semantic match, 0-1 if matched)
2. JobTitleMatcherService: Semantic matching via Claude Haiku
3. ScoringAgentService: Before calling Sonnet, check JobTitleMatcherService
4. Fallback: If no semantic match, skip Sonnet call, log unmatched pair for recruiter review
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Create JobTitleMatcherService with semantic matching via Claude Haiku</name>
  <files>src/modules/scoring/job-title-matcher.service.ts, src/modules/scoring/job-title-matcher.service.spec.ts</files>
  <behavior>
    - Test 1: "Software Developer" + "Senior Software Engineer" → {matched: true, confidence: 0.92}
    - Test 2: "Frontend Engineer" + "Senior Frontend Engineer" → {matched: true, confidence: 0.95}
    - Test 3: "Data Analyst" + "Software Developer" → {matched: false, confidence: 0.15}
    - Test 4: "Product Manager" + "DevOps Engineer" → {matched: false, confidence: 0.05}
    - Test 5: Network error → {matched: false, confidence: 0, error: "Service unavailable"} (graceful fallback)
    - Test 6: Empty or null input → {matched: false, confidence: 0} (safe for pipeline)
  </behavior>
  <action>
Create `JobTitleMatcherService` in `src/modules/scoring/job-title-matcher.service.ts`:

**Interface:**
```typescript
export interface JobTitleMatchResult {
  matched: boolean;
  confidence: number; // 0-1, null if error
  reasoning?: string;
  error?: string;
}

export class JobTitleMatcherService {
  async matchJobTitles(
    candidateJobTitle: string,
    positionJobTitle: string,
    tenantId: string
  ): Promise<JobTitleMatchResult>
}
```

**Implementation:**
- Use `@ai-sdk/anthropic` with `generateObject()` (not `generateText()` — ensures structured output)
- Model: `claude-3-5-haiku-20241022` (fastest, cheapest)
- Prompt: "Given two job titles, determine if they refer to the same role in tech industry. Consider seniority levels, specializations, and common variations."
- Schema: `{ matched: boolean, confidence: 0-100, reasoning: string }`
- Return: Convert schema confidence to 0-1 decimal, map to JobTitleMatchResult
- Error handling: Catch API errors, log, return `{matched: false, confidence: 0, error: message}`
- Caching: NO in-memory cache yet (keep simple for Phase 6.5). Redis caching (Phase 8+) can be added later.

**Per CLAUDE.md constraints:**
- Use Vercel AI SDK (already integrated)
- No vector embeddings or external services
- Graceful fallback (never block scoring pipeline)
  </action>
  <verify>
    <automated>npm test -- --filter=job-title-matcher.service</automated>
  </verify>
  <done>
Service created, all 6 tests passing, matches existing style (NestJS patterns from ScoringAgentService). Type exports ready for ScoringModule import.
  </done>
</task>

<task type="auto">
  <name>Task 2: Wire JobTitleMatcherService into ScoringAgentService, add match_confidence to schema</name>
  <files>src/modules/scoring/scoring_agent.service.ts, src/modules/scoring/scoring_agent.service.spec.ts, prisma/schema.prisma</files>
  <action>
**Step 1: Update schema**
- Add `match_confidence DECIMAL(3,2)?` to `candidate_job_scores` table (nullable: semantic match may fail gracefully)
- Add migration comment: "Phase 6.5: Track semantic job title match confidence"
- Run `prisma migrate dev --name add_match_confidence`

**Step 2: Inject JobTitleMatcherService into ScoringAgentService**
- Constructor: `constructor(private readonly jobTitleMatcher: JobTitleMatcherService, ...)`
- Add to ScoringModule providers (Task 3 imports JobTitleMatcherService)

**Step 3: Update ScoringAgentService.scoreCandidate()**
Logic:
```
for each openJob:
  // NEW: Check semantic job title match first
  const titleMatch = await this.jobTitleMatcher.matchJobTitles(
    candidate.job_title,
    openJob.title,
    candidate.tenant_id
  )

  if (!titleMatch.matched) {
    // Log unmatched pair, skip scoring, continue next job
    logger.debug(`Job title mismatch: ${candidate.job_title} vs ${openJob.title}`)
    continue // Skip Sonnet call entirely
  }

  // EXISTING: Score candidate fit for job (unchanged)
  const score = await this.callAI(candidate, openJob, ...)

  // NEW: Store match_confidence along with score
  await prisma.candidate_job_scores.create({
    ...existing fields...,
    match_confidence: titleMatch.confidence // 0-1 decimal
  })
```

**Step 4: Update tests**
- Add 2 new integration tests:
  - "scoreCandidate skips jobs on semantic mismatch" → verify no Sonnet call made
  - "scoreCandidate saves match_confidence" → verify DB has confidence value
- Existing tests still pass (mocking JobTitleMatcherService to return matched: true)

**Per CLAUDE.md:**
- No changes to scoring logic itself (Sonnet prompt unchanged)
- Pure additive: new column, new service call, existing functionality untouched
- Backwards compatible: match_confidence null for old records (if needed for rollback)
  </action>
  <verify>
    <automated>npm test -- --filter=scoring_agent.service && npm test -- --filter=scoring_agent.service.spec</automated>
  </verify>
  <done>
ScoringAgentService updated, all existing + 2 new tests passing. Schema migration applied. match_confidence column present in candidate_job_scores.
  </done>
</task>

<task type="auto">
  <name>Task 3: Add JobTitleMatcherService to ScoringModule providers and verify integration</name>
  <files>src/modules/scoring/scoring.module.ts</files>
  <action>
Update `src/modules/scoring/scoring.module.ts`:
```typescript
import { JobTitleMatcherService } from './job-title-matcher.service';

@Module({
  ...existing,
  providers: [
    ScoringAgentService,
    JobTitleMatcherService, // NEW
  ],
  exports: [ScoringAgentService], // No change — internal service
})
export class ScoringModule {}
```

**Step 2: Verify full scoring pipeline still works**
- Run full integration test suite: `npm test`
- Expect: All Phase 7 tests + new Phase 6.5 tests passing
- No breaking changes to existing endpoints

**Fallback behavior (already in Task 2 logic):**
- If JobTitleMatcherService times out → return {matched: false, confidence: 0}
- ScoringAgentService logs and continues to next job
- Candidate is NOT marked as "unmatched" globally — just this job pair skipped
- Recruiter can review candidate + open jobs in UI and manually score if desired
  </action>
  <verify>
    <automated>npm test 2>&1 | tail -20</automated>
  </verify>
  <done>
All tests passing (Phase 1 baseline + Phase 6.5 additions). Full integration confirmed. Ready to test with real CVs.
  </done>
</task>

</tasks>

<verification>
1. Unit tests (Task 1): 6 semantic matching tests passing
2. Integration tests (Task 2): Scoring flow respects semantic matches, saves confidence
3. Full suite (Task 3): No regressions, Phase 6 scoring still works for matched jobs
4. Schema: `candidate_job_scores.match_confidence` column exists (nullable)
5. Fallback: Network errors handled gracefully, pipeline continues

**Manual test (after execution):**
- Seed 1 candidate with "Software Developer" title
- Seed 1 job with "Senior Software Engineer" title
- Run scoring job
- Verify: Candidate-job pair created with match_confidence > 0.85 (not skipped)
- In postgres: `SELECT candidate_id, job_id, match_confidence, score FROM candidate_job_scores;`
</verification>

<success_criteria>
- [ ] JobTitleMatcherService tests all passing (6/6)
- [ ] ScoringAgentService integration tests passing (existing + 2 new)
- [ ] Full npm test suite passing (no regressions)
- [ ] Schema migration applied successfully
- [ ] "Software Developer" vs "Senior Software Engineer" → matched: true, confidence ~0.92
- [ ] "Data Analyst" vs "Software Developer" → matched: false (skipped, not scored)
- [ ] Unmatched pairs logged for recruiter review
- [ ] All code follows existing NestJS patterns (DI, service structure, tests)
</success_criteria>

<output>
After completion, commit changes:
```
git add src/modules/scoring/ prisma/
git commit -m "feat(phase-6.5): Replace Levenshtein with semantic job title matching via Claude Haiku

- Add JobTitleMatcherService: semantic matching for tech job titles using Claude Haiku
- Update candidate_job_scores schema: add match_confidence column (0-1 decimal)
- Wire into ScoringAgentService: skip scoring for semantically unmatched job pairs
- Fallback: unmatched pairs logged for recruiter review, never block pipeline
- Cost impact: +$0.15–0.30/month (Haiku cheaper than embeddings)

Resolves: 'Software Developer' vs 'Senior Software Engineer' now match at 0.92 confidence
All Phase 6-7 tests passing, full integration verified."
```

No SUMMARY.md needed for quick task — this is a Phase 6.5 tactical improvement, not a full phase.
</output>
