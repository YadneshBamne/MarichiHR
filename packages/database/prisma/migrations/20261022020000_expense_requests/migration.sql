-- AlterTable
ALTER TABLE "reimbursement_claims" ADD COLUMN     "expenseRequestId" TEXT;

-- CreateTable
CREATE TABLE "expense_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "justification" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "destination" TEXT,
    "startDate" DATE,
    "endDate" DATE,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expense_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "expense_requests_tenantId_status_idx" ON "expense_requests"("tenantId", "status");

-- CreateIndex
CREATE INDEX "expense_requests_employeeId_idx" ON "expense_requests"("employeeId");

-- AddForeignKey
ALTER TABLE "reimbursement_claims" ADD CONSTRAINT "reimbursement_claims_expenseRequestId_fkey" FOREIGN KEY ("expenseRequestId") REFERENCES "expense_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_requests" ADD CONSTRAINT "expense_requests_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

