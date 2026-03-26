-- AddUniqueConstraint: jobs(id, tenant_id) — enables Prisma composite key lookup
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_id_tenant_id_key" UNIQUE ("id", "tenant_id");
