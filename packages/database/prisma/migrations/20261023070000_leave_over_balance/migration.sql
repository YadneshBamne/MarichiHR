-- AlterTable
ALTER TABLE "leave_requests" ADD COLUMN     "shortfallDays" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "leave_types" ADD COLUMN     "allowOverBalance" BOOLEAN NOT NULL DEFAULT true;

