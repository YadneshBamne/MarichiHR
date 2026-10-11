-- Statutory gratuity parameters (verified=false until confirmed against the official text)
INSERT INTO "statutory_tables" ("id", "country", "code", "name", "effectiveFrom", "params", "sourceUrl", "sourceNote", "verified") VALUES
(gen_random_uuid(), 'IN', 'IN_GRATUITY', 'India gratuity (Payment of Gratuity Act 1972, s.4)', '2018-03-29',
 '{"daysPerYear":15,"divisor":26,"minYears":5,"roundUpMonths":6,"ceiling":2000000,"exemptExitTypes":["death","disablement"]}',
 'https://www.indiacode.nic.in/handle/123456789/1597',
 's.4(2): 15 days of wages (basic + DA) per completed year, part year over 6 months counts, monthly wage / 26. s.4(1): 5 years continuous service, not needed on death or disablement. s.4(3): ceiling Rs 20 lakh (2018 amendment notification 29 Mar 2018).', false),
(gen_random_uuid(), 'ZM', 'ZM_GRATUITY', 'Zambia gratuity (Employment Code Act 2019, s.73)', '2019-05-09',
 '{"rate":0.25,"minContractMonths":12}',
 'https://zambialii.org/akn/zm/act/2019/3',
 's.73(1): at the end of a long-term contract, not less than 25% of basic pay earned during the contract period; s.73(2): prorated on earlier termination. Long-term = 12 months or more. Whether permanent contracts qualify is before the Court of Appeal.', false);
