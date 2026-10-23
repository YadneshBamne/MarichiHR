-- AlterTable
ALTER TABLE "policies" ADD COLUMN     "countries" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "critical" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ownerUserId" TEXT;

