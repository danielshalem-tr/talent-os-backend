/**
 * DTO for GET /api/candidates response
 * Includes hiring stage and job info for Kanban board and Talent Pool table
 */
export interface CandidateResponse {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  current_role: string | null;
  location: string | null;
  cv_file_url: string | null;
  source: string;
  source_agency: string | null;
  created_at: Date;
  ai_score: number | null;
  cv_readable: boolean;
  is_score_overridden: boolean;
  ai_summary: string | null;
  is_duplicate: boolean;
  skills: string[];

  // Kanban board stage tracking
  job_id: string | null;
  hiring_stage_id: string | null;
  hiring_stage_name: string | null;

  // Job info for Talent Pool table
  job_title: string | null;

  // New Profile data trackings
  status: string;
  is_rejected: boolean;
  rejection_reason: string | null;
  rejection_note: string | null;
  stage_summaries: Record<string, string>;
  years_experience: number | null;
  salary_expectation_min: number | null;
  salary_expectation_max: number | null;

  // Headline state of the most recent voice screening call (single-candidate reads only;
  // the list endpoint returns null — full history comes from GET /candidates/:id/calls).
  latest_call: {
    id: string;
    status: string;
    attempt: number;
    scheduled_for: string | null;
    summary: string | null;
  } | null;
}

/**
 * Derived CV read-status (TO-55). True only when extracted CV text exists and is
 * not blank. `cv_text` itself is never serialized — this boolean is shipped instead.
 */
export function computeCvReadable(cvText: string | null): boolean {
  return cvText != null && cvText.trim() !== '';
}
