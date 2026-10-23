-- CreateTable
CREATE TABLE "tax_declaration_windows" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "opensOn" DATE NOT NULL,
    "closesOn" DATE NOT NULL,
    "openedAt" TIMESTAMP(3),
    "remindedAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_declaration_windows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_certificate_releases" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "basis" TEXT NOT NULL DEFAULT 'calendar',
    "releasedBy" TEXT NOT NULL,
    "releasedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "people" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "tax_certificate_releases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_filings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "authority" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "filedOn" DATE NOT NULL,
    "filedBy" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_filings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tax_declaration_windows_tenantId_year_key" ON "tax_declaration_windows"("tenantId", "year");

-- CreateIndex
CREATE UNIQUE INDEX "tax_certificate_releases_tenantId_year_basis_key" ON "tax_certificate_releases"("tenantId", "year", "basis");

-- CreateIndex
CREATE INDEX "tax_filings_tenantId_idx" ON "tax_filings"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "tax_filings_tenantId_cycleId_authority_key" ON "tax_filings"("tenantId", "cycleId", "authority");

