-- CreateTable
CREATE TABLE "comp_review_cycles" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "budgetPercent" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comp_review_cycles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comp_recommendations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "managerEmployeeId" TEXT NOT NULL,
    "increasePercent" DOUBLE PRECISION NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'recommended',
    "revisionId" TEXT,
    "decidedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "comp_recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "comp_review_cycles_tenantId_name_key" ON "comp_review_cycles"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "comp_recommendations_cycleId_employeeId_key" ON "comp_recommendations"("cycleId", "employeeId");

-- AddForeignKey
ALTER TABLE "comp_recommendations" ADD CONSTRAINT "comp_recommendations_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "comp_review_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

