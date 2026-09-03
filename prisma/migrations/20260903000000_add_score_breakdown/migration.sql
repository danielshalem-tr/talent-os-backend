-- Scoring v2: full per-requirement evaluation + policy trace behind each score.
ALTER TABLE "candidate_job_scores" ADD COLUMN "breakdown" JSONB;
