-- AlterTable
ALTER TABLE "employee_contracts" ADD COLUMN     "noticePeriodDays" INTEGER NOT NULL DEFAULT 30;

-- CreateTable
CREATE TABLE "employee_exits" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "contractId" TEXT,
    "exitType" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "noticeDate" DATE NOT NULL,
    "lastWorkingDate" DATE NOT NULL,
    "noticePeriodDays" INTEGER NOT NULL,
    "noticeServedDays" INTEGER NOT NULL,
    "shortfallDays" INTEGER NOT NULL,
    "shortfallAction" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'initiated',
    "initiatedBy" TEXT NOT NULL,
    "currency" TEXT,
    "lines" JSONB,
    "warnings" JSONB,
    "totalEarnings" DOUBLE PRECISION,
    "totalDeductions" DOUBLE PRECISION,
    "netPayable" DOUBLE PRECISION,
    "computedBy" TEXT,
    "computedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "paidBy" TEXT,
    "paidAt" TIMESTAMP(3),
    "cancelledBy" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_exits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exit_clearances" (
    "id" TEXT NOT NULL,
    "exitId" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "responsibleUserId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "note" TEXT,
    "clearedAt" TIMESTAMP(3),

    CONSTRAINT "exit_clearances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "employee_exits_tenantId_status_idx" ON "employee_exits"("tenantId", "status");

-- CreateIndex
CREATE INDEX "employee_exits_employeeId_idx" ON "employee_exits"("employeeId");

-- CreateIndex
CREATE INDEX "exit_clearances_responsibleUserId_status_idx" ON "exit_clearances"("responsibleUserId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "exit_clearances_exitId_department_key" ON "exit_clearances"("exitId", "department");

-- AddForeignKey
ALTER TABLE "employee_exits" ADD CONSTRAINT "employee_exits_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_exits" ADD CONSTRAINT "employee_exits_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exit_clearances" ADD CONSTRAINT "exit_clearances_exitId_fkey" FOREIGN KEY ("exitId") REFERENCES "employee_exits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
