-- AlterTable
ALTER TABLE "attendance_records" ADD COLUMN     "compOffDays" DOUBLE PRECISION,
ADD COLUMN     "earlyOutMinutes" INTEGER,
ADD COLUMN     "lateMinutes" INTEGER,
ADD COLUMN     "penalty" TEXT;

-- CreateTable
CREATE TABLE "attendance_policies" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "orgUnitIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "workLocationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "employeeCategories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "employmentTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "flexible" BOOLEAN NOT NULL DEFAULT false,
    "startTime" TEXT NOT NULL DEFAULT '09:00',
    "endTime" TEXT NOT NULL DEFAULT '17:00',
    "graceInMinutes" INTEGER NOT NULL DEFAULT 10,
    "graceOutMinutes" INTEGER NOT NULL DEFAULT 10,
    "halfDayHours" DOUBLE PRECISION NOT NULL DEFAULT 4,
    "fullDayHours" DOUBLE PRECISION NOT NULL DEFAULT 8,
    "lateEarlyAllowedPerMonth" INTEGER NOT NULL DEFAULT 3,
    "latePenalty" TEXT NOT NULL DEFAULT 'none',
    "regularisationDaysBack" INTEGER NOT NULL DEFAULT 7,
    "regularisationPerMonth" INTEGER NOT NULL DEFAULT 5,
    "overtimeEnabled" BOOLEAN NOT NULL DEFAULT true,
    "overtimeAfterHours" DOUBLE PRECISION NOT NULL DEFAULT 8,
    "overtimeRate" DOUBLE PRECISION NOT NULL DEFAULT 1.5,
    "overtimeMaxHoursPerMonth" DOUBLE PRECISION,
    "compOffEnabled" BOOLEAN NOT NULL DEFAULT false,
    "compOffHalfDayHours" DOUBLE PRECISION NOT NULL DEFAULT 4,
    "compOffFullDayHours" DOUBLE PRECISION NOT NULL DEFAULT 8,
    "allowWeb" BOOLEAN NOT NULL DEFAULT true,
    "requireGeofence" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "attendance_policies_tenantId_active_idx" ON "attendance_policies"("tenantId", "active");

-- AddForeignKey
ALTER TABLE "attendance_policies" ADD CONSTRAINT "attendance_policies_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

