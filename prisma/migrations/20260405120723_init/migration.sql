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
    "short_id" TEXT NOT NULL,
    "description" TEXT,
    "requirements" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "salary_range" TEXT,
    "hiring_manager" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "role_summary" TEXT,
    "responsibilities" TEXT,
    "what_we_offer" TEXT,
    "must_have_skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "nice_to_have_skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "exp_years_min" SMALLINT,
    "exp_years_max" SMALLINT,
    "preferred_org_types" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "job_id" UUID,
    "hiring_stage_id" UUID,
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
    "ai_summary" TEXT,
    "metadata" JSONB,
    "status" TEXT NOT NULL DEFAULT 'active',
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
    "job_stage_id" UUID,
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
    "match_confidence" DECIMAL(3,2),
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

-- CreateTable
CREATE TABLE "job_stages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "order" SMALLINT NOT NULL,
    "interviewer" TEXT,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "color" TEXT NOT NULL DEFAULT 'bg-zinc-400',
    "is_custom" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "job_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "screening_questions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "answer_type" TEXT NOT NULL,
    "expected_answer" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "knockout" BOOLEAN NOT NULL DEFAULT false,
    "order" SMALLINT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "screening_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_stage_summaries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    "job_stage_id" UUID NOT NULL,
    "summary" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "candidate_stage_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_jobs_active" ON "jobs"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "idx_job_lookup_by_short_id" ON "jobs"("tenant_id", "short_id");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_id_tenant_id_key" ON "jobs"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_tenant_id_short_id_key" ON "jobs"("tenant_id", "short_id");

-- CreateIndex
CREATE INDEX "idx_candidates_tenant_job" ON "candidates"("tenant_id", "job_id");

-- CreateIndex
CREATE INDEX "idx_candidates_tenant_job_stage" ON "candidates"("tenant_id", "job_id", "hiring_stage_id");

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

-- CreateIndex
CREATE INDEX "idx_job_stages_job_order" ON "job_stages"("job_id", "order");

-- CreateIndex
CREATE INDEX "idx_screening_questions_job" ON "screening_questions"("job_id");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_stage_summaries_candidate_id_job_stage_id_key" ON "candidate_stage_summaries"("candidate_id", "job_stage_id");

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_hiring_stage_id_fkey" FOREIGN KEY ("hiring_stage_id") REFERENCES "job_stages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_intake_log_id_fkey" FOREIGN KEY ("intake_log_id") REFERENCES "email_intake_log"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_job_stage_id_fkey" FOREIGN KEY ("job_stage_id") REFERENCES "job_stages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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

-- AddForeignKey
ALTER TABLE "job_stages" ADD CONSTRAINT "job_stages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_stages" ADD CONSTRAINT "job_stages_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "screening_questions" ADD CONSTRAINT "screening_questions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "screening_questions" ADD CONSTRAINT "screening_questions_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_stage_summaries" ADD CONSTRAINT "candidate_stage_summaries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_stage_summaries" ADD CONSTRAINT "candidate_stage_summaries_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_stage_summaries" ADD CONSTRAINT "candidate_stage_summaries_job_stage_id_fkey" FOREIGN KEY ("job_stage_id") REFERENCES "job_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
