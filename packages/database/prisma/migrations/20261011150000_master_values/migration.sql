-- CreateTable
CREATE TABLE "master_values" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "list" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "master_values_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "master_values_tenantId_list_active_idx" ON "master_values"("tenantId", "list", "active");

-- CreateIndex
CREATE UNIQUE INDEX "master_values_tenantId_list_code_key" ON "master_values"("tenantId", "list", "code");

-- AddForeignKey
ALTER TABLE "master_values" ADD CONSTRAINT "master_values_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Existing free-text values become master codes where they clearly match a default
UPDATE "employees" SET "nationality" = 'IN' WHERE lower(trim("nationality")) IN ('indian', 'india', 'in');
UPDATE "employees" SET "nationality" = 'ZM' WHERE lower(trim("nationality")) IN ('zambian', 'zambia', 'zm');
UPDATE "employees" SET "gender" = lower(trim("gender")) WHERE lower(trim("gender")) IN ('male', 'female');
UPDATE "employees" SET "bankName" = 'zanaco' WHERE lower(trim("bankName")) = 'zanaco';
UPDATE "employees" SET "bankName" = 'stanbic' WHERE lower(trim("bankName")) IN ('stanbic', 'stanbic bank');
