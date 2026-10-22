-- AlterTable
ALTER TABLE "payroll_cycles" ADD COLUMN     "signoffAt" TIMESTAMP(3),
ADD COLUMN     "signoffBy" TEXT;

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "payrollSignoffAbove" DECIMAL(18,2);


-- Contractor withholding rates (verified = false: confirm with the tax authority before relying on them)
INSERT INTO "statutory_tables" ("id", "country", "code", "name", "effectiveFrom", "params", "sourceUrl", "sourceNote", "verified")
VALUES
  (gen_random_uuid()::text, 'ZM', 'ZM_WHT_CONTRACTOR', 'Withholding tax on contractor fees (Zambia)', '2026-01-01', '{"rate": 0.15}', 'https://www.zra.org.zm/withholding-tax/', 'Withholding tax on fees paid to resident contractors and consultants: 15%. Confirm the rate and any exemptions with ZRA.', false),
  (gen_random_uuid()::text, 'IN', 'IN_TDS_194J', 'TDS on professional fees, section 194J (India)', '2026-04-01', '{"rate": 0.10, "threshold": 30000}', 'https://incometaxindia.gov.in/Pages/tools/tds-calculator.aspx', 'TDS on fees for professional services under section 194J: 10% above 30,000 a year (2% for technical services). Confirm with the Income Tax Department.', false)
ON CONFLICT ("code", "effectiveFrom") DO NOTHING;
