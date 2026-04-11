-- AlterTable: tenants — add nullable onboarding_completed_at column
-- NULL = onboarding not done; timestamp present = onboarding complete (D-13 from 19-CONTEXT.md)
ALTER TABLE "tenants" ADD COLUMN "onboarding_completed_at" TIMESTAMPTZ;
