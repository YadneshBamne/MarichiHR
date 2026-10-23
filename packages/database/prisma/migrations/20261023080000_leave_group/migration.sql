-- AlterTable
ALTER TABLE "leave_requests" ADD COLUMN     "hours" DOUBLE PRECISION,
ADD COLUMN     "returnNote" TEXT;

-- AlterTable
ALTER TABLE "leave_types" ADD COLUMN     "tenureSlabs" JSONB;

