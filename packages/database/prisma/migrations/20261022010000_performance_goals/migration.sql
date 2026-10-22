-- CreateTable
CREATE TABLE "performance_cycles" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "performance_cycles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "performance_goals" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "setByUserId" TEXT NOT NULL,
    "setByEmployeeId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "returnNote" TEXT,
    "sentAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "score" DOUBLE PRECISION,
    "rating" TEXT,
    "managerComment" TEXT,
    "employeeComment" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "performance_goals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "performance_kpis" (
    "id" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "target" DOUBLE PRECISION NOT NULL,
    "unit" TEXT,
    "weight" DOUBLE PRECISION NOT NULL,
    "achieved" DOUBLE PRECISION,
    "sequence" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "performance_kpis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "performance_cycles_tenantId_idx" ON "performance_cycles"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "performance_cycles_tenantId_name_key" ON "performance_cycles"("tenantId", "name");

-- CreateIndex
CREATE INDEX "performance_goals_tenantId_employeeId_idx" ON "performance_goals"("tenantId", "employeeId");

-- CreateIndex
CREATE INDEX "performance_goals_cycleId_idx" ON "performance_goals"("cycleId");

-- CreateIndex
CREATE INDEX "performance_kpis_goalId_idx" ON "performance_kpis"("goalId");

-- AddForeignKey
ALTER TABLE "performance_goals" ADD CONSTRAINT "performance_goals_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "performance_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_kpis" ADD CONSTRAINT "performance_kpis_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "performance_goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

