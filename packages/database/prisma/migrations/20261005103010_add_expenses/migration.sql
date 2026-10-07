-- CreateTable
CREATE TABLE "expense_categories" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "maxAmount" DOUBLE PRECISION,
    "enforceLimit" BOOLEAN NOT NULL DEFAULT false,
    "receiptRequiredAbove" DOUBLE PRECISION,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expense_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "per_diem_rates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "city" TEXT,
    "ratePerDay" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveUntil" DATE,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "per_diem_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fx_rates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fromCurrency" TEXT NOT NULL,
    "toCurrency" TEXT NOT NULL,
    "rate" DOUBLE PRECISION NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fx_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reimbursement_claims" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "claimType" TEXT NOT NULL,
    "expenseDate" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "receiptNumber" TEXT,
    "expenseCurrency" TEXT NOT NULL,
    "expenseAmount" DOUBLE PRECISION NOT NULL,
    "fxRate" DOUBLE PRECISION NOT NULL,
    "fxRateDate" DATE,
    "homeCurrency" TEXT NOT NULL,
    "homeAmount" DOUBLE PRECISION NOT NULL,
    "perDiemRateId" TEXT,
    "perDiemDays" DOUBLE PRECISION,
    "perDiemCountry" TEXT,
    "perDiemCity" TEXT,
    "overLimit" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "managerApprovedByUserId" TEXT,
    "managerApprovedAt" TIMESTAMP(3),
    "financeApprovedByUserId" TEXT,
    "financeApprovedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "rejectedByUserId" TEXT,
    "paidInCycleId" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reimbursement_claims_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "expense_categories_tenantId_code_key" ON "expense_categories"("tenantId", "code");

-- CreateIndex
CREATE INDEX "per_diem_rates_tenantId_countryCode_idx" ON "per_diem_rates"("tenantId", "countryCode");

-- CreateIndex
CREATE UNIQUE INDEX "fx_rates_tenantId_fromCurrency_toCurrency_effectiveFrom_key" ON "fx_rates"("tenantId", "fromCurrency", "toCurrency", "effectiveFrom");

-- CreateIndex
CREATE INDEX "reimbursement_claims_tenantId_status_idx" ON "reimbursement_claims"("tenantId", "status");

-- CreateIndex
CREATE INDEX "reimbursement_claims_employeeId_idx" ON "reimbursement_claims"("employeeId");

-- AddForeignKey
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "per_diem_rates" ADD CONSTRAINT "per_diem_rates_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fx_rates" ADD CONSTRAINT "fx_rates_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reimbursement_claims" ADD CONSTRAINT "reimbursement_claims_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reimbursement_claims" ADD CONSTRAINT "reimbursement_claims_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reimbursement_claims" ADD CONSTRAINT "reimbursement_claims_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "expense_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reimbursement_claims" ADD CONSTRAINT "reimbursement_claims_perDiemRateId_fkey" FOREIGN KEY ("perDiemRateId") REFERENCES "per_diem_rates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
