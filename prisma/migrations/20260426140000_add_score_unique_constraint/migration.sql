-- Prevents duplicate CandidateJobScore rows when BullMQ retries the scoring phase.
-- One score row per application (candidate-job pair) per tenant.
CREATE UNIQUE INDEX idx_scores_unique_per_app
ON candidate_job_scores(tenant_id, application_id);
