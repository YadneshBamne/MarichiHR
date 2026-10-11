// Gratuity calculator (pure): India s.4 and Zambia s.73 with the parameters from the gratuity_tables migration.
require('ts-node').register({ transpileOnly: true })
const { computeGratuity } = require('../../src/modules/tax/statutory')
const { check, done } = require('./lib')
const t = { IN_GRATUITY: { daysPerYear: 15, divisor: 26, minYears: 5, roundUpMonths: 6, ceiling: 2000000, exemptExitTypes: ['death', 'disablement'] }, ZM_GRATUITY: { rate: 0.25, minContractMonths: 12 } }
const base = { exitType: 'resignation', basicMonthly: 52000, basicEarnedInContract: 0, contractFrom: '2020-01-01', contractUntil: null }
const g = (x) => computeGratuity({ ...base, ...x }, t)
check('India: 8 years 7 months counts as 9 years → 52000×15÷26×9', g({ country: 'IN', hireDate: '2018-01-10', lastWorkingDate: '2026-08-20' }).amount === 270000)
check('India: 6 months exactly rounds up, 5 months does not', g({ country: 'IN', hireDate: '2020-01-01', lastWorkingDate: '2025-07-01' }).amount === 180000 && g({ country: 'IN', hireDate: '2020-01-01', lastWorkingDate: '2025-06-01' }).amount === 150000)
check('India: under 5 years pays nothing on resignation', g({ country: 'IN', hireDate: '2022-01-01', lastWorkingDate: '2026-12-31' }).amount === 0)
check('…but pays on death', g({ country: 'IN', hireDate: '2024-01-01', lastWorkingDate: '2026-02-01', exitType: 'death' }).amount === 60000)
check('India: capped at 20 lakh', g({ country: 'IN', hireDate: '1990-01-01', lastWorkingDate: '2026-01-01', basicMonthly: 200000 }).amount === 2000000)
check('Zambia: 25% of basic earned on a 24-month contract', g({ country: 'ZM', hireDate: '2024-01-01', lastWorkingDate: '2025-12-31', contractFrom: '2024-01-01', contractUntil: '2025-12-31', basicEarnedInContract: 240000 }).amount === 60000)
check('Zambia: a 6-month contract has none', g({ country: 'ZM', hireDate: '2025-01-01', lastWorkingDate: '2025-06-30', contractFrom: '2025-01-01', contractUntil: '2025-06-30', basicEarnedInContract: 60000 }).amount === 0)
check('Zambia: permanent contract warns instead of paying', (() => { const r = g({ country: 'ZM', hireDate: '2020-01-01', lastWorkingDate: '2026-01-01', basicEarnedInContract: 500000 }); return r.amount === 0 && /contested/.test(r.warning) })())
check('Other countries warn', !!g({ country: 'KE', hireDate: '2020-01-01', lastWorkingDate: '2026-01-01' }).warning)
done()
