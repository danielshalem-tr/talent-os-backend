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
 * against a new one.
 */
export function mergeEnrichment(existing: EnrichmentFields, incoming: EnrichmentFields): EnrichmentFields {
  return {
    jobId: incoming.jobId ?? existing.jobId,
    hiringStageId: incoming.jobId ? incoming.hiringStageId : existing.hiringStageId,
    currentRole: incoming.currentRole ?? existing.currentRole,
    yearsExperience: incoming.yearsExperience ?? existing.yearsExperience,
    location: incoming.location ?? existing.location,
    skills: incoming.skills.length > 0 ? incoming.skills : existing.skills,
    cvText: incoming.cvText.trim().length > 0 ? incoming.cvText : existing.cvText,
    cvFileUrl: incoming.cvFileUrl ?? existing.cvFileUrl,
    aiSummary: incoming.aiSummary ?? existing.aiSummary,
  };
}
