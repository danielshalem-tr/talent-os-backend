-- Kill-switch for AI ingest calls (classifier/extraction/scoring). Default ON = current behavior.
ALTER TABLE "tenants" ADD COLUMN "ai_ingest_enabled" BOOLEAN NOT NULL DEFAULT true;
