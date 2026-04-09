-- AddColumn: new fields to tenants table (Organization model — DB table stays "tenants")
-- These are additive changes only — no RENAME, DROP TABLE, or ALTER COLUMN on existing columns.
-- D-29: updated_at has DEFAULT NOW() to prevent NOT NULL constraint violation on existing rows.

ALTER TABLE "tenants" ADD COLUMN "short_id" VARCHAR(20);
ALTER TABLE "tenants" ADD COLUMN "logo_url" TEXT;
ALTER TABLE "tenants" ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "tenants" ADD COLUMN "created_by_user_id" UUID;
ALTER TABLE "tenants" ADD COLUMN "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- CreateIndex: unique constraint on short_id
CREATE UNIQUE INDEX "tenants_short_id_key" ON "tenants"("short_id");
