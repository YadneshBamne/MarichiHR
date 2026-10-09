// Org chart: everyone in the company can see the whole reporting tree with public fields only; the "open profile"
// flag follows the profile rule (self, hr_admin, own reporting line); other companies never appear.
const { api, tokenFor, check, done, prisma } = require('./lib')

;(async () => {
  const admin = await tokenFor('admin@marichihr.com') // hr_admin + system_admin
  const john = await tokenFor('john.banda@marichihr.com') // manager of Jane
  const jane = await tokenFor('jane.mutale@marichihr.com') // employee
  const finance = await tokenFor('finance@marichihr.com') // payroll_admin, no employee record

  const expected = await prisma.employee.findMany({ where: { tenantId: admin.tenantId, active: true, employmentStatus: { not: 'terminated' } }, select: { id: true } })
  const charts = {}
  for (const [label, who] of [['HR', admin], ['manager', john], ['employee', jane], ['payroll admin', finance]]) {
    const r = await api(who, 'GET', '/employees/org-chart')
    charts[label] = r.body
    check(`${label} can open the org chart`, r.status === 200 && Array.isArray(r.body?.people), r.data)
  }
  const people = charts.HR.people
  const byId = new Map(people.map((p) => [p.id, p]))
  check('chart has every active employee of the company, once', people.length === expected.length && expected.every((e) => byId.has(e.id)), { got: people.length, expected: expected.length })
  check('everyone sees the same people', ['manager', 'employee', 'payroll admin'].every((k) => charts[k].people.length === people.length))
  check('every manager link points inside the chart (no dangling lines)', people.every((p) => p.managerId === null || byId.has(p.managerId)))
  check('Jane reports to John', byId.get(jane.employeeId)?.managerId === john.employeeId, byId.get(jane.employeeId))
  check('at least one person sits at the top', people.some((p) => p.managerId === null))
  check('departments are included', Array.isArray(charts.HR.departments) && charts.HR.departments.length > 0)

  const keys = new Set(charts.employee.people.flatMap((p) => Object.keys(p)))
  const allowed = ['id', 'name', 'title', 'department', 'departmentId', 'location', 'avatarUrl', 'managerId', 'isMe', 'canOpen']
  check('only public fields are returned (no email, phone, pay or bank data)', [...keys].every((k) => allowed.includes(k)), [...keys])

  check('HR may open every profile', charts.HR.people.every((p) => p.canOpen))
  const johnOpen = charts.manager.people.filter((p) => p.canOpen).map((p) => p.id)
  check('a manager may open themselves and their reports, not their boss', johnOpen.includes(john.employeeId) && johnOpen.includes(jane.employeeId) && !johnOpen.includes(admin.employeeId), johnOpen.length)
  const janeOpen = charts.employee.people.filter((p) => p.canOpen).map((p) => p.id)
  check('an employee may open only their own profile', janeOpen.length === 1 && janeOpen[0] === jane.employeeId, janeOpen)
  check('"isMe" marks the viewer', charts.employee.people.filter((p) => p.isMe).map((p) => p.id).join() === jane.employeeId)
  check('payroll admin without an employee record has no "me" card', charts['payroll admin'].people.every((p) => !p.isMe))

  // canOpen agrees with the real profile endpoint
  for (const p of charts.employee.people.slice(0, 6)) {
    const r = await api(jane, 'GET', `/employees/${p.id}`)
    check(`profile access matches the chart for ${p.name}`, p.canOpen ? r.status === 200 : [403, 404].includes(r.status), { canOpen: p.canOpen, status: r.status })
  }

  const others = await prisma.employee.findMany({ where: { tenantId: { not: admin.tenantId } }, select: { id: true }, take: 50 })
  check('no one from another company appears', others.every((o) => !byId.has(o.id)))
  const r = await api(null, 'GET', '/employees/org-chart')
  check('signed-out request is refused (401)', r.status === 401, r.status)
  await done()
})()
