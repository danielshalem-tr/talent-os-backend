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
}
