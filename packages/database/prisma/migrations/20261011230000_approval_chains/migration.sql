-- CreateTable
CREATE TABLE "approval_chains" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "requestType" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "leaveTypeIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "minDays" DOUBLE PRECISION,
    "levels" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approval_chains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_steps" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "requestType" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "userId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'waiting',
    "actedBy" TEXT,
    "onBehalfOf" TEXT,
    "actedAt" TIMESTAMP(3),
    "comments" TEXT,
    "pendingSince" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_delegations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "reason" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_delegations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "approval_chains_tenantId_requestType_active_idx" ON "approval_chains"("tenantId", "requestType", "active");

-- CreateIndex
CREATE INDEX "approval_steps_tenantId_requestType_requestId_idx" ON "approval_steps"("tenantId", "requestType", "requestId");

-- CreateIndex
CREATE INDEX "approval_steps_tenantId_status_idx" ON "approval_steps"("tenantId", "status");

-- CreateIndex
CREATE INDEX "approval_delegations_tenantId_toUserId_active_idx" ON "approval_delegations"("tenantId", "toUserId", "active");

-- AddForeignKey
ALTER TABLE "approval_chains" ADD CONSTRAINT "approval_chains_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

