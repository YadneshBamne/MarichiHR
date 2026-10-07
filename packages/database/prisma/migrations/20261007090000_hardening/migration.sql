-- Prompt 22 hardening: notifications, tenant-scoped chatter, leave SLA escalation, Google SSO + TOTP fields

-- ─── Chatter tenantId with backfill ───────────────────────────
DROP INDEX "chatter_messages_entityType_entityId_idx";
ALTER TABLE "chatter_messages" ADD COLUMN "tenantId" TEXT;

UPDATE "chatter_messages" c SET "tenantId" = e."tenantId"
  FROM "employees" e WHERE c."entityType" = 'employee' AND e."id" = c."entityId";
UPDATE "chatter_messages" c SET "tenantId" = e."tenantId"
  FROM "employee_contracts" x JOIN "employees" e ON e."id" = x."employeeId"
  WHERE c."entityType" = 'contract' AND x."id" = c."entityId";
UPDATE "chatter_messages" c SET "tenantId" = e."tenantId"
  FROM "leave_requests" x JOIN "employees" e ON e."id" = x."employeeId"
  WHERE c."entityType" = 'leave_request' AND x."id" = c."entityId";
UPDATE "chatter_messages" c SET "tenantId" = e."tenantId"
  FROM "attendance_regularisations" x JOIN "employees" e ON e."id" = x."employeeId"
  WHERE c."entityType" = 'attendance_regularisation' AND x."id" = c."entityId";
UPDATE "chatter_messages" c SET "tenantId" = e."tenantId"
  FROM "overtime_requests" x JOIN "employees" e ON e."id" = x."employeeId"
  WHERE c."entityType" = 'overtime_request' AND x."id" = c."entityId";
UPDATE "chatter_messages" c SET "tenantId" = x."tenantId"
  FROM "reimbursement_claims" x WHERE c."entityType" = 'expense_claim' AND x."id" = c."entityId";
-- Anything else: the author's tenant
UPDATE "chatter_messages" c SET "tenantId" = e."tenantId"
  FROM "employees" e WHERE c."tenantId" IS NULL AND e."id" = c."authorId";
-- Still unresolved and only one tenant exists: it can only belong to that tenant
UPDATE "chatter_messages" SET "tenantId" = (SELECT "id" FROM "tenants")
  WHERE "tenantId" IS NULL AND (SELECT count(*) FROM "tenants") = 1;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "chatter_messages" WHERE "tenantId" IS NULL) THEN
    RAISE EXCEPTION 'chatter_messages rows with an unresolvable tenant remain; resolve them by hand before migrating';
  END IF;
END $$;

ALTER TABLE "chatter_messages" ALTER COLUMN "tenantId" SET NOT NULL;
CREATE INDEX "chatter_messages_tenantId_entityType_entityId_idx" ON "chatter_messages"("tenantId", "entityType", "entityId");
ALTER TABLE "chatter_messages" ADD CONSTRAINT "chatter_messages_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Leave SLA escalation ─────────────────────────────────────
ALTER TABLE "leave_approvals" ADD COLUMN "escalatedAt" TIMESTAMP(3);

-- ─── Google SSO + TOTP replay guard ───────────────────────────
ALTER TABLE "users" ADD COLUMN "googleSub" TEXT, ADD COLUMN "mfaLastStep" INTEGER;
CREATE UNIQUE INDEX "users_tenantId_googleSub_key" ON "users"("tenantId", "googleSub");

-- ─── Notifications ────────────────────────────────────────────
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "eventId" TEXT,
    "deliveries" JSONB NOT NULL DEFAULT '[]',
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "notifications_tenantId_userId_readAt_idx" ON "notifications"("tenantId", "userId", "readAt");
CREATE UNIQUE INDEX "notifications_eventId_userId_type_key" ON "notifications"("eventId", "userId", "type");
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
