-- AlterTable
ALTER TABLE "employees" ADD COLUMN     "payGroupId" TEXT;

-- AlterTable
ALTER TABLE "payroll_cycles" ADD COLUMN     "payGroupId" TEXT;

-- AlterTable
ALTER TABLE "tax_filings" ADD COLUMN     "mode" TEXT NOT NULL DEFAULT 'manual',
ADD COLUMN     "response" JSONB,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'filed';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "hrScopeUnitIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "pay_groups" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "frequency" TEXT NOT NULL DEFAULT 'monthly',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pay_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_file_formats" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'delimited',
    "delimiter" TEXT NOT NULL DEFAULT ',',
    "header" BOOLEAN NOT NULL DEFAULT true,
    "columns" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_file_formats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pay_groups_tenantId_name_key" ON "pay_groups"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "bank_file_formats_tenantId_name_key" ON "bank_file_formats"("tenantId", "name");

