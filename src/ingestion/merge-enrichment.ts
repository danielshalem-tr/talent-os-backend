export interface EnrichmentFields {
  jobId: string | null;
  hiringStageId: string | null;
  currentRole: string | null;
  yearsExperience: number | null;
  location: string | null;
  skills: string[];
  cvText: string;
  cvFileUrl: string | null;
  aiSummary: string | null;
}

/**
 * Phase 7 re-runs for every email from the same person, including thin follow-ups
 * ("attaching my CV again") that extract almost nothing. Writing the incoming values
 * verbatim let such a follow-up blank a good location, wipe the skill tags, and — worst
 * of all — null out `job_id`, silently detaching a candidate from their pipeline.
 *
 * COALESCE semantics: an incoming value wins only when it actually carries something.
 * The stage rides with the job, since a stage from the previous job is meaningless
 * against a new one — but ONLY when the job actually changes. Matching the SAME job
 * again (the common case: "attaching my CV again", re: the same ad) must never drag a
 * candidate the recruiter already advanced back to the first stage. This mirrors the
 * guard the bulk-assign path makes explicit in assign-candidate.ts.
 */
export interface MergeOptions {
  /** True when THIS submission carried a readable CV document (attachment text was extracted). */
  cvFromDocument: boolean;
}

export function mergeEnrichment(
  existing: EnrichmentFields,
  incoming: EnrichmentFields,
  opts: MergeOptions = { cvFromDocument: true },
): EnrichmentFields {
  const jobChanged = incoming.jobId !== null && incoming.jobId !== existing.jobId;

  // The CV text + file PAIR moves together, and only for a real document. Any non-blank incoming
  // text used to win, so "attaching my CV again" with nothing attached replaced a rich CV with a
  // two-line note while the old PDF stayed — text, file, readability badge and score then
  // described three different things. Body-only text still fills an EMPTY slot.
  const hasIncomingCv = incoming.cvText.trim().length > 0;
  const hasExistingCv = existing.cvText.trim().length > 0;
  const replaceCv = hasIncomingCv && (opts.cvFromDocument || !hasExistingCv);

  return {
    jobId: incoming.jobId ?? existing.jobId,
    hiringStageId: jobChanged ? incoming.hiringStageId : existing.hiringStageId,
    currentRole: incoming.currentRole ?? existing.currentRole,
    yearsExperience: incoming.yearsExperience ?? existing.yearsExperience,
    location: incoming.location ?? existing.location,
    skills: incoming.skills.length > 0 ? incoming.skills : existing.skills,
    cvText: replaceCv ? incoming.cvText : existing.cvText,
    cvFileUrl: replaceCv ? (incoming.cvFileUrl ?? existing.cvFileUrl) : (existing.cvFileUrl ?? incoming.cvFileUrl),
    aiSummary: incoming.aiSummary ?? existing.aiSummary,
  };
}
