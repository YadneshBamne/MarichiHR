// ERP-agnostic accounting export: account mapping, balanced journal, split by department, every format, webhook
// address checks. Uses a paid run in marichi-labs and removes its settings at the end.
const { api, tokenFor, check, done, prisma } = require('./lib')

;(async () => {
  const fin = await tokenFor('finance@marichihr.com')
  const hr = await tokenFor('admin@marichihr.com')
  const cycle = await prisma.payrollCycle.findFirst({ where: { tenantId: fin.tenantId, status: 'disbursed', payslips: { some: {} } }, orderBy: { payPeriodStart: 'asc' } })
  check('a paid run exists to export', !!cycle)
  await prisma.accountingSettings.deleteMany({ where: { tenantId: fin.tenantId } })
  try {
    let r = await api(hr, 'GET', '/payroll/accounting/settings')
    check('HR admins without payroll cannot see the accounting settings', r.status === 403, r.status)
    r = await api(fin, 'GET', '/payroll/accounting/settings')
    check('defaults come from the standard chart', r.status === 200 && r.body.accounts.SALARY_EXPENSE.code === '5000' && r.body.splitBy === 'none' && !r.body.hasSecret, r.body)

    r = await api(fin, 'PUT', '/payroll/accounting/settings', { accounts: { SALARY_EXPENSE: { code: '6100', name: 'Staff salaries' } }, splitBy: 'department' })
    check('the company maps its own account codes', r.status === 200 && r.body.accounts.SALARY_EXPENSE.code === '6100' && r.body.accounts.NET_PAYABLE.code === '2100', r.data)
    r = await api(fin, 'PUT', '/payroll/accounting/settings', { accounts: { NOT_AN_ACCOUNT: { code: '1', name: 'x' } } })
    check('unknown posting keys are refused', r.status === 400, r.status)
    r = await api(fin, 'PUT', '/payroll/accounting/settings', { webhookUrl: 'https://127.0.0.1/hook' })
    check('the ERP address must be public', r.status === 400, r.data)

    r = await api(fin, 'GET', `/payroll/cycles/${cycle.id}/journal?format=json`)
    const j = typeof r.data === 'string' ? JSON.parse(r.data) : r.data
    const dr = j.lines.reduce((t, l) => t + Math.round(l.debit * 100), 0), cr = j.lines.reduce((t, l) => t + Math.round(l.credit * 100), 0)
    check('the journal balances', r.status === 200 && dr === cr && dr > 0, { dr, cr })
    check('lines post to the mapped code and carry the department', j.lines.some((l) => l.accountCode === '6100') && j.lines.every((l) => l.dimension), j.lines.slice(0, 2))
    const slips = await prisma.payslip.aggregate({ where: { payrollCycleId: cycle.id }, _sum: { grossEarnings: true } })
    check('salary expense equals gross pay', Math.round(j.lines.filter((l) => l.accountKey === 'SALARY_EXPENSE').reduce((t, l) => t + l.debit * 100, 0)) === Math.round(Number(slips._sum.grossEarnings) * 100))

    for (const [f, first] of [['csv', 'Date,Journal Ref,Account Code'], ['quickbooks', 'Journal No.,Journal Date,Account Name'], ['xero', '*Narration,*Date'], ['xml', '<?xml'], ['tally', '<ENVELOPE>']]) {
      r = await api(fin, 'GET', `/payroll/cycles/${cycle.id}/journal?format=${f}`)
      check(`${f} file`, r.status === 200 && String(r.data).startsWith(first) && /attachment; filename="journal-/.test(r.headers.get('content-disposition')), String(r.data).slice(0, 80))
    }
    r = await api(fin, 'GET', `/payroll/cycles/${cycle.id}/journal?format=pdf`)
    check('unknown formats are refused', r.status === 400, r.status)
    r = await api(fin, 'POST', `/payroll/cycles/${cycle.id}/journal/push`)
    check('sending needs an ERP address first', r.status === 400, r.data)
    const audit = await prisma.auditLog.count({ where: { tenantId: fin.tenantId, action: 'PAYROLL_GL_EXPORTED', entityId: cycle.id } })
    check('exports are audited', audit >= 6, audit)
  } finally {
    await prisma.accountingSettings.deleteMany({ where: { tenantId: fin.tenantId } })
  }
  await done()
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
