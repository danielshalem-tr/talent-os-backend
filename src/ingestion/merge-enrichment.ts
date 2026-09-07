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
  /**
   * The text extracted from that document alone (no email body). When the existing CV already
   * contains it verbatim, the applicant re-sent the SAME document: nothing is replaced and the
   * caller's "CV changed" check stays false, so the persisted score is reused.
   */
  documentText?: string;
}

export function mergeEnrichment(
  existing: EnrichmentFields,
  incoming: EnrichmentFields,
  opts: MergeOptions = { cvFromDocument: true },
): EnrichmentFields {
  const jobChanged = incoming.jobId !== null && incoming.jobId !== existing.jobId;

  const hasIncomingCv = incoming.cvText.trim().length > 0;
  const hasExistingCv = existing.cvText.trim().length > 0;
  const documentText = opts.documentText?.trim() ?? '';
  const sameDocument = opts.cvFromDocument && documentText.length > 0 && existing.cvText.includes(documentText);
  const newDocument = opts.cvFromDocument && !sameDocument;

  // The CV text + file PAIR moves together, and only for a NEW real document. Any non-blank
  // incoming text used to win, so "attaching my CV again" with nothing attached replaced a rich
  // CV with a two-line note while the old PDF stayed — text, file, readability badge and score
  // then described three different things. The same PDF with a different covering note is not
  // a new CV either (cv_text embeds the body, so a plain text compare re-scored every re-send).
  // Body-only text still fills an EMPTY slot.
  const replaceCv = hasIncomingCv && (newDocument || !hasExistingCv);

  // Profile fields (role, years, location, skills, summary) are extracted from body + document
  // together. Without a new document the body dominates, and a follow-up "interested in the
  // Backend Engineer role" rewrote a CV-derived "Senior Full Stack Developer". So once a
  // candidate has CV-derived data, a submission with no new document only fills empty fields.
  const protectProfile = hasExistingCv && !newDocument;
  const pick = <T>(incomingValue: T | null, existingValue: T | null): T | null =>
    protectProfile ? (existingValue ?? incomingValue) : (incomingValue ?? existingValue);

  return {
    jobId: incoming.jobId ?? existing.jobId,
    hiringStageId: jobChanged ? incoming.hiringStageId : existing.hiringStageId,
    currentRole: pick(incoming.currentRole, existing.currentRole),
    yearsExperience: pick(incoming.yearsExperience, existing.yearsExperience),
    location: pick(incoming.location, existing.location),
    skills: protectProfile
      ? existing.skills.length > 0
        ? existing.skills
        : incoming.skills
      : incoming.skills.length > 0
        ? incoming.skills
        : existing.skills,
    cvText: replaceCv ? incoming.cvText : existing.cvText,
    cvFileUrl: replaceCv ? (incoming.cvFileUrl ?? existing.cvFileUrl) : (existing.cvFileUrl ?? incoming.cvFileUrl),
    aiSummary: pick(incoming.aiSummary, existing.aiSummary),
  };
}
