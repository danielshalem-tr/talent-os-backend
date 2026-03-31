-- Add column
ALTER TABLE "jobs" ADD COLUMN "short_id" TEXT;

-- Backfill shortId with deterministic generation per D-05
-- Algorithm: extract first letters of job title words (uppercase), append ROW_NUMBER per prefix
UPDATE "jobs" SET "short_id" = (
  WITH title_prefixes AS (
    SELECT
      id,
      STRING_AGG(
        SUBSTRING(word, 1, 1),
        ''
      ) AS prefix
    FROM (
      SELECT
        j.id,
        TRIM(UNNEST(STRING_TO_ARRAY(LOWER(j.title), ' '))) AS word
      FROM jobs j
    ) t
    GROUP BY id
  )
  SELECT
    CONCAT(tp.prefix, '-', ROW_NUMBER() OVER (PARTITION BY tp.prefix ORDER BY j.created_at)::text)
  FROM title_prefixes tp
  JOIN jobs j ON tp.id = j.id
);

-- Set NOT NULL constraint
ALTER TABLE "jobs" ALTER COLUMN "short_id" SET NOT NULL;

-- Create unique index (Prisma constraint will add this via @@unique, but explicit index helps)
CREATE UNIQUE INDEX "idx_job_short_id_tenant" ON "jobs"("tenant_id", "short_id");

-- Create lookup index
CREATE INDEX "idx_job_lookup_by_short_id" ON "jobs"("tenant_id", "short_id");
