-- Incentive types and nominations paid through payroll
-- CreateTable
CREATE TABLE "incentive_types" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "defaultAmount" DECIMAL(18,2),
    "maxAmount" DECIMAL(18,2),
    "payrollInputTypeId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incentive_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incentives" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "typeId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'nominated',
    "nominatedByUserId" TEXT NOT NULL,
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "payrollCycleId" TEXT,
    "payrollInputId" TEXT,
    "postedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "incentives_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "incentive_types_tenantId_code_key" ON "incentive_types"("tenantId", "code");

-- CreateIndex
CREATE INDEX "incentives_tenantId_status_idx" ON "incentives"("tenantId", "status");

-- CreateIndex
CREATE INDEX "incentives_employeeId_idx" ON "incentives"("employeeId");

-- AddForeignKey
ALTER TABLE "incentive_types" ADD CONSTRAINT "incentive_types_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incentives" ADD CONSTRAINT "incentives_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incentives" ADD CONSTRAINT "incentives_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "incentive_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

