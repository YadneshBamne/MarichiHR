// Report builder: field catalog by role (pay columns only for salary roles, custom fields included), preview with
// filters and grouping, saved reports run with the viewer's own permissions, CSV export, tenant isolation.
const { api, tokenFor, withRoles, check, done, prisma } = require('./lib')

;(async () => {
  const hr = await tokenFor('admin@marichihr.com') // hr_admin + system_admin
  const admin = withRoles(hr, 'payroll_admin') // the same person as a Payroll admin, who sees pay columns
  const finance = await tokenFor('finance@marichihr.com') // payroll_admin
  const john = await tokenFor('john.banda@marichihr.com') // manager
  const created = []

  let r = await api(hr, 'GET', '/reports/builder/fields')
  check('an HR admin builds reports but gets no pay columns', r.status === 200 && !(r.body ?? []).some((f) => f.key === 'current_wage'), r.status)
  r = await api(admin, 'GET', '/reports/builder/fields')
  const keys = (r.body ?? []).map((f) => f.key)
  check('a Payroll admin sees standard, pay and custom fields', r.status === 200 && keys.includes('department') && keys.includes('current_wage') && keys.includes('gender'), keys.length)
  r = await api(john, 'GET', '/reports/builder/fields')
  check('a manager cannot build reports (403)', r.status === 403, r.status)

  const def = { name: `People ${Date.now()}`, columns: ['employee_id', 'name', 'department', 'hire_date', 'current_wage'], filters: { status: 'active' } }
  r = await api(admin, 'POST', '/reports/builder/preview', def)
  const active = await prisma.employee.count({ where: { tenantId: admin.tenantId, active: true } })
  check(`preview lists every active person (${active}) with the chosen columns`, r.status === 200 && r.body.rows.length === Math.min(active, 5000) && r.body.columns.map((c) => c.key).join() === def.columns.join(), r.body?.columns)
  const emp1 = r.body.rows.find((x) => x.employee_id === 'EMP0001')
  check('rows carry readable values (department name, date, wage number)', emp1 && typeof emp1.department === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(emp1.hire_date), emp1)
  check('a total monthly wage tile appears with a pay column', r.body.summary.some((s) => s.label === 'Total monthly wage'))

  r = await api(admin, 'POST', '/reports/builder/preview', { ...def, groupBy: 'department' })
  check('grouping returns one row per department with counts that add up', r.status === 200 && r.body.columns[1].key === 'count' && r.body.rows.reduce((s, x) => s + x.count, 0) === r.body.summary[0].value, r.body?.rows?.slice(0, 3))
  r = await api(admin, 'POST', '/reports/builder/preview', { ...def, groupBy: 'name' })
  check('cannot group by a free-text column (400)', r.status === 400, r.data)
  r = await api(admin, 'POST', '/reports/builder/preview', { ...def, columns: ['bank_account'] })
  check('unknown columns are refused (400)', r.status === 400, r.data)
  const dept = await prisma.orgUnit.findFirst({ where: { tenantId: admin.tenantId, employees: { some: { active: true } } } })
  r = await api(admin, 'POST', '/reports/builder/preview', { ...def, filters: { status: 'active', departmentIds: [dept.id] } })
  check('a department filter keeps only that department', r.status === 200 && r.body.rows.every((x) => x.department === dept.name), dept.name)

  // ─── Saved reports ─────────────────────────────────────────
  r = await api(admin, 'POST', '/reports/builder/saved', def)
  created.push(r.body?.id)
  check('HR saves the report', r.status === 201 && r.body.columns.length === 5, r.data)
  const id = r.body.id
  r = await api(admin, 'GET', `/reports/builder/saved/${id}/run`)
  check('running it returns the same table', r.status === 200 && r.body.title === def.name && r.body.columns.length === 5, r.data)
  const compliance = { ...admin, roleIds: ['compliance_officer'] }
  const jwt = require('jsonwebtoken')
  const compToken = { token: jwt.sign({ userId: admin.userId, tenantId: admin.tenantId, employeeId: admin.employeeId, roleIds: compliance.roleIds, email: 'admin@marichihr.com' }, process.env.JWT_ACCESS_SECRET, { expiresIn: '5m' }) }
  r = await api(compToken, 'GET', `/reports/builder/saved/${id}/run`)
  check('a compliance officer running it loses the pay column', r.status === 200 && !r.body.columns.some((c) => c.key === 'current_wage') && r.body.columns.length === 4, r.body?.columns)
  r = await api(compToken, 'POST', '/reports/builder/preview', def)
  check('…and cannot ask for pay columns directly (400)', r.status === 400, r.status)
  r = await api(finance, 'GET', `/reports/builder/saved/${id}/export`)
  check('payroll exports it as CSV', r.status === 200 && String(r.data).split('\r\n')[0].includes('Monthly wage'), String(r.data).slice(0, 80))
  r = await api(admin, 'PUT', `/reports/builder/saved/${id}`, { ...def, columns: ['name', 'gender'] })
  check('HR edits the columns', r.status === 200 && r.body.columns.join() === 'name,gender', r.data)

  // ─── Isolation ─────────────────────────────────────────────
  const other = await prisma.tenant.findFirst({ where: { id: { not: admin.tenantId }, active: true } })
  const otherReport = await prisma.savedReport.create({ data: { tenantId: other.id, name: 'Other', columns: ['name'], createdBy: admin.userId } })
  created.push(otherReport.id)
  r = await api(admin, 'GET', `/reports/builder/saved/${otherReport.id}/run`)
  check("another company's report is 404", r.status === 404, r.status)
  r = await api(admin, 'DELETE', `/reports/builder/saved/${id}`)
  r = await api(admin, 'GET', '/reports/builder/saved')
  check('archived reports leave the list', !r.body.some((x) => x.id === id))

  await prisma.savedReport.deleteMany({ where: { id: { in: created.filter(Boolean) } } })
  await done()
})()
