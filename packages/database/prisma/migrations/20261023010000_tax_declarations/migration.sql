-- CreateTable
CREATE TABLE "tax_declarations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "regime" TEXT NOT NULL DEFAULT 'new',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "items" JSONB NOT NULL DEFAULT '[]',
    "note" TEXT,
    "submittedAt" TIMESTAMP(3),
    "verifiedBy" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_declarations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tax_declarations_tenantId_year_status_idx" ON "tax_declarations"("tenantId", "year", "status");

-- CreateIndex
CREATE UNIQUE INDEX "tax_declarations_tenantId_employeeId_year_key" ON "tax_declarations"("tenantId", "employeeId", "year");

