-- Ingestion hardening: indexes behind the hot intake/dedup queries.

-- 1. GET /ingest-control (+ 30 s poll while paused) and the worker backstop filter by status.
CREATE INDEX IF NOT EXISTS idx_intake_tenant_status
  ON email_intake_log (tenant_id, processing_status);

-- 2. Phone dedup compares regexp_replace(phone, '[^0-9]', '', 'g') inside the Phase 6
--    transaction while holding advisory locks — a sequential scan there grows with every
--    candidate. The expression matches src/dedup/phone-lookup.ts byte for byte.
CREATE INDEX IF NOT EXISTS idx_candidates_phone_digits
  ON candidates (tenant_id, regexp_replace(phone, '[^0-9]', '', 'g'))
  WHERE phone IS NOT NULL;

-- 3. Email uniqueness becomes case-insensitive. The unique index can only be created when no
--    case-duplicates exist; otherwise a plain index is created so the app (already
--    case-insensitive in code) still boots, and the operator runs
--    `npm run dedup:merge-case-emails -- --apply` then creates the unique index by hand
--    (see the ingestion-hardening runbook).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM candidates WHERE email IS NOT NULL
    GROUP BY tenant_id, lower(email) HAVING count(*) > 1
  ) THEN
    RAISE WARNING 'idx_candidates_tenant_email_ci_unique NOT created: case-duplicate emails exist. Run the merge script, then: CREATE UNIQUE INDEX idx_candidates_tenant_email_ci_unique ON candidates (tenant_id, lower(email)) WHERE email IS NOT NULL; DROP INDEX idx_candidates_tenant_email_ci; DROP INDEX idx_candidates_tenant_email_unique;';
    CREATE INDEX IF NOT EXISTS idx_candidates_tenant_email_ci
      ON candidates (tenant_id, lower(email)) WHERE email IS NOT NULL;
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS idx_candidates_tenant_email_ci_unique
      ON candidates (tenant_id, lower(email)) WHERE email IS NOT NULL;
    DROP INDEX IF EXISTS idx_candidates_tenant_email_unique;
  END IF;
END $$;
