-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "department" TEXT,
    "location" TEXT,
    "job_type" TEXT NOT NULL DEFAULT 'full_time',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "description" TEXT,
    "requirements" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "salary_range" TEXT,
    "hiring_manager" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "email" TEXT,
    "full_name" TEXT NOT NULL,
    "phone" TEXT,
    "current_role" TEXT,
    "location" TEXT,
    "years_experience" SMALLINT,
    "skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cv_text" TEXT,
    "cv_file_url" TEXT,
    "source" TEXT NOT NULL,
    "source_agency" TEXT,
    "source_email" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "applications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "stage" TEXT NOT NULL DEFAULT 'new',
    "notes" TEXT,
    "intake_log_id" UUID,
    "applied_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_job_scores" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "score" SMALLINT NOT NULL,
    "reasoning" TEXT,
    "strengths" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "gaps" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "model_used" TEXT NOT NULL,
    "scored_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candidate_job_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "duplicate_flags" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    "matched_candidate_id" UUID NOT NULL,
    "confidence" DECIMAL(4,3) NOT NULL,
    "match_fields" TEXT[],
    "reviewed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "duplicate_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_intake_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "message_id" TEXT NOT NULL,
    "from_email" TEXT NOT NULL,
    "subject" TEXT,
    "received_at" TIMESTAMPTZ NOT NULL,
    "processing_status" TEXT NOT NULL DEFAULT 'pending',
    "error_message" TEXT,
    "candidate_id" UUID,
    "raw_payload" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_intake_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_jobs_active" ON "jobs"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "idx_applications_job" ON "applications"("job_id");

-- CreateIndex
CREATE INDEX "idx_applications_stage" ON "applications"("tenant_id", "stage");

-- CreateIndex
CREATE UNIQUE INDEX "applications_tenant_id_candidate_id_job_id_key" ON "applications"("tenant_id", "candidate_id", "job_id");

-- CreateIndex
CREATE INDEX "idx_scores_application" ON "candidate_job_scores"("application_id");

-- CreateIndex
CREATE UNIQUE INDEX "duplicate_flags_tenant_id_candidate_id_matched_candidate_id_key" ON "duplicate_flags"("tenant_id", "candidate_id", "matched_candidate_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_intake_log_tenant_id_message_id_key" ON "email_intake_log"("tenant_id", "message_id");

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_intake_log_id_fkey" FOREIGN KEY ("intake_log_id") REFERENCES "email_intake_log"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_job_scores" ADD CONSTRAINT "candidate_job_scores_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_job_scores" ADD CONSTRAINT "candidate_job_scores_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "duplicate_flags" ADD CONSTRAINT "duplicate_flags_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "duplicate_flags" ADD CONSTRAINT "duplicate_flags_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "candidates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "duplicate_flags" ADD CONSTRAINT "duplicate_flags_matched_candidate_id_fkey" FOREIGN KEY ("matched_candidate_id") REFERENCES "candidates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_intake_log" ADD CONSTRAINT "email_intake_log_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_intake_log" ADD CONSTRAINT "email_intake_log_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "candidates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- pg_trgm extension for fuzzy dedup (DB-01, DB-09, DEDUP-01)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Fuzzy dedup indexes on candidates (DB-09, DEDUP-06)
CREATE INDEX idx_candidates_name_trgm ON candidates USING GIN (full_name gin_trgm_ops);
CREATE INDEX idx_candidates_phone_trgm ON candidates USING GIN (phone gin_trgm_ops);

-- Partial unique index: one email per tenant, only when email is not null (DB-09, CAND-02)
CREATE UNIQUE INDEX idx_candidates_email
  ON candidates (tenant_id, email) WHERE email IS NOT NULL;

-- Partial index: fast lookup of unreviewed duplicate flags (DB-09)
CREATE INDEX idx_duplicates_unreviewed
  ON duplicate_flags (tenant_id, reviewed) WHERE reviewed = false;

-- Partial index: fast lookup of pending/failed intake jobs (DB-09)
CREATE INDEX idx_intake_status
  ON email_intake_log (processing_status)
  WHERE processing_status IN ('pending', 'failed');

-- CHECK constraints for status/type columns (DB-03)
ALTER TABLE jobs ADD CONSTRAINT jobs_status_check CHECK (status IN ('active', 'draft', 'closed', 'paused'));
ALTER TABLE jobs ADD CONSTRAINT jobs_job_type_check CHECK (job_type IN ('full_time', 'part_time', 'contract'));
ALTER TABLE applications ADD CONSTRAINT applications_stage_check CHECK (stage IN ('new', 'screening', 'interview', 'offer', 'hired', 'rejected'));
ALTER TABLE email_intake_log ADD CONSTRAINT intake_status_check CHECK (processing_status IN ('pending', 'processing', 'completed', 'failed', 'spam'));
ALTER TABLE candidates ADD CONSTRAINT candidates_source_check CHECK (source IN ('linkedin', 'website', 'agency', 'referral', 'direct'));
ALTER TABLE candidate_job_scores ADD CONSTRAINT scores_score_check CHECK (score BETWEEN 0 AND 100);
ALTER TABLE duplicate_flags ADD CONSTRAINT duplicate_flags_confidence_check CHECK (confidence BETWEEN 0 AND 1);
