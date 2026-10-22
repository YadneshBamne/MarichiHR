-- AlterTable
ALTER TABLE "job_openings" ADD COLUMN     "experienceMaxYears" DOUBLE PRECISION,
ADD COLUMN     "experienceMinYears" DOUBLE PRECISION,
ADD COLUMN     "reason" TEXT NOT NULL DEFAULT 'new_post',
ADD COLUMN     "replacesEmployeeId" TEXT;

