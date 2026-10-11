// Tax & compliance: the calculators against the authorities' own worked figures, the statutory tables and who sees
// them, a payroll run using the tables, the statutory return (+CSV) and annual tax statements, isolation.
// Uses a throwaway payroll run in TAX_MONTH (default 2032-04) and removes it at the end.
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } })
const { api, tokenFor, check, done, prisma } = require('./lib')
const { bandTax, indiaAnnualTax, indiaMonthsLeft, indiaFyStart, statutoryFunctions } = require('../../src/modules/tax/statutory')

const BASE = (process.env.API_URL || 'http://localhost:4000') + '/api/v1'
const MONTH = process.env.TAX_MONTH || '2032-04'

;(async () => {
  // ─── Calculators ───────────────────────────────────────────
  const tables = Object.fromEntries((await prisma.statutoryTable.findMany({ where: { effectiveFrom: { lte: new Date('2026-12-31') } }, orderBy: { effectiveFrom: 'asc' } })).map((t) => [t.code, t.params]))
  check("ZRA's own 2026 example: K15,000 → K3,176 PAYE", bandTax(15000, tables.ZM_PAYE.bands) === 3176, bandTax(15000, tables.ZM_PAYE.bands))
  check('ZRA: nothing up to K5,100, K400 at K7,100', bandTax(5100, tables.ZM_PAYE.bands) === 0 && Math.round(bandTax(7100, tables.ZM_PAYE.bands)) === 400)
  const fns = statutoryFunctions({ at: '2026-12-31', tables }, () => {})
  check('NAPSA 2026: 5% capped at K37,236 (K1,861.80 each side)', fns.napsa_employee(50000) === 1861.8 && fns.napsa_employer(50000) === 1861.8 && fns.napsa_employee(10000) === 500)
  check('NHIMA: 1% of basic each side', fns.nhima_employee(10000) === 100 && fns.nhima_employer(10000) === 100)
  const t = tables.IN_TDS_NEW
  check('India: Rs 12.75 lakh salary (12 lakh after standard deduction) pays no tax', indiaAnnualTax(1275000, t).annualTax === 0, indiaAnnualTax(1275000, t))
  check('India: marginal relief just above 12 lakh (13 lakh salary → Rs 25,000 + 4% cess = 26,000)', indiaAnnualTax(1300000, t).annualTax === 26000, indiaAnnualTax(1300000, t))
  check('India: Rs 20 lakh salary → Rs 1,85,000 + cess = 1,92,400', indiaAnnualTax(2000000, t).annualTax === 192400, indiaAnnualTax(2000000, t))
  check('India financial year: April has 12 months left, October 6, March 1; Jan 2027 belongs to FY from 2026-04-01', indiaMonthsLeft('2026-04-01') === 12 && indiaMonthsLeft('2026-10-01') === 6 && indiaMonthsLeft('2027-03-01') === 1 && indiaFyStart('2027-01-01') === '2026-04-01')
  const tds = statutoryFunctions({ at: '2026-10-31', tables, indiaYtd: { gross: 6 * 150000, tax: 6 * 13650, monthsLeft: 6 } }, () => {})
  check('India cumulative TDS: 1.5 lakh a month with half the year paid → the rest spread evenly', tds.compute_india_tds(150000) === round(( indiaAnnualTax(1800000, t).annualTax - 6 * 13650) / 6), tds.compute_india_tds(150000))
  const warned = []
  statutoryFunctions({ at: '2026-10-31', tables, indiaYtd: { gross: 0, tax: 0, monthsLeft: 12 } }, (w) => warned.push(w)).compute_india_tds(500000)
  check('India: surcharge territory raises a warning instead of a silent wrong number', warned.length === 1, warned)
  check('no table in force → the rule fails loudly', (() => { try { statutoryFunctions({ at: '2019-01-01', tables: {} }, () => {}).compute_zra_paye(9000); return false } catch (e) { return /No ZM_PAYE table/.test(e.message) } })())

  // ─── Tables & access ───────────────────────────────────────
  const admin = await tokenFor('admin@marichihr.com'), finance = await tokenFor('finance@marichihr.com'), jane = await tokenFor('jane.mutale@marichihr.com'), john = await tokenFor('john.banda@marichihr.com')
  let r = await api(jane, 'GET', '/tax/tables')
  check('an employee cannot open the tax tables (403)', r.status === 403, r.status)
  r = await api(finance, 'GET', '/tax/tables')
  const list = r.body
  check('payroll admin sees every table with its source', r.status === 200 && list.length >= 5 && list.every((x) => x.sourceUrl && x.sourceNote), r.data)
  check('one version of each table is in force', ['ZM_PAYE', 'ZM_NAPSA', 'ZM_NHIMA', 'IN_TDS_NEW'].every((c) => list.filter((x) => x.code === c && x.inForce).length === 1))
  check('the 2026 NAPSA ceiling is flagged as needing confirmation', list.some((x) => x.code === 'ZM_NAPSA' && x.effectiveFrom === '2026-01-01' && x.verified === false))

  // ─── A payroll run uses the tables ─────────────────────────
  const [y, m] = MONTH.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
  let cycle = await prisma.payrollCycle.findFirst({ where: { tenantId: admin.tenantId, payPeriodStart: new Date(`${MONTH}-01T00:00:00Z`) } })
  if (cycle && !['draft', 'processing', 'review'].includes(cycle.status)) throw new Error(`${MONTH} is already ${cycle.status}; set TAX_MONTH to an unused month`)
  if (cycle) await prisma.payrollCycle.update({ where: { id: cycle.id }, data: { status: 'draft' } })
  else cycle = (await api(admin, 'POST', '/payroll/cycles', { payPeriodStart: `${MONTH}-01`, payPeriodEnd: last })).body
  await api(admin, 'POST', `/payroll/cycles/${cycle.id}/lock-attendance`)
  r = await api(admin, 'POST', `/payroll/cycles/${cycle.id}/run`)
  check('payroll runs with the statutory tables', r.status === 200 && r.body.status === 'review', r.data)
  const slips = await prisma.payslip.findMany({ where: { payrollCycleId: cycle.id }, include: { lines: true } })
  const zm = slips.filter((s) => s.lines.some((l) => l.code === 'PAYE_ZM'))
  check('there are Zambian payslips to check', zm.length > 0, slips.length)
  const amt = (s, code) => Number(s.lines.find((l) => l.code === code)?.amount ?? NaN)
  const bad = zm.filter((s) => {
    const gross = Number(s.grossEarnings), basic = s.lines.filter((l) => l.category === 'BASIC').reduce((a, l) => a + Number(l.amount), 0)
    return amt(s, 'PAYE_ZM') !== round(bandTax(gross, tables.ZM_PAYE.bands)) || amt(s, 'NAPSA_EMP') !== round(Math.min(gross, 37236) * 0.05) || (s.lines.some((l) => l.code === 'NHIMA_EMP') && amt(s, 'NHIMA_EMP') !== round(basic * 0.01))
  })
  check('every Zambian payslip: PAYE on gross per the 2026 bands, NAPSA 5% to the ceiling, NHIMA 1% of basic', bad.length === 0, bad.map((s) => ({ gross: s.grossEarnings, paye: amt(s, 'PAYE_ZM'), napsa: amt(s, 'NAPSA_EMP') })))

  // ─── Statutory return ──────────────────────────────────────
  r = await api(john, 'GET', `/tax/filing?cycleId=${cycle.id}`)
  check('a manager cannot see the statutory return (403)', r.status === 403, r.status)
  r = await api(finance, 'GET', `/tax/filing?cycleId=${cycle.id}`)
  const f = r.body
  const dbPaye = zm.reduce((a, s) => a + amt(s, 'PAYE_ZM'), 0)
  check('statutory return: one row per payslip, PAYE total matches the payslips', r.status === 200 && f.rows.length === slips.length && Math.abs(f.totals.PAYE_ZM - dbPaye) < 0.01, { report: f?.totals, db: dbPaye })
  check('…and includes the employer NAPSA share', f.columns.some((c) => c.code === 'NAPSA_EMPLOYER'), f.columns)
  const res = await fetch(`${BASE}/tax/filing/export?cycleId=${cycle.id}`, { headers: { Authorization: `Bearer ${finance.token}` } })
  const csv = await res.text()
  check('CSV export with a totals row', res.status === 200 && csv.includes('Employee,Code') && csv.trim().split('\r\n').pop().startsWith('Total'), csv.slice(0, 200))
  check('…audit-logged', !!(await prisma.auditLog.findFirst({ where: { action: 'STATUTORY_RETURN_EXPORTED', entityId: cycle.id } })))
  const foreign = await prisma.payrollCycle.findFirst({ where: { tenant: { slug: { not: 'marichi-labs' } } } })
  if (foreign) {
    r = await api(finance, 'GET', `/tax/filing?cycleId=${foreign.id}`)
    check("another company's payroll run is invisible (404)", r.status === 404, r.status)
  }

  // ─── Annual statement ──────────────────────────────────────
  r = await api(john, 'GET', '/tax/statement?year=2026')
  const st = r.body
  const dbSlips = await prisma.payslip.findMany({ where: { employeeId: john.employeeId, payrollCycle: { status: { in: ['approved', 'disbursed'] }, payPeriodStart: { gte: new Date('2026-01-01'), lt: new Date('2027-01-01') } } } })
  check('an employee gets their own annual statement from finalised runs only', r.status === 200 && st.months.length === dbSlips.length && Math.abs(st.totals.gross - dbSlips.reduce((a, s) => a + Number(s.grossEarnings), 0)) < 0.01, { months: st?.months?.length, db: dbSlips.length })
  check('the open run is not on it', !st.months.some((x) => x.month === MONTH))
  r = await api(jane, 'GET', `/tax/statement?year=2026&employeeId=${john.employeeId}`)
  check("an employee cannot read a colleague's statement (404)", r.status === 404, r.status)
  r = await api(finance, 'GET', `/tax/statement?year=2026&employeeId=${john.employeeId}`)
  check('payroll admin can', r.status === 200 && r.body.employee.employeeCode, r.status)
  r = await api(finance, 'GET', `/tax/statement?year=2026&basis=april&employeeId=${john.employeeId}`)
  check('India-style April–March year', r.status === 200 && r.body.period.from === '2026-04-01' && r.body.period.to === '2027-03-31', r.body?.period)

  // ─── Cleanup ───────────────────────────────────────────────
  const ids = slips.map((s) => s.id)
  await prisma.payslipLine.deleteMany({ where: { payslipId: { in: ids } } })
  await prisma.payslipWorkedDay.deleteMany({ where: { payslipId: { in: ids } } }).catch(() => {})
  await prisma.payslip.deleteMany({ where: { id: { in: ids } } })
  await prisma.payrollCycle.delete({ where: { id: cycle.id } }).catch((e) => console.log('cycle left in place:', e.message.split('\n').pop()))
  await done()
})()

function round(n) { return Math.round((n + Number.EPSILON) * 100) / 100 }
