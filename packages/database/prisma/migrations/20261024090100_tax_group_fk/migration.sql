-- DropForeignKey
ALTER TABLE "statutory_tables" DROP CONSTRAINT "statutory_tables_tenantId_fkey";

-- AddForeignKey
ALTER TABLE "statutory_tables" ADD CONSTRAINT "statutory_tables_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

