-- AlterTable
ALTER TABLE "incentives" ADD COLUMN     "formula" TEXT,
ADD COLUMN     "formulaInputs" JSONB,
ADD COLUMN     "schemeId" TEXT;

-- CreateTable
CREATE TABLE "incentive_schemes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "formula" TEXT NOT NULL,
    "variables" JSONB NOT NULL,
    "typeId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incentive_schemes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incentive_budgets" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "managerEmployeeId" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "alerted80At" TIMESTAMP(3),
    "alerted100At" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incentive_budgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incentive_settings" (
    "tenantId" TEXT NOT NULL,
    "ratingPayout" JSONB NOT NULL DEFAULT '{}',
    "kudosPoints" INTEGER NOT NULL DEFAULT 10,
    "pointValue" DECIMAL(18,4) NOT NULL DEFAULT 1,
    "pointsExpireMonths" INTEGER NOT NULL DEFAULT 12,
    "minRedeem" INTEGER NOT NULL DEFAULT 100,

    CONSTRAINT "incentive_settings_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "kudos_points" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "kudosId" TEXT,
    "incentiveId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kudos_points_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "incentive_schemes_tenantId_name_key" ON "incentive_schemes"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "incentive_budgets_tenantId_managerEmployeeId_periodStart_key" ON "incentive_budgets"("tenantId", "managerEmployeeId", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "kudos_points_kudosId_key" ON "kudos_points"("kudosId");

-- CreateIndex
CREATE INDEX "kudos_points_tenantId_employeeId_idx" ON "kudos_points"("tenantId", "employeeId");

