-- Confidential grievance desk with anonymous cases and case conversations
-- CreateTable
CREATE TABLE "grievances" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "ticketNo" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "anonymous" BOOLEAN NOT NULL DEFAULT false,
    "raisedByUserId" TEXT,
    "caseKeyHash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "assignedToUserId" TEXT,
    "resolution" TEXT,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "grievances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grievance_messages" (
    "id" TEXT NOT NULL,
    "grievanceId" TEXT NOT NULL,
    "authorUserId" TEXT,
    "authorRole" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "grievance_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "grievances_tenantId_status_idx" ON "grievances"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "grievances_tenantId_ticketNo_key" ON "grievances"("tenantId", "ticketNo");

-- CreateIndex
CREATE INDEX "grievance_messages_grievanceId_createdAt_idx" ON "grievance_messages"("grievanceId", "createdAt");

-- AddForeignKey
ALTER TABLE "grievances" ADD CONSTRAINT "grievances_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grievance_messages" ADD CONSTRAINT "grievance_messages_grievanceId_fkey" FOREIGN KEY ("grievanceId") REFERENCES "grievances"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

