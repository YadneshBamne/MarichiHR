-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "employeeCodeDigits" INTEGER NOT NULL DEFAULT 4,
ADD COLUMN     "employeeCodePrefix" TEXT NOT NULL DEFAULT 'EMP';

