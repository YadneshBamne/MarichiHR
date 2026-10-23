-- Kenya and Nigeria statutory tables. verified = false: figures from published calculators and guides that agree
-- with each other; confirm with KRA / NSSF / SHA and the Nigeria Revenue Service before relying on them.
INSERT INTO "statutory_tables" ("id", "country", "code", "name", "effectiveFrom", "params", "sourceUrl", "sourceNote", "verified")
VALUES
  (gen_random_uuid()::text, 'KE', 'KE_PAYE', 'PAYE (Kenya, monthly)', '2026-01-01',
   '{"bands": [{"upTo": 24000, "rate": 0.10}, {"upTo": 32333, "rate": 0.25}, {"upTo": 500000, "rate": 0.30}, {"upTo": 800000, "rate": 0.325}, {"upTo": null, "rate": 0.35}], "personalRelief": 2400}',
   'https://www.kra.go.ke/individual/filing-paying/types-of-taxes/paye', 'Monthly bands 10/25/30/32.5/35% and personal relief KES 2,400 a month, applied to pay after NSSF, SHIF and the housing levy (deductible since the Tax Laws (Amendment) Act 2024). Confirm with KRA.', false),
  (gen_random_uuid()::text, 'KE', 'KE_NSSF', 'NSSF (Kenya, year 4 of the 2013 Act)', '2026-02-01',
   '{"rate": 0.06, "lowerLimit": 9000, "upperLimit": 108000}', 'https://www.nssf.or.ke/', '6% employee and 6% employer on pensionable pay up to the upper earnings limit (KES 108,000 from February 2026; lower limit KES 9,000). Confirm with NSSF.', false),
  (gen_random_uuid()::text, 'KE', 'KE_SHIF', 'SHIF (Kenya)', '2024-10-01',
   '{"rate": 0.0275, "minimum": 300}', 'https://sha.go.ke/', 'Social Health Insurance Fund: 2.75% of gross pay, at least KES 300, no cap. Confirm with the Social Health Authority.', false),
  (gen_random_uuid()::text, 'KE', 'KE_AHL', 'Affordable Housing Levy (Kenya)', '2024-03-19',
   '{"employeeRate": 0.015, "employerRate": 0.015}', 'https://www.kra.go.ke/', '1.5% of gross pay from the employee and 1.5% from the employer. Confirm with KRA.', false),
  (gen_random_uuid()::text, 'NG', 'NG_PAYE', 'PAYE (Nigeria, Nigeria Tax Act 2025)', '2026-01-01',
   '{"bands": [{"upTo": 800000, "rate": 0}, {"upTo": 3000000, "rate": 0.15}, {"upTo": 12000000, "rate": 0.18}, {"upTo": 25000000, "rate": 0.21}, {"upTo": 50000000, "rate": 0.23}, {"upTo": null, "rate": 0.25}], "minimumWageMonthly": 70000}',
   'https://www.firs.gov.ng/', 'Annual bands 0% to 800,000, then 15/18/21/23/25%, on pay less pension; earners at or below the national minimum wage (NGN 70,000 a month) pay none. Rent relief (20% of rent, up to 500,000) is not applied. Confirm with the Nigeria Revenue Service.', false),
  (gen_random_uuid()::text, 'NG', 'NG_PENSION', 'Pension (Nigeria, Pension Reform Act 2014)', '2014-07-01',
   '{"employeeRate": 0.08, "employerRate": 0.10}', 'https://www.pencom.gov.ng/', '8% employee and 10% employer of basic, housing and transport allowances. Confirm with PenCom.', false)
ON CONFLICT ("code", "effectiveFrom") DO NOTHING;
