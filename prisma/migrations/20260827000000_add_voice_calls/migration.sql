-- Voice screening calls (ElevenLabs): call lifecycle rows + per-job/per-tenant opt-in toggles.
-- Everything defaults OFF — no call can be placed until env, tenant switch, and job toggle are all explicitly enabled.

-- CreateTable
CREATE TABLE "voice_calls" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "trigger" TEXT NOT NULL DEFAULT 'auto',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "conversation_id" TEXT,
    "idempotency_key" TEXT,
    "scheduled_for" TIMESTAMPTZ,
    "started_at" TIMESTAMPTZ,
    "duration_secs" INTEGER,
    "summary" TEXT,
    "transcript" JSONB,
    "qa_results" JSONB,
    "audio_key" TEXT,
    "cost" INTEGER,
    "error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "voice_calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "voice_calls_conversation_id_key" ON "voice_calls"("conversation_id");
CREATE UNIQUE INDEX "voice_calls_idempotency_key_key" ON "voice_calls"("idempotency_key");
CREATE INDEX "idx_voice_calls_tenant_candidate" ON "voice_calls"("tenant_id", "candidate_id");
CREATE INDEX "idx_voice_calls_tenant_status" ON "voice_calls"("tenant_id", "status");

-- AddForeignKey
ALTER TABLE "voice_calls" ADD CONSTRAINT "voice_calls_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "voice_calls" ADD CONSTRAINT "voice_calls_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "voice_calls" ADD CONSTRAINT "voice_calls_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CHECK constraints (project convention: text + CHECK over PostgreSQL ENUMs)
ALTER TABLE "voice_calls" ADD CONSTRAINT "voice_calls_status_check"
  CHECK (status IN ('scheduled', 'calling', 'in_progress', 'completed', 'no_answer', 'blocked', 'canceled', 'failed'));
ALTER TABLE "voice_calls" ADD CONSTRAINT "voice_calls_trigger_check"
  CHECK ("trigger" IN ('auto', 'manual'));

-- Per-job voice screening toggle + score threshold; per-tenant kill switch. All OFF by default
-- (mirrors 20260811000000_add_ai_ingest_enabled).
ALTER TABLE "jobs" ADD COLUMN "voice_screening_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "jobs" ADD COLUMN "voice_min_score" INTEGER NOT NULL DEFAULT 70;
ALTER TABLE "tenants" ADD COLUMN "voice_calls_enabled" BOOLEAN NOT NULL DEFAULT false;
