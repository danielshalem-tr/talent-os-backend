-- CreateIndex
CREATE INDEX "idx_candidates_tenant_status" ON "candidates"("tenant_id", "status");
