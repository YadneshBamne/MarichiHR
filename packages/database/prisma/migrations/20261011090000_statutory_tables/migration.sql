-- CreateTable
CREATE TABLE "statutory_tables" (
    "id" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "params" JSONB NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "sourceNote" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "statutory_tables_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "statutory_tables_code_effectiveFrom_key" ON "statutory_tables"("code", "effectiveFrom");


-- Reference rates. Each row cites its source; verified=false marks figures taken from a secondary source.
INSERT INTO "statutory_tables" ("id", "country", "code", "name", "effectiveFrom", "params", "sourceUrl", "sourceNote", "verified") VALUES
(gen_random_uuid()::text, 'ZM', 'ZM_PAYE', 'Zambia PAYE (monthly)', '2026-01-01',
 '{"basis":"gross_emoluments","bands":[{"upTo":5100,"rate":0},{"upTo":7100,"rate":0.2},{"upTo":9200,"rate":0.3},{"upTo":null,"rate":0.37}]}',
 'https://www.zra.org.zm/tax-information/',
 'ZRA "Example Calculation (2026 Tax Bands)": first K5,100 at 0%, K5,100.01-7,100 at 20%, K7,100.01-9,200 at 30%, above K9,200 at 37%. Charged on gross emoluments; since 1 January 2018 pension contributions are not deducted before chargeable income.', true),
(gen_random_uuid()::text, 'ZM', 'ZM_NAPSA', 'Zambia NAPSA pension contribution', '2025-01-01',
 '{"employeeRate":0.05,"employerRate":0.05,"monthlyCeiling":34164,"basis":"gross_earnings"}',
 'https://www.napsa.co.zm/news/details?id=df81c3bb-5416-4a43-b521-73923e0ccf93',
 'NAPSA notice "Revision in Contribution Ceiling for the Year 2025": maximum employee contribution K1,708.20 a month (K3,416.40 combined); rate unchanged at 10% of gross earnings, split 5% employee and 5% employer.', true),
(gen_random_uuid()::text, 'ZM', 'ZM_NAPSA', 'Zambia NAPSA pension contribution', '2026-01-01',
 '{"employeeRate":0.05,"employerRate":0.05,"monthlyCeiling":37236,"basis":"gross_earnings"}',
 'https://communityhub.sage.com/za/sage-300-people/f/announcements/261374/statutory-update-zambia-napsa-ceiling-increase-effective-01-january-2026',
 'Ceiling K37,236 a month from 1 January 2026 (maximum K1,861.80 each side) as published in Sage''s statutory update. Not yet seen on napsa.co.zm: confirm with NAPSA.', false),
(gen_random_uuid()::text, 'ZM', 'ZM_NHIMA', 'Zambia NHIMA health insurance', '2026-01-01',
 '{"employeeRate":0.01,"employerRate":0.01,"basis":"basic_salary"}',
 'https://www.parliament.gov.zm/sites/default/files/documents/acts/The%20National%20Health%20Insurance%20Actl,%20No.2%20of%202018%20Sig.pdf',
 'National Health Insurance Act No. 2 of 2018 and NHIMA registration guidance: 1% of basic salary from the employee and 1% from the employer, remitted by the 10th of the following month. Parliament has discussed raising the rate; watch for a change.', true),
(gen_random_uuid()::text, 'IN', 'IN_TDS_NEW', 'India income tax, new regime (section 115BAC)', '2025-04-01',
 '{"slabs":[{"upTo":400000,"rate":0},{"upTo":800000,"rate":0.05},{"upTo":1200000,"rate":0.1},{"upTo":1600000,"rate":0.15},{"upTo":2000000,"rate":0.2},{"upTo":2400000,"rate":0.25},{"upTo":null,"rate":0.3}],"standardDeduction":75000,"rebateIncomeLimit":1200000,"rebateMax":60000,"cess":0.04,"surchargeFrom":5000000,"fiscalYearStartMonth":4}',
 'https://www.incometax.gov.in/iec/foportal/help/individual/return-applicable-1',
 'Income Tax Department (AY 2026-27): new-regime slabs, rebate up to Rs 60,000 when taxable income does not exceed Rs 12 lakh, 4% health and education cess. Standard deduction Rs 75,000 per PIB release on Union Budget 2025-26 (PRID 2098406). The Budget 2026-27 summary (PIB PRID 2221458) lists no change to these slabs, so they continue for FY 2026-27. Surcharge (income above Rs 50 lakh) is not computed.', true);

-- PAYE is charged on gross emoluments (ZRA), not gross minus pension; NAPSA and NHIMA read the tables above
UPDATE "salary_rules" SET "pythonCode" = 'result = compute_zra_paye(categories.GROSS)' WHERE "pythonCode" = 'result = compute_zra_paye(categories.GROSS - categories.DED)';
UPDATE "salary_rules" SET "pythonCode" = 'result = napsa_employee(categories.GROSS)' WHERE "pythonCode" = 'result = min(contract.wageMonthly * 0.05, 1073.20)';
UPDATE "salary_rules" SET "pythonCode" = 'result = napsa_employer(categories.GROSS)' WHERE "pythonCode" = 'result = min(contract.wageMonthly * 0.10, 2146.40)';
UPDATE "salary_rules" SET "amountType" = 'python_code', "pythonCode" = 'result = nhima_employee(categories.BASIC)', "amountPercentage" = NULL, "amountPercentageBase" = NULL WHERE "code" = 'NHIMA_EMP' AND "amountType" = 'percentage' AND "amountPercentage" = 0.01;
UPDATE "salary_rules" SET "name" = 'NAPSA Employer (5%)' WHERE "name" = 'NAPSA Employer (10%)';
