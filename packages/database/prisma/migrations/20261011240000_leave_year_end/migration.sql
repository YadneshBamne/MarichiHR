-- AlterTable
ALTER TABLE "leave_types" ADD COLUMN     "encashMaxDays" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "leave_year_end_runs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "yearEnd" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'done',
    "automatic" BOOLEAN NOT NULL DEFAULT false,
    "ranBy" TEXT,
    "ranAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rolledBackBy" TEXT,
    "rolledBackAt" TIMESTAMP(3),
    "rows" JSONB NOT NULL,
    "totals" JSONB NOT NULL,

    CONSTRAINT "leave_year_end_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "leave_year_end_runs_tenantId_yearEnd_idx" ON "leave_year_end_runs"("tenantId", "yearEnd");

