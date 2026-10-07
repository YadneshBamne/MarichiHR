// Role-based access: what employee, manager, payroll/finance and HR/admin can reach, and the role-shaped dashboard.
const { api, tokenFor, check, done } = require('./lib')

;(async () => {
  const admin = await tokenFor('admin@marichihr.com') // hr_admin + system_admin
  const john = await tokenFor('john.banda@marichihr.com') // manager
  const jane = await tokenFor('jane.mutale@marichihr.com') // employee, reports to John
  const finance = await tokenFor('finance@marichihr.com') // payroll_admin, no employee record
  const sections = (d) => ['self', 'team', 'company', 'payroll'].filter((k) => d[k]).join(',')

  // ─── Dashboard is shaped by role ───────────────────────────
  let r = await api(jane, 'GET', '/dashboard')
  check('employee dashboard: only their own section', r.status === 200 && sections(r.body) === 'self', sections(r.body || {}))
  check('employee dashboard carries own leave, attendance, tasks', r.body.self && 'leave' in r.body.self && 'attendance' in r.body.self && 'tasks' in r.body.self, Object.keys(r.body.self || {}))
  r = await api(john, 'GET', '/dashboard')
  check('manager dashboard: own + team (direct reports)', r.status === 200 && sections(r.body) === 'self,team' && r.body.team.scope === 'reports', sections(r.body || {}))
  check('manager team lists only people who report to them', r.body.team.people.every((p) => p.id !== john.employeeId) && r.body.team.people.some((p) => p.id === jane.employeeId), r.body.team.people.map((p) => p.name))
  r = await api(finance, 'GET', '/dashboard')
  check('payroll/finance dashboard: payroll only (no employee record, no team, no company)', r.status === 200 && sections(r.body) === 'payroll', sections(r.body || {}))
  r = await api(admin, 'GET', '/dashboard')
  check('HR/admin dashboard: own + company-wide team + company + payroll', r.status === 200 && sections(r.body) === 'self,team,company,payroll' && r.body.team.scope === 'company', sections(r.body || {}))
  check('company section has headcount and departments', r.body.company.headcount > 0 && Array.isArray(r.body.company.departments), r.body.company)

  r = await api(jane, 'GET', '/dashboard/counts')
  check('employee has no approvals waiting by definition', r.status === 200 && r.body.approvals === 0, r.body)
  r = await api(john, 'GET', '/dashboard/counts')
  check('manager counts load', r.status === 200 && typeof r.body.approvals === 'number', r.body)

  // ─── Team-only endpoints refuse plain employees ────────────
  for (const [path, label] of [['/attendance/team/today', 'team attendance today'], ['/leave/calendar/team?startDate=2026-10-01&endDate=2026-10-31', 'team leave calendar'], ['/leave/requests/pending', 'leave approvals inbox'], ['/attendance/regularisations/pending', 'attendance approvals inbox'], ['/expenses/claims/pending', 'expense approvals inbox'], ['/employees', 'employee directory'], ['/payroll/cycles', 'payroll cycles'], ['/salary/structures', 'salary structures'], ['/system/jobs', 'scheduled jobs'], ['/exits', 'offboarding list']]) {
    r = await api(jane, 'GET', path)
    check(`employee cannot open ${label} (403)`, r.status === 403, r.data)
  }
  // ...but their own data works
  for (const path of ['/leave/balances/me', '/attendance/today', '/payroll/payslips/me', '/expenses/claims/me', '/activities/mine']) {
    r = await api(jane, 'GET', path)
    check(`employee can open their own ${path}`, r.status === 200, r.data)
  }

  // ─── Managers: team views yes, payroll administration no ───
  for (const path of ['/attendance/team/today', '/leave/calendar/team?startDate=2026-10-01&endDate=2026-10-31', '/leave/requests/pending', '/employees']) {
    r = await api(john, 'GET', path)
    check(`manager can open ${path.split('?')[0]}`, r.status === 200, r.data)
  }
  r = await api(john, 'GET', '/employees?limit=100')
  check('manager directory is limited to themselves and their reports', r.status === 200 && r.body.every((e) => [john.employeeId, jane.employeeId].includes(e.id) || e.managerId === john.employeeId || e.manager?.id === john.employeeId), r.body?.map((e) => e.employeeCode))
  for (const path of ['/payroll/cycles', '/salary/structures', '/exits', '/system/jobs', '/company/modules']) {
    r = await api(john, path === '/company/modules' ? 'PUT' : 'GET', path, path === '/company/modules' ? { modules: [] } : undefined)
    check(`manager cannot open ${path} (403)`, r.status === 403, r.data)
  }

  // ─── Payroll/finance: payroll yes, people approvals and team views no ──
  for (const path of ['/payroll/cycles', '/salary/structures', '/expenses/claims/awaiting-finance']) {
    r = await api(finance, 'GET', path)
    check(`finance can open ${path}`, r.status === 200, r.data)
  }
  for (const path of ['/leave/requests/pending', '/attendance/team/today', '/attendance/regularisations/pending']) {
    r = await api(finance, 'GET', path)
    check(`finance cannot open ${path} (403)`, r.status === 403, r.data)
  }
  r = await api(finance, 'POST', '/employees', { firstName: 'X', lastName: 'Y', workEmail: 'x.y@example.com', orgUnitId: '00000000-0000-0000-0000-000000000000', hireDate: '2026-10-01', employmentType: 'full_time' })
  check('finance cannot add employees (403)', r.status === 403, r.data)

  // ─── HR/admin: everything ──────────────────────────────────
  for (const path of ['/attendance/team/today', '/leave/requests/pending', '/employees', '/payroll/cycles', '/system/jobs', '/exits']) {
    r = await api(admin, 'GET', path)
    check(`HR/admin can open ${path}`, r.status === 200, r.data)
  }
  await done()
})()
