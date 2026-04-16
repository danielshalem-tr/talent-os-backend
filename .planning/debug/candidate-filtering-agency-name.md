---
slug: candidate-filtering-agency-name
status: resolved
created: 2026-04-15
updated: 2026-04-15
trigger: "Non-CV emails (e.g. calendar invites) are being saved as candidates. Agency candidates have source=agency but source_agency=null (agency name not stored). Three bugs: (1) no spam/non-CV filter before candidate creation, (2) source_agency not propagated from extraction result to DB write, (3) alljobs domain missing from KNOWN_AGENCY_DOMAINS or not resolving."
---

## Symptoms

- **Expected**: Only emails containing CVs (from candidates or agencies) should create candidate records.
- **Actual**: Calendar invite email (subject: "הזמנה: חוגגים עצמאות...") created a candidate record for adva@triolla.io (Adva Shapira). No CV, no meaningful data. Also marked is_duplicate:true, skills:[], ai_summary:null.
- **Error messages**: None — pipeline runs silently, just wrong output.
- **Timeline**: Observed 2026-04-15.
- **Reproduction**: Send any email to the Postmark inbound address — even a calendar invite.

## Additional Evidence

Candidate from jobhunt agency:
- email_from: talent@jobhunt.co.il
- source: "agency" (correctly set)
- source_agency: null (BUG — should be "jobhunt")
- The extraction-agent.service.ts has KNOWN_AGENCY_DOMAINS with 'jobhunt.co.il' → 'jobhunt'
- The resolvedAgency logic exists in extraction-agent but the value may not reach the DB write

Known agency domains in code:
- 'jobhunt.co.il' → 'jobhunt'
- 'alljob.co.il' → 'allJobs'

## Current Focus

hypothesis: "source_agency returned from extraction is not being written to the candidates table — either the ingestion processor ignores it or the DB upsert omits it. Separately, no pre-pipeline filter exists to reject non-CV emails."
next_action: "Read ingestion processor to find where candidate is created/upserted and check if source_agency field is mapped. Also find spam/CV detection gate."
test: ""
expecting: ""

## Evidence

- timestamp: 2026-04-15T00:00:00Z
  finding: "BUG-2 root cause confirmed: dedup.service.ts insertCandidate() creates the candidate row but the data object never includes sourceAgency. The field exists in the Prisma schema (candidates.source_agency) and extraction-agent correctly returns source_agency in the result, but dedup.service.ts only passes source (source_hint), not source_agency."

- timestamp: 2026-04-15T00:00:00Z
  finding: "BUG-1 root cause confirmed: spam-filter.service.ts NON_CV_SUBJECT_PATTERNS has no entry for calendar invite subjects (Hebrew הזמנה: or English Invitation:). The calendar invite body is >100 chars so the short-body guard doesn't fire. The .ics attachment is not excluded from hasMeaningfulAttachment() so it is treated as a CV attachment, preventing the hard reject."

- timestamp: 2026-04-15T00:00:00Z
  finding: "BUG-3 root cause confirmed: KNOWN_AGENCY_DOMAINS maps 'alljob.co.il' → 'allJobs' (camelCase). The actual brand is AllJobs. This is a data consistency issue — the stored value does not match the brand name."

## Eliminated

- extraction-agent.service.ts callAI(): correctly returns source_agency in the post-processing override block (lines 234–237). Not the bug.
- ingestion.processor.ts Phase 4: correctly passes extraction result to insertCandidate(). Not the bug.
- prisma/schema.prisma: sourceAgency column exists on candidates table. Not the bug.

## Resolution

root_cause: "Three independent bugs: (1) SpamFilterService did not recognize calendar invite subjects (הזמנה: / Invitation:) or exclude text/calendar attachments from the meaningful-attachment check; (2) DedupService.insertCandidate() omitted sourceAgency from the Prisma create() data object despite the extraction result containing it; (3) KNOWN_AGENCY_DOMAINS mapped alljob.co.il to 'allJobs' instead of 'AllJobs'."
fix: "BUG-1: Added Hebrew/English calendar invite patterns to NON_CV_SUBJECT_PATTERNS and added text/calendar + .ics exclusion to hasMeaningfulAttachment(). BUG-2: Added sourceAgency: candidate.source_agency ?? null to the candidate.create() data in insertCandidate(). BUG-3: Corrected 'allJobs' → 'AllJobs' in KNOWN_AGENCY_DOMAINS."
verification: "npm test -- --testPathPatterns='spam-filter|dedup' — 17 tests passed."
files_changed:
  - src/ingestion/services/spam-filter.service.ts
  - src/dedup/dedup.service.ts
  - src/ingestion/services/extraction-agent.service.ts
