-- AlterTable
ALTER TABLE "payroll_cycles" ADD COLUMN     "payslipsReleasedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "payslips" ADD COLUMN     "withheld" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "withheldReason" TEXT;

-- CreateTable
CREATE TABLE "salary_revisions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "fromContractId" TEXT NOT NULL,
    "newCtcAnnual" DECIMAL(18,2) NOT NULL,
    "newWageMonthly" DECIMAL(18,2) NOT NULL,
    "newSalaryStructureId" TEXT,
    "effectiveFrom" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requestedBy" TEXT NOT NULL,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "newContractId" TEXT,
    "arrearsAmount" DECIMAL(18,2),
    "arrearsDetail" JSONB,
    "arrearsInputId" TEXT,
    "arrearsPostedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "salary_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "salary_revisions_tenantId_status_idx" ON "salary_revisions"("tenantId", "status");

-- CreateIndex
CREATE INDEX "salary_revisions_employeeId_idx" ON "salary_revisions"("employeeId");


-- Payslips that employees could already see (disbursed or locked runs) stay visible
UPDATE "payroll_cycles" SET "payslipsReleasedAt" = COALESCE("disbursedAt", "updatedAt") WHERE "status" IN ('disbursed', 'locked');
