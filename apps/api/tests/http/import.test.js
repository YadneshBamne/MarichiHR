// Bulk employee import and credentials sheets, in a throwaway company (deactivated at the end): the ID series,
// dry runs that report every problem, all-or-nothing imports, missing departments/positions/locations, managers
// inside the file (and loops), temporary passwords that must be changed, who may import, isolation.
const { Redis } = require('ioredis')
const { api, tokenFor, check, done, prisma } = require('./lib')

const TAG = `im${Date.now() % 1e7}`
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 })
const login = (email, password) => api(null, 'POST', '/auth/login', { email, password })

;(async () => {
  const keys = await redis.keys('signup:*'); if (keys.length) await redis.del(...keys)
  const ownerEmail = `owner.${TAG}@example.com`
  let r = await api(null, 'POST', '/auth/signup', { companyName: `Import ${TAG}`, fullName: 'Imo Owner', email: ownerEmail, password: 'Owner-pass-123' })
  const owner = { token: r.body.accessToken }
  const tenant = await prisma.tenant.findFirst({ where: { users: { some: { email: ownerEmail } } } })
  const ownerUser = await prisma.user.findFirst({ where: { email: ownerEmail } })

  // ─── ID series ─────────────────────────────────────────────
  r = await api(owner, 'PATCH', '/company', { employeeCodePrefix: '9x' })
  check('a prefix must start with a letter (400)', r.status === 400, r.status)
  r = await api(owner, 'PATCH', '/company', { employeeCodePrefix: 'acm-', employeeCodeDigits: 3 })
  check('HR sets the ID series to ACM-001 style', r.status === 200 && r.body.employeeCodePrefix === 'ACM-' && r.body.employeeCodeDigits === 3, r.data)

  // ─── Dry run: every problem, nothing written ───────────────
  const rows = [
    { first_name: 'Lina', last_name: 'Head', work_email: `lina.${TAG}@example.com`, hire_date: '2026-10-01', department: 'Operations', job_title: 'Head of Ops', employment_type: 'Full time', work_location: 'Lusaka HQ' },
    { first_name: 'Tom', last_name: 'Report', work_email: `tom.${TAG}@example.com`, hire_date: '15/10/2026', department: 'operations', job_title: 'Analyst', manager: `lina.${TAG}@example.com`, tax_country: 'zm' },
    { first_name: 'Ivy', last_name: 'Deep', work_email: `ivy.${TAG}@example.com`, hire_date: '2026-10-20', department: 'Operations', manager: `tom.${TAG}@example.com`, employee_id: 'CUSTOM-7' },
  ]
  r = await api(owner, 'POST', '/employees/import', { rows, dryRun: true })
  check('without "create missing", unknown departments are errors', r.status === 200 && r.body.rows.every((x) => x.errors.some((e) => /department/.test(e))), r.body?.rows)
  r = await api(owner, 'POST', '/employees/import', { rows: [...rows, { first_name: 'Bad', last_name: '', work_email: 'nope', hire_date: '31/02/2026', department: 'Operations', employment_type: 'freelance', manager: 'ghost@example.com' }, { ...rows[0], first_name: 'Dup' }], dryRun: true, createMissing: true })
  const dry = r.body
  const bad = dry.rows.find((x) => x.row === 5), dup = dry.rows.find((x) => x.row === 6)
  check('dry run lists every problem on a row', bad.errors.length >= 5 && bad.errors.some((e) => /hire_date/.test(e)) && bad.errors.some((e) => /employment_type/.test(e)) && bad.errors.some((e) => /manager/.test(e)), bad.errors)
  check('a duplicate email inside the file is caught with the other row number', dup.errors.some((e) => /row 2/.test(e)), dup.errors)
  check('dry run says which masters it would create', dry.willCreate.departments.length === 1 && dry.willCreate.positions.length === 2 && dry.willCreate.locations.length === 1, dry.willCreate)
  check('IDs come from the series, a given ID is kept', dry.rows[0].employeeCode === 'ACM-001' && dry.rows[1].employeeCode === 'ACM-002' && dry.rows[2].employeeCode === 'CUSTOM-7', dry.rows.map((x) => x.employeeCode))
  r = await api(owner, 'POST', '/employees/import', { rows: [...rows, { first_name: 'Bad', last_name: 'Row', work_email: 'nope', hire_date: '2026-10-01', department: 'Operations' }], dryRun: false, createMissing: true })
  check('one bad row → nothing is imported (all or nothing)', r.status === 200 && r.body.created === 0 && (await prisma.employee.count({ where: { tenantId: tenant.id } })) === 1, r.body?.created)

  // ─── Loops ────────────────────────────────────────────────
  r = await api(owner, 'POST', '/employees/import', { rows: [
    { first_name: 'A', last_name: 'A', work_email: `a.${TAG}@example.com`, hire_date: '2026-10-01', department: 'Operations', manager: `b.${TAG}@example.com` },
    { first_name: 'B', last_name: 'B', work_email: `b.${TAG}@example.com`, hire_date: '2026-10-01', department: 'Operations', manager: `a.${TAG}@example.com` },
  ], dryRun: true, createMissing: true })
  check('a reporting loop inside the file is refused', r.body.rows.every((x) => x.errors.some((e) => /loop/.test(e))), r.body.rows)

  // ─── Real import with logins ───────────────────────────────
  r = await api(owner, 'POST', '/employees/import', { rows, dryRun: false, createMissing: true, grantLogin: true })
  const res = r.body
  check('all three are created', r.status === 200 && res.created === 3 && res.rows.every((x) => x.status === 'created'), res?.rows)
  const people = await prisma.employee.findMany({ where: { tenantId: tenant.id }, include: { orgUnit: true, jobPosition: true, workLocation: true } })
  const by = (code) => people.find((p) => p.employeeCode === code)
  const lina = by('ACM-001'), tom = by('ACM-002'), ivy = by('CUSTOM-7')
  check('managers are linked, including two levels down the file', tom.managerId === lina.id && ivy.managerId === tom.id && !lina.managerId)
  check('missing masters were created once and shared (case-insensitive)', lina.orgUnitId === tom.orgUnitId && lina.orgUnit.name === 'Operations' && lina.workLocation?.name === 'Lusaka HQ' && tom.jobPosition?.title === 'Analyst')
  check('dates and types are read correctly (15/10/2026, "Full time", zm)', tom.hireDate.toISOString().startsWith('2026-10-15') && lina.employmentType === 'full_time' && tom.taxJurisdiction === 'ZM')
  check('a credentials sheet comes back once, one line per person', res.credentials?.length === 3 && res.credentials.every((c) => c.temporaryPassword && c.email), res.credentials?.map((c) => c.email))
  const tomCred = res.credentials.find((c) => c.employeeCode === 'ACM-002')
  r = await login(tomCred.email, tomCred.temporaryPassword)
  check('the temporary password signs in and must be changed first', r.status === 200 && r.body.user?.mustChangePassword === true, r.data)
  check('…and is only stored hashed', !(await prisma.user.findFirst({ where: { email: tomCred.email } })).passwordHash.includes(tomCred.temporaryPassword))
  check('the import and the sheet are in the audit log', (await prisma.auditLog.count({ where: { tenantId: tenant.id, action: { in: ['EMPLOYEES_IMPORTED', 'CREDENTIALS_SHEET_ISSUED'] } } })) === 2)
  r = await api(owner, 'POST', '/employees/import', { rows: [rows[0]], dryRun: true })
  check('importing the same people again is refused (already in the company)', r.body.rows[0].errors.some((e) => /already belongs/.test(e)), r.body.rows[0].errors)
  r = await api(owner, 'POST', '/employees/import', { rows: [{ ...rows[0], salary: '100' }], dryRun: true })
  check('unknown columns are refused (400)', r.status === 400, r.status)

  // ─── Credentials sheet for existing people ─────────────────
  r = await api(owner, 'POST', '/employees/access/bulk', { employeeIds: [lina.id, ivy.id] })
  check('HR re-issues passwords for chosen people', r.status === 200 && r.body.length === 2, r.data)
  r = await login(res.credentials.find((c) => c.employeeCode === 'ACM-001').email, res.credentials.find((c) => c.employeeCode === 'ACM-001').temporaryPassword)
  check('…and the old temporary password stops working', r.status === 401, r.status)
  const ownerEmp = await prisma.employee.findFirst({ where: { userId: ownerUser.id } })
  r = await api(owner, 'POST', '/employees/access/bulk', { employeeIds: [ownerEmp.id] })
  check('nobody puts their own password on a sheet (400)', r.status === 400, r.status)

  // ─── Who & isolation ───────────────────────────────────────
  const jane = await tokenFor('jane.mutale@marichihr.com'), john = await tokenFor('john.banda@marichihr.com'), admin = await tokenFor('admin@marichihr.com')
  r = await api(john, 'POST', '/employees/import', { rows: [rows[0]], dryRun: true })
  check('a manager cannot import (403)', r.status === 403, r.status)
  r = await api(jane, 'POST', '/employees/access/bulk', { employeeIds: [jane.employeeId] })
  check('an employee cannot issue passwords (403)', r.status === 403, r.status)
  r = await api(admin, 'POST', '/employees/access/bulk', { employeeIds: [tom.id] })
  check("another company's people are out of reach (404)", r.status === 404, r.status)
  const series = await api(admin, 'POST', '/employees/import', { rows: [{ ...rows[0], work_email: `x.${TAG}@example.com` }], dryRun: true, createMissing: true })
  check('each company keeps its own series (Marichi Labs is still EMP…)', /^EMP\d{4,}$/.test(series.body.rows[0].employeeCode), series.body.rows[0].employeeCode)

  // ─── Cleanup ───────────────────────────────────────────────
  await prisma.tenant.update({ where: { id: tenant.id }, data: { active: false } })
  await prisma.user.updateMany({ where: { tenantId: tenant.id }, data: { active: false } })
  redis.disconnect()
  await done()
})()
