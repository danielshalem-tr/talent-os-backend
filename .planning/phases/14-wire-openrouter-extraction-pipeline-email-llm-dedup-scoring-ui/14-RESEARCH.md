# Phase 14: Wire OpenRouter Extraction Pipeline — Research

**Researched:** 2026-03-29
**Domain:** LLM integration, error handling, schema extension, BullMQ retry logic
**Confidence:** HIGH

## Summary

Phase 14 wires the OpenRouter extraction and scoring pipelines end-to-end. The code is largely in place but broken in critical ways: error handling swallows extraction failures (preventing retries), the schema is incomplete (missing `currentRole`, `yearsExperience`, `location`, `source_hint`), the scoring mock is hardcoded, and the deterministic fallback is dead code.

The phase requires modifications to 4 files with mostly localized changes (schema extension, method signature updates, error handling fixes, prompt rewriting). All infrastructure (BullMQ, Prisma, @openrouter/sdk) is already in place and functional.

**Primary recommendation:** Implement in order: schema extension → prompt rewrite → extraction error handling fix → processor coordination → DedupService source parameter → scoring service wire-up → deterministic fallback. Tests should verify error propagation (not swallowing), all new fields extraction, and real LLM behavior (not mocked scores).

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **Error Handling:** Remove try/catch in `ExtractionAgentService.extract()` — let errors propagate to processor, which retries via BullMQ
- **LLM Schema Extension:** Add `current_role`, `years_experience`, `location`, `source_hint` fields to `CandidateExtractSchema`
- **Scoring Model:** Use OpenRouter (`google/gemini-2.0-flash:free`), not Anthropic Claude Sonnet — matches $5 budget constraint
- **Deterministic Fallback:** Make `extractDeterministically()` public and use on final BullMQ attempt (3/3) if AI fails
- **Processor Metadata:** Pass Postmark `Subject` and `From` to extraction method for source detection signals
- **Phase 7 Enrichment:** Use extracted values instead of hardcoded nulls for `currentRole`, `yearsExperience`, `location`

### Claude's Discretion
- **Error message detail level:** How verbose logs should be on extraction failure (not specified)
- **Rate limit backoff strategy:** BullMQ exponential backoff is sufficient; no custom circuit breaker needed
- **Scoring timeout:** Processor inherits existing 30s BullMQ timeout (not configurable per-phase)
- **Hebrew CV test strategy:** Manual testing noted in PR; no automated Hebrew language tests required

### Deferred Ideas (OUT OF SCOPE)
- Job matching from email content (Phase 2+)
- Manual CV upload extraction (Phase 2+)
- Auth and multi-user (Phase 2+)
- Screening question extraction (Phase 2+)
- Webhook for scoring completion notification (Phase 2+)
- Model upgrade (config-only change if needed)
</user_constraints>

---

## Standard Stack

### Core LLM & Extraction
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| @openrouter/sdk | 0.9.11 | OpenRouter API client for LLM calls | Free tier primary, enterprise fallback; cost-effective for Phase 1 |
| google/gemini-2.0-flash | free/paid | LLM for extraction and scoring | Low cost (~$0.0004/call), strong JSON output, handles Hebrew well |
| zod | 4.3.6 | Schema validation for LLM output | Type-safe parsing with `.safeParse()` for resilience |

### Supporting Infrastructure (Already in Place)
| Library | Version | Purpose | When Used |
|---------|---------|---------|-------------|
| @nestjs/bullmq | 11.0.4 | Job queue, retry logic, exponential backoff | Automatic retries on extraction/scoring errors |
| @nestjs/config | 4.0.3 | ConfigService for environment vars | OPENROUTER_API_KEY, TENANT_ID injection |
| @prisma/client | 7.0.0 | Database ORM | Atomic transactions, candidate/score persistence |
| @nestjs/testing | 11.0.1 | Jest testing utilities | Mocking OpenRouter SDK in unit tests |

### Installation Status
All required packages are already installed in `package.json`. No additional `npm install` needed.

---

## Architecture Patterns

### Current Error Handling (BROKEN)
**Location:** `src/ingestion/services/extraction-agent.service.ts:42-50`

Current pattern silently swallows errors:
```typescript
async extract(fullText: string, suspicious: boolean): Promise<CandidateExtract> {
  try {
    const extracted = await this.callAI(fullText);
    return { ...extracted, suspicious };
  } catch (err) {
    this.logger.error('OpenRouter extraction failed — returning safe fallback.', err);
    return { ...FALLBACK, suspicious };  // ← SWALLOWS ERROR, BullMQ NEVER RETRIES
  }
}
```

**Problem:** Processor's try/catch (line 102-113) never fires because error is caught here. Result: LLM failure → fallback with empty `full_name` → processor sees empty name → permanent `failed` status (no retry).

### Correct Error Handling Pattern (FIX)
Let errors propagate to processor, which orchestrates BullMQ retry:

```typescript
async extract(
  fullText: string,
  suspicious: boolean,
  metadata: { subject: string; fromEmail: string },
): Promise<CandidateExtract> {
  const extracted = await this.callAI(fullText, metadata);  // errors propagate
  return { ...extracted, suspicious };
}
```

**Flow:**
1. **Attempt 1-2:** `extract()` throws → processor's catch (line 102-113) logs and re-throws → BullMQ retries with exponential backoff (5s, 10s, 20s)
2. **Attempt 3 (final):** `extract()` throws → processor catches, checks `job.attemptsMade >= (job.opts?.attempts ?? 3) - 1` → tries `extractDeterministically()` as fallback → if still fails, marks as `failed`
3. **Recovery:** Postmark retry on 5xx finds `email_intake_log.status = pending`, re-enqueues

### OpenRouter Integration Pattern
**Location:** `src/ingestion/services/extraction-agent.service.ts:54-75`

Current implementation structure is correct; reuse for scoring:

```typescript
private async callAI(fullText: string, metadata: { subject: string; fromEmail: string }): Promise<Omit<CandidateExtract, 'suspicious'>> {
  const apiKey = this.config.get<string>('OPENROUTER_API_KEY')!;
  const client = new OpenRouter({ apiKey });

  const userMessage = [
    `--- Email Metadata ---`,
    `Subject: ${metadata.subject}`,
    `From: ${metadata.fromEmail}`,
    ``,
    `--- CV / Email Content ---`,
    fullText,
  ].join('\n');

  const result = client.callModel({
    model: 'google/gemini-2.0-flash:free',
    instructions: INSTRUCTIONS,  // REWRITE: add new fields, constraints, example
    input: userMessage,
  });

  const raw = await result.getText();
  const json = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  const parseResult = CandidateExtractSchema.safeParse(JSON.parse(json));
  if (!parseResult.success) {
    this.logger.error('LLM returned invalid JSON structure', parseResult.error.errors);
    throw new Error(`LLM output validation failed: ${parseResult.error.message}`);
  }
  return parseResult.data;
}
```

**Why `safeParse()` over `.parse()`:**
- `.parse()` throws on schema violation → caught as error → BullMQ retries (correct)
- `.safeParse()` returns `{ success: false, error: ... }` → explicit error handling → clearer intent

### Processor Coordination Pattern
**Location:** `src/ingestion/ingestion.processor.ts:98-125`

Current processor already orchestrates phases correctly. Phase 14 updates:

1. **Phase 4 extraction call** (line 101): Add metadata parameter
```typescript
extraction = await this.extractionAgent.extract(
  context.fullText,
  context.suspicious,
  { subject: payload.Subject ?? '', fromEmail: payload.From },  // NEW
);
```

2. **Phase 4 error handler** (line 102-113): Add deterministic fallback on final attempt
```typescript
} catch (err) {
  if (job.attemptsMade >= (job.opts?.attempts ?? 3) - 1) {
    // Final attempt — try deterministic fallback
    try {
      const deterministicResult = this.extractionAgent.extractDeterministically(context.fullText);
      extraction = { ...deterministicResult, suspicious: context.suspicious, source_hint: null };
      // Don't throw — continue with partial data
    } catch (fallbackErr) {
      // Even fallback failed — mark as failed
      await this.prisma.emailIntakeLog.update({ ... });
      throw fallbackErr;  // Mark as failed, don't retry
    }
  } else {
    // Attempts 1-2 — re-throw for BullMQ retry
    await this.prisma.emailIntakeLog.update({ ... });
    throw err;
  }
}
```

3. **Phase 7 enrichment** (line 164-175): Use extracted values instead of nulls
```typescript
await this.prisma.candidate.update({
  where: { id: context.candidateId },
  data: {
    currentRole: extraction.current_role ?? null,        // WAS: null
    yearsExperience: extraction.years_experience ?? null,  // WAS: null
    location: extraction.location ?? null,                 // NEW
    skills: extraction.skills ?? [],
    // ... rest unchanged
  },
});
```

4. **Phase 7 scoring input** (line 204-216): Use extracted fields
```typescript
scoreResult = await this.scoringService.score({
  cvText: context.cvText,
  candidateFields: {
    currentRole: extraction.current_role ?? null,        // WAS: null
    yearsExperience: extraction.years_experience ?? null,  // WAS: null
    skills: extraction.skills ?? [],
  },
  // ... rest unchanged
});
```

5. **Phase 6 dedup** (line 144, 148): Pass source_hint
```typescript
candidateId = await this.dedupService.insertCandidate(
  extraction,
  tenantId,
  payload.From,
  tx,
  extraction.source_hint,  // NEW parameter
);
```

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| JSON validation on LLM output | Custom regex/parsing | Zod `.safeParse()` | Zod handles type coercion, field validation, nested objects; regex is fragile and unmaintainable |
| Retry logic with exponential backoff | Custom setTimeout loop | BullMQ + NestJS decorator | BullMQ handles lock renewal, stalling, concurrency, persistence to Redis; custom logic is a rewrite nightmare |
| LLM provider switching | Provider-specific SDK each time | OpenRouter SDK abstraction | OpenRouter unified interface for Gemini, Claude, etc.; switching is a model string change |
| Email metadata extraction signals | Regex patterns for source detection | LLM prompt + example | LLM can understand context ("presenting candidate for X role" → agency); regex has too many edge cases |
| Transactional consistency | Multiple separate DB writes | Prisma `$transaction()` | Already used in Phase 6; atomic blocks prevent partial writes on crash |

**Key insight:** The OpenRouter SDK handles JSON parsing attempts, retry signaling, and API error classification. Don't parse or retry manually — let the SDK and BullMQ handle it.

---

## Runtime State Inventory

**Trigger:** This phase involves schema/extraction changes but NO data migration.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | Candidate table: `currentRole`, `yearsExperience`, `location` fields already exist (created in Phase 1 schema) | No migration — new extractions populate these fields going forward; existing candidates remain NULL |
| Live service config | BullMQ queue: 3 retries with 5s/10s/20s exponential backoff already configured (set in `WebhooksService.enqueue()` line 40-42) | No change — inherited by Phase 14 jobs |
| OS-registered state | None — Phase 1 is webhook-driven, no background tasks or cron jobs | None |
| Secrets/env vars | `OPENROUTER_API_KEY` already set (verified by `src/config/env.ts`); ExtractionAgentService reads it via ConfigService | No change — already working |
| Build artifacts | @openrouter/sdk 0.9.11 already installed in node_modules | No reinstall needed |

**No data migrations required for Phase 14.** Field values default to NULL; new extractions populate them. Existing candidate rows retain NULL until re-processed (unlikely in Phase 1).

---

## Common Pitfalls

### Pitfall 1: Error Swallowing in Service Layer
**What goes wrong:** Service catches error, returns fallback → processor never sees error → BullMQ never retries. Transient LLM failures become permanent.

**Why it happens:** Developer assumes "safe fallback is always better than failing" — but fallback with empty `full_name` is indistinguishable from legitimate missing data, causing silent data corruption.

**How to avoid:** Let service throw on API errors. Catch and handle retry logic at orchestrator (processor) level. Fallback only on final attempt.

**Warning signs:** Job status is `failed` but logs show no error message at processor level; only service-level error exists.

### Pitfall 2: Missing Field Constraints in Prompt
**What goes wrong:** LLM returns `years_experience: "5-7 years"` (string) → schema expects integer → Zod throws → job retries 3x → deterministic fallback → partial candidate data.

**Why it happens:** Prompt doesn't specify format ("as a single integer"). LLM makes reasonable but wrong guesses.

**How to avoid:** Prompt must include constraints and examples. "Convert '5-7 years' to single integer: 6." Include example JSON output showing all fields.

**Warning signs:** Test with real Hebrew CVs; watch for type mismatches in safeParse errors.

### Pitfall 3: Processor Doesn't Check `job.attemptsMade`
**What goes wrong:** Processor always tries deterministic fallback on error → deterministic runs even on 1st attempt → wasting fallback potential + slower recovery.

**Why it happens:** Copy-pasting fallback code without checking attempt count.

**How to avoid:** Check `job.attemptsMade >= (job.opts?.attempts ?? 3) - 1` before trying fallback. Only on final attempt.

**Warning signs:** Deterministic extraction runs are logged on every failure, not just 3rd attempt.

### Pitfall 4: ScoringModule Doesn't Import ConfigModule
**What goes wrong:** `ScoringAgentService` tries to inject `ConfigService` → NestJS can't resolve it → app fails at bootstrap.

**Why it happens:** ScoringModule only provides `ScoringAgentService`; doesn't import `ConfigModule` to make `ConfigService` available.

**How to avoid:** Check `src/scoring/scoring.module.ts` — if `ConfigModule` is not imported, add it.

**Warning signs:** Startup error: "Nest can't resolve ConfigService in ScoringModule".

### Pitfall 5: Job Attempt Counter Logic Off-by-One
**What goes wrong:** Condition `if (job.attemptsMade >= 3)` runs fallback on 3rd attempt; but what if `opts.attempts` is 5?

**Why it happens:** Hardcoding magic number instead of using `job.opts?.attempts`.

**How to avoid:** Use `job.attemptsMade >= (job.opts?.attempts ?? 3) - 1` to compare against configured max, not hardcoded value.

**Warning signs:** Changing retry count in `WebhooksService.enqueue()` breaks the fallback threshold.

---

## Code Examples

### Extraction with Metadata (CORRECT)
**Source:** Phase 14 task 3, verified against PRD requirement

```typescript
// In ExtractionAgentService
async extract(
  fullText: string,
  suspicious: boolean,
  metadata: { subject: string; fromEmail: string },
): Promise<CandidateExtract> {
  const extracted = await this.callAI(fullText, metadata);
  return { ...extracted, suspicious };
}

private async callAI(
  fullText: string,
  metadata: { subject: string; fromEmail: string },
): Promise<Omit<CandidateExtract, 'suspicious'>> {
  const apiKey = this.config.get<string>('OPENROUTER_API_KEY')!;
  const client = new OpenRouter({ apiKey });

  const userMessage = [
    `--- Email Metadata ---`,
    `Subject: ${metadata.subject}`,
    `From: ${metadata.fromEmail}`,
    ``,
    `--- CV / Email Content ---`,
    fullText,
  ].join('\n');

  const result = client.callModel({
    model: 'google/gemini-2.0-flash:free',
    instructions: INSTRUCTIONS,
    input: userMessage,
  });

  const raw = await result.getText();
  const json = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  const parseResult = CandidateExtractSchema.safeParse(JSON.parse(json));
  if (!parseResult.success) {
    this.logger.error('LLM returned invalid JSON structure', parseResult.error.errors);
    throw new Error(`LLM output validation failed: ${parseResult.error.message}`);
  }
  return parseResult.data;
}
```

### Processor Deterministic Fallback (CORRECT)
**Source:** Phase 14 task 6, verified against PRD requirement

```typescript
// In IngestionProcessor.process()
let extraction: CandidateExtract;
try {
  extraction = await this.extractionAgent.extract(
    context.fullText,
    context.suspicious,
    { subject: payload.Subject ?? '', fromEmail: payload.From },
  );
} catch (err) {
  // Only try fallback on final attempt
  if (job.attemptsMade >= (job.opts?.attempts ?? 3) - 1) {
    this.logger.warn(
      `AI extraction failed on final attempt for ${payload.MessageID} — trying deterministic fallback`,
    );
    try {
      const deterministicResult = this.extractionAgent.extractDeterministically(context.fullText);
      extraction = {
        ...deterministicResult,
        suspicious: context.suspicious,
        source_hint: null,
      };
      // Don't throw — continue with partial data
    } catch (fallbackErr) {
      // Even deterministic failed — mark as failed permanently
      await this.prisma.emailIntakeLog.update({
        where: { idx_intake_message_id: { tenantId, messageId: payload.MessageID } },
        data: { processingStatus: 'failed' },
      });
      this.logger.error(`Both AI and deterministic extraction failed for ${payload.MessageID}`);
      return; // Don't retry
    }
  } else {
    // Attempts 1-2 — re-throw for BullMQ to retry
    await this.prisma.emailIntakeLog.update({
      where: { idx_intake_message_id: { tenantId, messageId: payload.MessageID } },
      data: { processingStatus: 'failed' },
    });
    throw err;
  }
}
```

### Scoring Service with OpenRouter (CORRECT)
**Source:** Phase 14 task 8, verified against PRD requirement

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenRouter } from '@openrouter/sdk';
import { z } from 'zod';

export const ScoreSchema = z.object({
  score: z.number().int().min(0).max(100),
  reasoning: z.string(),
  strengths: z.array(z.string()),
  gaps: z.array(z.string()),
});
export type ScoreResult = z.infer<typeof ScoreSchema>;

export interface ScoringInput {
  cvText: string;
  candidateFields: {
    currentRole: string | null;
    yearsExperience: number | null;
    skills: string[];
  };
  job: {
    title: string;
    description: string | null;
    requirements: string[];
  };
}

const SCORING_INSTRUCTIONS = `You are a technical recruiter evaluating candidate fit for a job opening.
Score the candidate 0-100 against the job requirements.

Return ONLY a raw JSON object — no markdown, no code fences, no explanation.
The JSON must contain exactly these keys:
- "score" (integer 0-100): Overall fit score. 0-30 = poor fit, 31-50 = weak, 51-70 = moderate, 71-85 = strong, 86-100 = exceptional.
- "reasoning" (string): 1-2 sentences explaining the score.
- "strengths" (string[]): 2-5 specific strengths relevant to this job.
- "gaps" (string[]): 0-5 specific gaps or missing requirements.

RULES:
- Base score solely on the provided information — do not assume skills not mentioned.
- If the CV text is very short or uninformative, score conservatively (30-50 range).
- Be specific in strengths and gaps — reference actual skills/requirements, not generic statements.`;

@Injectable()
export class ScoringAgentService {
  private readonly logger = new Logger(ScoringAgentService.name);

  constructor(private readonly config: ConfigService) {}

  async score(input: ScoringInput): Promise<ScoreResult & { modelUsed: string }> {
    const apiKey = this.config.get<string>('OPENROUTER_API_KEY')!;
    const client = new OpenRouter({ apiKey });

    const candidateSection = [
      `Candidate:`,
      `- Current Role: ${input.candidateFields.currentRole ?? 'Unknown'}`,
      `- Years of Experience: ${input.candidateFields.yearsExperience ?? 'Unknown'}`,
      `- Skills: ${input.candidateFields.skills.length > 0 ? input.candidateFields.skills.join(', ') : 'None listed'}`,
      ``,
      `CV Text:`,
      input.cvText,
    ].join('\n');

    const jobSection = [
      `Job:`,
      `- Title: ${input.job.title}`,
      `- Description: ${input.job.description ?? 'N/A'}`,
      `- Requirements: ${input.job.requirements.length > 0 ? input.job.requirements.join(', ') : 'None specified'}`,
    ].join('\n');

    const userMessage = `${candidateSection}\n\n${jobSection}`;

    const result = client.callModel({
      model: 'google/gemini-2.0-flash:free',
      instructions: SCORING_INSTRUCTIONS,
      input: userMessage,
    });

    const raw = await result.getText();
    const json = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();

    const parseResult = ScoreSchema.safeParse(JSON.parse(json));
    if (!parseResult.success) {
      this.logger.error('Scoring LLM returned invalid JSON', parseResult.error.errors);
      throw new Error(`Scoring output validation failed: ${parseResult.error.message}`);
    }

    this.logger.log(`Scored candidate — score: ${parseResult.data.score}`);
    return { ...parseResult.data, modelUsed: 'google/gemini-2.0-flash' };
  }
}
```

### Schema with All New Fields (CORRECT)
**Source:** Phase 14 task 1, verified against PRD requirements

```typescript
export const CandidateExtractSchema = z.object({
  full_name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  current_role: z.string().nullable(),
  years_experience: z.number().int().min(0).max(50).nullable(),
  location: z.string().nullable(),
  skills: z.array(z.string()),
  ai_summary: z.string().nullable(),
  source_hint: z.enum(['linkedin', 'agency', 'referral', 'direct']).nullable(),
});

export type CandidateExtract = z.infer<typeof CandidateExtractSchema> & {
  suspicious: boolean;
};

const FALLBACK: Omit<CandidateExtract, 'suspicious'> = {
  full_name: '',
  email: null,
  phone: null,
  current_role: null,
  years_experience: null,
  location: null,
  skills: [],
  ai_summary: null,
  source_hint: null,
};
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Claude Sonnet for scoring ($15/M output) | Gemini Flash via OpenRouter (free tier) | Phase 14 | Reduces per-call cost from ~$0.001 to $0.00 (free), keeps quality high |
| Try/catch swallowing errors in service | Error propagation to orchestrator | Phase 14 | Enables BullMQ retry logic; transient failures no longer become permanent |
| Hardcoded null for extracted fields | LLM-extracted values in Phase 7 | Phase 14 | Candidate records fully populated; better scoring quality |
| No context passed to extraction | Email metadata (Subject, From) signals | Phase 14 | LLM can infer source (agency vs direct) from context |
| No fallback on final failure | Deterministic extraction as last resort | Phase 14 | Jobs don't completely fail; partial data recoverable |
| Hardcoded mock scores (72) | Real scoring per job | Phase 14 | Scores now reflect actual candidate-job fit |

**Deprecated/outdated:**
- `extract()` internal try/catch — prevent all error propagation to processor (Phase 14 removes it)
- `extractDeterministically()` as dead code — now called as fallback on final attempt (Phase 14 activates it)
- Anthropic Claude Sonnet for scoring — too expensive, Gemini Flash covers Phase 1 needs

---

## Open Questions

1. **ConfigModule Import in ScoringModule**
   - What we know: `ScoringModule` at `src/scoring/scoring.module.ts` currently does NOT import `ConfigModule`
   - What's unclear: Will test bootstrapping fail without explicit import, or is ConfigModule global scope sufficient?
   - Recommendation: Add `imports: [ConfigModule]` to ScoringModule to be explicit. Global scoping is fragile. Safe: always import where injected.
   - **Action:** Verify in PLAN → add to ScoringModule if missing.

2. **Deterministic Fallback Return Type**
   - What we know: `extractDeterministically()` at line 77-120 currently returns `Omit<CandidateExtract, 'suspicious'>`
   - What's unclear: Does it populate new fields (`current_role`, `years_experience`, `location`, `source_hint`) or leave them null?
   - Current code: Returns only old 5 fields; needs extension
   - **Action:** Extend return type and populate new fields (likely all null from deterministic pass, except skills).

3. **Email Metadata Validation**
   - What we know: `payload.Subject` and `payload.From` come from Postmark webhook
   - What's unclear: What if Subject is empty string? From is missing? LLM behavior on missing metadata?
   - Recommendation: Provide defaults: `subject ?? ''`, `fromEmail ?? 'unknown@example.com'` — LLM can handle empty strings gracefully
   - **Action:** Defaults already recommended in PRD; implement as shown.

4. **Rate Limit Handling on Free Tier**
   - What we know: OpenRouter free tier has rate limits (~15 RPM typical, varies)
   - What's unclear: How does the SDK signal rate limiting? What HTTP status? How does BullMQ retry handle 429?
   - Current info: BullMQ exponential backoff (5s, 10s, 20s) should naturally handle rate limits
   - **Action:** Monitor OpenRouter dashboard; if rate-limited, switch model to paid tier (config change only).

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Jest 30.0.0 + @nestjs/testing 11.0.1 |
| Config file | `jest` section in package.json; spec files at `src/**/*.spec.ts` |
| Quick run command | `npm test -- src/ingestion/services/extraction-agent.service.spec.ts` |
| Full suite command | `npm test` |

### Phase Requirements → Test Map

**Extraction Tests (verify error propagation, not swallowing):**
| Requirement | Behavior | Test Type | Command | File Status |
|-------------|----------|-----------|---------|-------------|
| Error propagation | `extract()` throws on API error (doesn't catch it) | unit | `npm test -- extraction-agent.service.spec.ts -t "throws on API error"` | ❌ Wave 0 |
| Schema validation | `CandidateExtractSchema` with new fields parses correctly | unit | `npm test -- extraction-agent.service.spec.ts -t "schema"` | ✅ Partial (needs new fields) |
| New fields extraction | `callAI()` returns `current_role`, `years_experience`, `location`, `source_hint` | unit | `npm test -- extraction-agent.service.spec.ts -t "new fields"` | ❌ Wave 0 |
| Malformed JSON handling | `safeParse` catches invalid LLM output, throws | unit | `npm test -- extraction-agent.service.spec.ts -t "malformed"` | ❌ Wave 0 |
| Deterministic fallback return type | `extractDeterministically()` returns all fields including new ones | unit | `npm test -- extraction-agent.service.spec.ts -t "deterministic"` | ❌ Wave 0 |

**Scoring Tests (verify real LLM call, not mock):**
| Requirement | Behavior | Test Type | Command | File Status |
|-------------|----------|-----------|---------|-------------|
| Real OpenRouter call | `score()` calls `client.callModel()` with Gemini model | unit | `npm test -- scoring.service.spec.ts -t "calls OpenRouter"` | ❌ Wave 0 |
| Score varies per job | Two jobs get different scores for same candidate | integration | `npm test -- ingestion.processor.spec.ts -t "scores vary"` | ❌ Wave 0 |
| Score schema validation | Result passes `ScoreSchema.parse()` | unit | `npm test -- scoring.service.spec.ts -t "schema"` | ✅ Exists |
| Error isolation | One job's scoring failure doesn't block others | integration | `npm test -- ingestion.processor.spec.ts -t "error isolation"` | ❌ Wave 0 |

**Processor Integration Tests (verify coordination):**
| Requirement | Behavior | Test Type | Command | File Status |
|-------------|----------|-----------|---------|-------------|
| Metadata passed to extract | Processor calls `extract(fullText, suspicious, metadata)` | integration | `npm test -- ingestion.processor.spec.ts -t "metadata passed"` | ❌ Wave 0 |
| Phase 7 uses extracted fields | Candidate table gets `current_role`, `years_experience`, `location` from extraction | integration | `npm test -- ingestion.processor.spec.ts -t "enrichment fields"` | ❌ Wave 0 |
| Deterministic fallback on final attempt | Job 3/3 fails → deterministic runs → partial candidate created | integration | `npm test -- ingestion.processor.spec.ts -t "fallback final"` | ❌ Wave 0 |
| Source hint flows to dedup | `DedupService.insertCandidate()` receives source_hint parameter | integration | `npm test -- dedup.service.spec.ts -t "source param"` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npm test -- src/ingestion/services/extraction-agent.service.spec.ts` (extraction tests only, fast)
- **Per wave merge:** `npm test` (full suite, ~60s)
- **Phase gate:** Full suite green + integration test for full pipeline (webhook → candidate table with all fields)

### Wave 0 Gaps
- [ ] `src/ingestion/services/extraction-agent.service.spec.ts` — add 4 new tests for error propagation, new fields, malformed JSON, deterministic fallback
- [ ] `src/scoring/scoring.service.spec.ts` — add 2 new tests for OpenRouter call verification, mock removal
- [ ] `src/ingestion/ingestion.processor.spec.ts` — add 5 integration tests for metadata passing, enrichment, fallback, error isolation
- [ ] `src/dedup/dedup.service.spec.ts` — add 1 test for source parameter handling
- [ ] Framework install: All Jest + NestJS testing libs already installed (verified in package.json)

---

## Environment Availability

**Skip:** Phase 14 is code/config changes only. External dependencies already verified:
- `OPENROUTER_API_KEY`: Environment variable (can be set in `.env` or CI)
- OpenRouter free tier: Verified accessible (test with real call during manual checkpoint)
- PostgreSQL + Redis: Infrastructure for BullMQ (already running in docker-compose.dev.yml)

No missing dependencies. If free tier is rate-limited during testing, switch to paid by changing model string to `google/gemini-2.0-flash` (not `:free`).

---

## Sources

### Primary (HIGH confidence)
- **CONTEXT.md (Phase 14 context)**: Locked decisions on error handling, schema extension, metadata passing, deterministic fallback
- **PRD-extraction-pipeline-v2.md**: 8 concrete tasks, code examples, acceptance criteria, testing checklist — highly specific
- **Codebase examination**:
  - `src/ingestion/services/extraction-agent.service.ts` (current implementation, lines 42-75)
  - `src/ingestion/ingestion.processor.ts` (orchestration, lines 98-251)
  - `src/scoring/scoring.service.ts` (mock state, lines 34-52)
  - `src/dedup/dedup.service.ts` (current signature, lines 68-90)
  - `package.json` (confirmed @openrouter/sdk 0.9.11 installed)
  - `src/webhooks/webhooks.service.ts` (BullMQ retry config, lines 40-42)

### Secondary (MEDIUM confidence)
- BullMQ job attempt tracking: Verified in NestJS BullMQ docs; `job.attemptsMade` is standard property exposed by WorkerHost
- OpenRouter SDK patterns: Examined existing `callAI()` implementation; same pattern reused for scoring
- Zod `.safeParse()` resilience: Current extraction tests show pattern; extending to scoring is straightforward
- ConfigService injection: Examined other modules (IngestionModule, WorkerModule) — ConfigModule globally available but not imported in ScoringModule (gap identified)

### Tertiary (LOW confidence — flagged for validation)
- Hebrew CV handling: PRD states "Gemini Flash handles Hebrew well"; no test coverage in codebase yet. **Action:** Manual test with real Hebrew CV during checkpoint.
- Deterministic fallback quality: Existing implementation (lines 77-120) is keyword-matching only. **Action:** Verify acceptability during integration test phase.

---

## Metadata

**Confidence breakdown:**
- **Standard Stack:** HIGH — All libraries installed, versions current, @openrouter/sdk already proven working
- **Architecture:** HIGH — Error handling pattern is standard NestJS + BullMQ; processor already orchestrates phases correctly; only modifications are localized
- **Error Handling:** HIGH — BullMQ job attempt tracking is standard; `attemptsMade` property confirmed in framework
- **Pitfalls:** HIGH — Common in distributed job systems; pattern validation from existing code (WebhooksService retry config)
- **Testing:** MEDIUM — Jest infrastructure in place; mock patterns exist; new tests required are straightforward but not yet written

**Research date:** 2026-03-29
**Valid until:** 2026-04-05 (stable tech stack, no fast-moving dependencies)

---

*End RESEARCH.md*
