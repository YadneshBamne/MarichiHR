-- AlterTable
ALTER TABLE "attendance_policies" ADD COLUMN     "lwpFlagAfterAbsences" INTEGER;

-- AlterTable
ALTER TABLE "shift_templates" ADD COLUMN     "splitEndTime" TEXT,
ADD COLUMN     "splitStartTime" TEXT;

-- AlterTable
ALTER TABLE "work_locations" ADD COLUMN     "qrToken" TEXT;

-- CreateTable
CREATE TABLE "roster_days" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "shiftTemplateId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roster_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_adjustments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "fromStatus" TEXT NOT NULL,
    "toStatus" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "adjustedBy" TEXT NOT NULL,
    "appliedCycleId" TEXT,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "roster_days_tenantId_date_idx" ON "roster_days"("tenantId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "roster_days_employeeId_date_key" ON "roster_days"("employeeId", "date");

-- CreateIndex
CREATE INDEX "attendance_adjustments_tenantId_appliedCycleId_idx" ON "attendance_adjustments"("tenantId", "appliedCycleId");

-- CreateIndex
CREATE UNIQUE INDEX "work_locations_qrToken_key" ON "work_locations"("qrToken");

