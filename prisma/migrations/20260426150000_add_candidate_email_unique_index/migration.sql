-- Partial unique index: one email address per tenant, enforced only when email IS NOT NULL.
-- Null emails (candidates without an extracted email) bypass this constraint intentionally.
-- Prisma cannot express partial indexes natively — maintained via raw SQL migration.
CREATE UNIQUE INDEX IF NOT EXISTS idx_candidates_tenant_email_unique
ON candidates(tenant_id, email)
WHERE email IS NOT NULL;
