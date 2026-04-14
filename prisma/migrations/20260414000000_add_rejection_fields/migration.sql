-- Add rejection reason and note columns to candidates table
ALTER TABLE "candidates"
  ADD COLUMN "rejection_reason" VARCHAR(100),
  ADD COLUMN "rejection_note" TEXT;

ALTER TABLE "candidates"
  ADD CONSTRAINT "candidates_rejection_reason_check"
  CHECK (rejection_reason IN ('not_a_fit', 'overqualified', 'underqualified', 'failed_screening', 'compensation_mismatch', 'culture_fit', 'other'));
