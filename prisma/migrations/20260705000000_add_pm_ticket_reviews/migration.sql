-- CreateTable
CREATE TABLE "pm_ticket_reviews" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "jira_key" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "comment" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pm_ticket_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_pm_ticket_reviews_tenant_key" ON "pm_ticket_reviews"("tenant_id", "jira_key");

-- AddForeignKey
ALTER TABLE "pm_ticket_reviews" ADD CONSTRAINT "pm_ticket_reviews_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CHECK constraint: action must be one of the allowed values (project convention: text + CHECK over PostgreSQL ENUMs)
ALTER TABLE "pm_ticket_reviews" ADD CONSTRAINT "pm_ticket_reviews_action_check" CHECK (action IN ('verified', 'reopened'));
