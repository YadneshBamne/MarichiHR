// Reports: who sees which report, team scoping for managers, totals that match the database, filters, CSV export
// and isolation between companies.
const { api, tokenFor, check, done, prisma } = require('./lib')

const BASE = (process.env.API_URL || 'http://localhost:4000') + '/api/v1'
const round = (n) => Math.round(n * 100) / 100

;(async () => {
  const admin = await tokenFor('admin@marichihr.com')
  const jane = await tokenFor('jane.mutale@marichihr.com')
  const john = await tokenFor('john.banda@marichihr.com')
  const finance = await tokenFor('finance@marichihr.com')
  const keys = async (who) => ((await api(who, 'GET', '/reports')).body || []).map((r) => r.key).sort().join()

  // ─── Catalog & access ──────────────────────────────────────
  check('HR sees all six reports', (await keys(admin)) === 'attendance,attrition,expenses,headcount,leave,payroll', await keys(admin))
  check('a manager sees attendance and leave', (await keys(john)) === 'attendance,leave', await keys(john))
  check('payroll admin sees payroll and expenses', (await keys(finance)) === 'expenses,payroll', await keys(finance))
  check('an employee sees none', (await keys(jane)) === '', await keys(jane))
  for (const [who, key, label] of [[jane, 'attendance', 'employee → attendance'], [john, 'headcount', 'manager → headcount'], [john, 'payroll', 'manager → payroll'], [finance, 'attendance', 'payroll admin → attendance']]) {
    const r = await api(who, 'GET', `/reports/${key}`)
    check(`${label} is refused (403)`, r.status === 403, r.status)
  }
  let r = await api(admin, 'GET', '/reports/nope')
  check('an unknown report is 404', r.status === 404, r.status)
  r = await api(admin, 'GET', '/reports/attendance?month=2026-13')
  check('a bad month is refused (400)', r.status === 400, r.status)
  r = await api(admin, 'GET', '/reports/leave?from=2026-10-10&to=2026-10-01')
  check('a reversed date range is refused (400)', r.status === 400, r.status)

  // ─── Manager scope ─────────────────────────────────────────
  r = await api(john, 'GET', '/reports/attendance?month=2026-10')
  const names = r.body.rows.map((x) => x.code)
  const janeCode = (await prisma.employee.findUnique({ where: { id: jane.employeeId } })).employeeCode
  const johnCode = (await prisma.employee.findUnique({ where: { id: john.employeeId } })).employeeCode
  check("a manager's attendance report covers their reporting line only (Jane, not John himself)", names.includes(janeCode) && !names.includes(johnCode), names)

  // ─── Headcount ─────────────────────────────────────────────
  r = await api(admin, 'GET', '/reports/headcount')
  const hc = r.body
  check('headcount: tiles agree with the table', hc.summary[0].value === hc.rows.reduce((s, x) => s + x.headcount, 0), { tile: hc.summary[0].value })
  r = await api(admin, 'GET', '/reports/headcount?groupBy=type')
  check('headcount can be grouped by employment type', r.status === 200 && r.body.columns[0].label === 'Employment type', r.body?.columns)

  // ─── Attendance ────────────────────────────────────────────
  r = await api(admin, 'GET', '/reports/attendance?month=2026-10')
  const att = r.body
  check('attendance: one row per active person, percentages 0–100', att.rows.length > 0 && att.rows.every((x) => x.attendance >= 0 && x.attendance <= 100 && x.workingDays >= 0), att.rows.slice(0, 2))
  const dbHours = (await prisma.attendanceRecord.aggregate({ _sum: { workedHours: true }, where: { employee: { tenantId: admin.tenantId, active: true }, date: { gte: new Date('2026-10-01T00:00:00Z'), lte: new Date('2026-10-31T00:00:00Z') } } }))._sum.workedHours ?? 0
  check('attendance: hours worked match the database', Math.abs(att.summary.find((s) => s.label === 'Hours worked').value - dbHours) < 0.01, { report: att.summary.find((s) => s.label === 'Hours worked').value, db: dbHours })

  // ─── Leave ─────────────────────────────────────────────────
  r = await api(admin, 'GET', '/reports/leave')
  check("leave: balances include Jane's", r.status === 200 && r.body.rows.some((x) => x.code === janeCode), r.status)

  // ─── Payroll ───────────────────────────────────────────────
  r = await api(finance, 'GET', '/reports/payroll/cycles')
  const cycle = r.body?.[0]
  check('payroll: cycles to choose from', r.status === 200 && !!cycle, r.data)
  r = await api(finance, 'GET', `/reports/payroll?cycleId=${cycle.id}`)
  const dbNet = (await prisma.payslip.aggregate({ _sum: { netPay: true }, where: { payrollCycleId: cycle.id } }))._sum.netPay ?? 0
  const repNet = r.body.summary.find((s) => s.label === 'Net pay')?.value
  check('payroll: net pay total matches the payslips', Math.abs(repNet - round(Number(dbNet))) < 0.05, { report: repNet, db: dbNet })

  // ─── Expenses & attrition ──────────────────────────────────
  r = await api(admin, 'GET', '/reports/expenses?from=2020-01-01&to=2031-12-31')
  const dbClaims = await prisma.reimbursementClaim.count({ where: { tenantId: admin.tenantId, expenseDate: { gte: new Date('2020-01-01T00:00:00Z'), lte: new Date('2031-12-31T00:00:00Z') } } })
  check('expenses: every claim in range is listed', r.body.rows.length === dbClaims, { report: r.body.rows.length, db: dbClaims })
  r = await api(admin, 'GET', '/reports/attrition?from=2020-01-01&to=2031-12-31')
  check('attrition: report loads with a rate', r.status === 200 && typeof r.body.summary.find((s) => s.label === 'Attrition rate').value === 'number', r.data)

  // ─── Export & isolation ────────────────────────────────────
  const res = await fetch(`${BASE}/reports/attendance/export?month=2026-10`, { headers: { Authorization: `Bearer ${admin.token}` } })
  const csv = await res.text()
  check('CSV export with header row and HH:MM:SS hours', res.status === 200 && csv.includes('Employee,Code,Department') && /\d{2}:\d{2}:\d{2}/.test(csv), csv.slice(0, 160))
  check('…and the export is audit-logged', !!(await prisma.auditLog.findFirst({ where: { tenantId: admin.tenantId, action: 'REPORT_EXPORTED', entityId: 'attendance', createdAt: { gte: new Date(Date.now() - 60_000) } } })))
  const foreignUnit = await prisma.orgUnit.findFirst({ where: { tenant: { slug: { not: 'marichi-labs' } } } })
  r = await api(admin, 'GET', `/reports/headcount?departmentId=${foreignUnit.id}`)
  check("filtering by another company's department returns nothing of theirs", r.status === 200 && r.body.summary[0].value === 0, r.body?.summary)
  await done()
})()
