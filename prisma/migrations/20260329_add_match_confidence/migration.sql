-- Phase 6.5: Add match_confidence column to track semantic job title match confidence
ALTER TABLE "candidate_job_scores" ADD COLUMN "match_confidence" numeric(3,2);
