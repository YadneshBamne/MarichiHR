-- DropIndex
DROP INDEX "statutory_tables_code_effectiveFrom_key";

-- AlterTable
ALTER TABLE "payslip_lines" ADD COLUMN     "statutoryRef" TEXT;

-- AlterTable
ALTER TABLE "statutory_tables" ADD COLUMN     "createdBy" TEXT,
ADD COLUMN     "tenantId" TEXT;

-- CreateTable
CREATE TABLE "tax_overrides" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "lineCode" TEXT NOT NULL,
    "originalAmount" DECIMAL(18,2) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requestedBy" TEXT NOT NULL,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tax_overrides_tenantId_status_idx" ON "tax_overrides"("tenantId", "status");

-- CreateIndex
CREATE INDEX "tax_overrides_cycleId_employeeId_idx" ON "tax_overrides"("cycleId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "statutory_tables_code_effectiveFrom_tenantId_key" ON "statutory_tables"("code", "effectiveFrom", "tenantId");

-- AddForeignKey
ALTER TABLE "statutory_tables" ADD CONSTRAINT "statutory_tables_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_overrides" ADD CONSTRAINT "tax_overrides_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

