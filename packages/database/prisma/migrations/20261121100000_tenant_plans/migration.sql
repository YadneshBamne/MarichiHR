-- Plans and add-ons per company. Existing companies keep plan NULL, which means every app.
ALTER TABLE "tenants" ADD COLUMN "plan" TEXT, ADD COLUMN "addons" TEXT[] DEFAULT ARRAY[]::TEXT[];
