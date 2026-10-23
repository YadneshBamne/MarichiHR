-- CreateTable
CREATE TABLE "leave_blackouts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "leaveTypeIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "departmentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leave_blackouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "leave_blackouts_tenantId_startDate_idx" ON "leave_blackouts"("tenantId", "startDate");

