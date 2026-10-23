-- AlterTable
ALTER TABLE "payroll_cycles" ADD COLUMN     "correctsCycleId" TEXT,
ADD COLUMN     "offCycle" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reason" TEXT;

-- AlterTable
ALTER TABLE "salary_structures" ADD COLUMN     "flexiComponents" JSONB,
ADD COLUMN     "flexiPotCode" TEXT;

-- CreateTable
CREATE TABLE "flexi_choices" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "structureId" TEXT NOT NULL,
    "choices" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "note" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "flexi_choices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "flexi_choices_tenantId_status_idx" ON "flexi_choices"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "flexi_choices_employeeId_structureId_key" ON "flexi_choices"("employeeId", "structureId");


-- Minimum wages (monthly, verified = false: confirm with the labour ministry; sectors and regions differ)
INSERT INTO "statutory_tables" ("id", "country", "code", "name", "effectiveFrom", "params", "sourceUrl", "sourceNote", "verified")
VALUES
  (gen_random_uuid()::text, 'KE', 'KE_MIN_WAGE', 'Minimum wage (Kenya, general, cities)', '2024-11-01', '{"monthly": 15201.65}', 'https://www.labour.go.ke/', 'General minimum wage for cities (Nairobi, Mombasa, Kisumu), Regulation of Wages (General) Amendment Order 2024. Other areas and occupations differ. Confirm.', false),
  (gen_random_uuid()::text, 'NG', 'NG_MIN_WAGE', 'National minimum wage (Nigeria)', '2024-07-29', '{"monthly": 70000}', 'https://labour.gov.ng/', 'National Minimum Wage (Amendment) Act 2024: NGN 70,000 a month. Confirm.', false),
  (gen_random_uuid()::text, 'IN', 'IN_MIN_WAGE', 'National floor wage and wage rules (India)', '2026-01-01', '{"monthly": 4628, "minBasicShare": 0.5}', 'https://labour.gov.in/', 'National floor wage of INR 178 a day (x 26 days); state minimum wages are higher and apply. Code on Wages: basic pay (wages) should be at least 50% of total pay. Confirm for your state.', false)
ON CONFLICT ("code", "effectiveFrom") DO NOTHING;
