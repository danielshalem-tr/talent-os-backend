-- Enable pg_trgm extension for fuzzy name matching in duplicate detection (DEDUP-01)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Create GIN indexes for similarity() queries in dedupService.check()
-- These indexes dramatically improve performance of fuzzy matching queries (DEDUP-PERF-01)
CREATE INDEX IF NOT EXISTS "idx_candidates_full_name_trgm" ON "candidates" USING GIN ("full_name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "idx_candidates_phone_trgm" ON "candidates" USING GIN ("phone" gin_trgm_ops);
