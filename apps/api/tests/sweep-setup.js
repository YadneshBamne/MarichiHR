// Local bug-sweep company: a fresh signup plus one person per role, with test logins written to C:\marichiHR-seed.
// Run with the API up: node -r dotenv/config tests/sweep-setup.js
const crypto = require('crypto')
const fs = require('fs')
const { api, prisma } = require('./http/lib')

;(async () => {
  const tag = `sw${Date.now() % 1e6}`
  const pw = () => `Sweep-${crypto.randomBytes(6).toString('hex')}-9a`
  const founder = { email: `founder.${tag}@example.com`, password: pw() }
  let r = await api(null, 'POST', '/auth/signup', { companyName: `Sweep Co ${tag}`, fullName: 'Fola Founder', email: founder.email, password: founder.password })
  if (r.status !== 201) throw new Error(`signup ${r.status} ${JSON.stringify(r.data)}`)
  const owner = { token: r.body.accessToken }
  const tenant = await prisma.tenant.findFirst({ where: { users: { some: { email: founder.email } } } })
  const root = await prisma.orgUnit.findFirst({ where: { tenantId: tenant.id, parentId: null } })
  const people = [
    ['Hana', 'HR', ['hr_admin']], ['Pia', 'PayrollOne', ['payroll_admin']], ['Paz', 'PayrollTwo', ['payroll_admin']],
    ['Mike', 'Manager', ['manager']], ['Ella', 'Employee', []],
  ]
  const out = { tenant: tenant.slug, founder, users: {} }
  let managerId = null
  for (const [first, last, roles] of people) {
    const email = `${first.toLowerCase()}.${tag}@example.com`
    const x = await api(owner, 'POST', '/employees', { firstName: first, lastName: last, workEmail: email, orgUnitId: root.id, hireDate: '2025-02-03', employmentType: 'full_time', ...(first === 'Ella' && managerId && { managerId }) })
    const emp = x.body.employee ?? x.body
    if (first === 'Mike') managerId = emp.id
    const password = pw()
    const a = await api(owner, 'PUT', `/employees/${emp.id}/access`, { roles: ['employee', ...roles], password, loginEnabled: true })
    if (a.status !== 200) throw new Error(`access ${first} ${a.status} ${JSON.stringify(a.data)}`)
    out.users[last] = { email, password }
  }
  fs.writeFileSync('C:/marichiHR-seed/sweep-company.json', JSON.stringify(out, null, 2))
  console.log('company', tenant.slug, 'roles:', Object.keys(out.users).join(', '))
  await prisma.$disconnect()
})().catch((e) => { console.error(e.message); process.exit(1) })
