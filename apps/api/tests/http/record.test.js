// Full employee record: form builder rules, who sees and edits which part, masters on every field, nominee
// shares, identities (encrypted, masked, reveal audited, duplicates, verification), position history with
// "who was the boss on that day", future-dated changes via the daily job, custom fields, rehire check, isolation.
const jwt = require('jsonwebtoken')
const { Redis } = require('ioredis')
const { api, tokenFor, check, done, prisma } = require('./lib')

const TAG = `rc${Date.now() % 1e7}`
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 })
const ymd = (d) => d.toISOString().slice(0, 10)
const today = ymd(new Date())
const sign = (u, roles) => ({ token: jwt.sign({ userId: u.userId, tenantId: u.tenantId, employeeId: u.id, roleIds: roles, email: u.workEmail }, process.env.JWT_ACCESS_SECRET, { expiresIn: '1h' }) })

;(async () => {
  const keys = await redis.keys('signup:*'); if (keys.length) await redis.del(...keys)
  const email = `owner.${TAG}@example.com`
  let r = await api(null, 'POST', '/auth/signup', { companyName: `Record ${TAG}`, fullName: 'Rae Owner', email, password: 'Owner-pass-123' })
  const owner = { token: r.body.accessToken }
  const tenant = await prisma.tenant.findFirst({ where: { users: { some: { email } } } })
  const ownerEmp = await prisma.employee.findFirst({ where: { tenantId: tenant.id } })
  const root = await prisma.orgUnit.findFirst({ where: { tenantId: tenant.id, parentId: null } })
  const add = async (first, managerId) => (await api(owner, 'POST', '/employees', { firstName: first, lastName: TAG, workEmail: `${first.toLowerCase()}.${TAG}@example.com`, orgUnitId: root.id, hireDate: '2026-01-05', employmentType: 'full_time', ...(managerId && { managerId }) })).body.employee
  const A = await add('Ada'), B = await add('Ben', A.id)
  const tA = sign(A, ['employee', 'manager']), tB = sign(B, ['employee'])
  check('a new person starts their position history ("Joined")', (await prisma.employeePositionHistory.count({ where: { employeeId: B.id, reason: 'Joined' } })) === 1)

  // ─── Form builder ──────────────────────────────────────────
  r = await api(tB, 'GET', '/employees/form-settings')
  check('everyone can read the form settings; core fields are locked', r.status === 200 && r.body.fields.length > 25 && r.body.fields.find((f) => f.key === 'firstName').locked, r.body?.fields?.length)
  r = await api(owner, 'PUT', '/employees/form-settings', { fields: [{ field: 'firstName', mode: 'hidden', employeeCanEdit: false }] })
  check('a locked field cannot be hidden (400)', r.status === 400, r.status)
  r = await api(tB, 'PUT', '/employees/form-settings', { fields: [{ field: 'religion', mode: 'display', employeeCanEdit: true }] })
  check('an employee cannot change the form (403)', r.status === 403, r.status)
  r = await api(owner, 'PUT', '/employees/form-settings', { fields: [{ field: 'religion', mode: 'display', employeeCanEdit: true }, { field: 'mobilePersonal', mode: 'mandatory', employeeCanEdit: true }, { field: 'education', mode: 'display', employeeCanEdit: false }] })
  check('HR sets fields to display / mandatory and who may edit them', r.status === 200 && r.body.fields.find((f) => f.key === 'mobilePersonal').mode === 'mandatory', r.data)

  // ─── Self-service edits ────────────────────────────────────
  r = await api(tB, 'GET', `/employees/${B.id}/record`)
  check('my record says what the company still needs from me', r.status === 200 && r.body.missing.includes('Personal mobile') && r.body.missing.includes('Emergency contacts') && r.body.can.edit.maritalStatus === true && r.body.can.edit.gender === false, r.body?.missing)
  r = await api(tB, 'PATCH', `/employees/${B.id}/record`, { values: { maritalStatus: 'married', bloodGroup: 'o_pos', languages: ['english', 'bemba'], mobilePersonal: '+260977000111' } })
  check('I update what employees may edit', r.status === 200 && r.body.values.maritalStatus === 'married' && r.body.values.languages.length === 2 && !r.body.missing.includes('Personal mobile'), r.data)
  r = await api(tB, 'PATCH', `/employees/${B.id}/record`, { values: { gender: 'male' } })
  check('…but not what HR keeps for itself (403)', r.status === 403, r.status)
  r = await api(tB, 'PATCH', `/employees/${B.id}/record`, { values: { maritalStatus: 'complicated' } })
  check('values must come from the masters (400)', r.status === 400, r.status)
  r = await api(tB, 'PATCH', `/employees/${B.id}/record`, { values: { mobilePersonal: '' } })
  check('a mandatory field cannot be emptied (400)', r.status === 400, r.status)
  r = await api(tB, 'PATCH', `/employees/${B.id}/record`, { values: { employmentType: 'part_time' } })
  check('employment type changes only through position history (400)', r.status === 400, r.status)
  r = await api(tB, 'POST', `/employees/${B.id}/record/emergencyContacts`, { name: 'Bea', relationship: 'spouse', phone: '+260977000222' })
  check('I add an emergency contact', r.status === 201, r.data)
  r = await api(tB, 'POST', `/employees/${B.id}/record/education`, { qualification: 'bachelors', institute: 'UNZA' })
  check('a section turned off for employees is refused (403)', r.status === 403, r.status)
  r = await api(owner, 'POST', `/employees/${B.id}/record/education`, { qualification: 'bachelors', institute: 'UNZA', startYear: 2015, endYear: 2019 })
  check('…HR can still fill it', r.status === 201, r.data)
  r = await api(tB, 'POST', `/employees/${B.id}/record/family`, { name: 'Kid', relationship: 'son', dateOfBirth: '2020-02-02', nomineeShare: 60 })
  const kid = r.body
  r = await api(tB, 'POST', `/employees/${B.id}/record/family`, { name: 'Mum', relationship: 'mother', nomineeShare: 50 })
  check('nominee shares cannot pass 100% (400)', r.status === 400 && /100%/.test(r.data.message), r.data)
  r = await api(tB, 'PATCH', `/employees/${B.id}/record/family/${kid.id}`, { nomineeShare: 50 })
  r = await api(tB, 'POST', `/employees/${B.id}/record/family`, { name: 'Mum', relationship: 'mother', nomineeShare: 50 })
  check('…exactly 100% is fine', r.status === 201, r.data)
  await api(tB, 'POST', `/employees/${B.id}/record/addresses`, { kind: 'present', line1: 'Plot 1', city: 'Lusaka', country: 'zm' })
  await api(tB, 'POST', `/employees/${B.id}/record/addresses`, { kind: 'present', line1: 'Plot 2', city: 'Lusaka', country: 'ZM' })
  const addr = await prisma.employeeAddress.findMany({ where: { employeeId: B.id } })
  check('one address per kind (a second "present" replaces the first)', addr.length === 1 && addr[0].line1 === 'Plot 2')
  r = await api(owner, 'POST', `/employees/${B.id}/record/previousEmployment`, { company: 'Old Co', fromDate: '2020-01-01', toDate: '2019-01-01' })
  check('dates must run forwards (400)', r.status === 400, r.status)

  // ─── Manager view ──────────────────────────────────────────
  r = await api(tA, 'GET', `/employees/${B.id}/record`)
  check("a manager sees the non-sensitive record of their report", r.status === 200 && r.body.can.seeSensitive === false && r.body.values.maritalStatus === undefined && r.body.values.dateOfBirth === undefined && r.body.family.length === 0 && r.body.addresses.length === 0 && r.body.emergencyContacts.length === 1 && r.body.education.length === 1, r.body?.values)
  r = await api(tA, 'PATCH', `/employees/${B.id}/record`, { values: { preferredName: 'Benny' } })
  check('…and cannot edit it (403)', r.status === 403, r.status)
  r = await api(tB, 'GET', `/employees/${A.id}/record`)
  check("an employee cannot open their manager's record (404)", r.status === 404, r.status)

  // ─── Identities ────────────────────────────────────────────
  r = await api(tB, 'POST', `/employees/${B.id}/identities`, { documentType: 'passport', number: 'ZN 123456', issueDate: '2022-01-01', expiryDate: '2032-01-01', issuingCountry: 'zm' })
  const pass = r.body
  check('I add my passport; only the last 4 digits come back', r.status === 201 && pass.numberMasked === '•••• 3456' && !JSON.stringify(r.data).includes('ZN 123456'), r.data)
  const stored = await prisma.employeeIdentity.findUnique({ where: { id: pass.id } })
  check('the number is stored encrypted', stored.numberEnc.startsWith('v1:') && !stored.numberEnc.includes('123456'))
  r = await api(owner, 'POST', `/employees/${A.id}/identities`, { documentType: 'passport', number: 'zn-123456' })
  check('the same number on someone else is refused, however it is typed (409)', r.status === 409, r.data)
  r = await api(tB, 'POST', `/employees/${B.id}/identities/${pass.id}/reveal`)
  check('only HR can see the full number (403)', r.status === 403, r.status)
  r = await api(owner, 'POST', `/employees/${B.id}/identities/${pass.id}/reveal`)
  check('HR reveals it…', r.status === 200 && r.body.number === 'ZN 123456', r.data)
  check('…and the look is audit-logged', !!(await prisma.auditLog.findFirst({ where: { tenantId: tenant.id, action: 'IDENTITY_REVEALED', entityId: B.id } })))
  r = await api(owner, 'POST', `/employees/${B.id}/identities/${pass.id}/verify`)
  check('HR marks it verified', r.status === 200 && r.body.verified, r.data)
  r = await api(tB, 'PATCH', `/employees/${B.id}/identities/${pass.id}`, { number: 'ZN 654321' })
  check('changing the number clears the verification', r.status === 200 && r.body.verified === false, r.data)
  r = await api(owner, 'POST', `/employees/${ownerEmp.id}/identities`, { documentType: 'national_id', number: '111111/11/1' })
  r = await api(owner, 'POST', `/employees/${ownerEmp.id}/identities/${r.body.id}/verify`)
  check('nobody verifies their own documents (403)', r.status === 403, r.status)

  // ─── Position history ──────────────────────────────────────
  r = await api(owner, 'POST', `/employees/${B.id}/position`, { effectiveFrom: today, managerId: ownerEmp.id, reason: 'Team change' })
  check('HR moves Ben to a new manager from today', r.status === 201 && r.body.applied && (await prisma.employee.findUnique({ where: { id: B.id } })).managerId === ownerEmp.id, r.data)
  const yesterday = ymd(new Date(Date.now() - 86400000))
  const before = (await api(owner, 'GET', `/employees/${B.id}/manager-on?date=${yesterday}`)).body
  const now = (await api(owner, 'GET', `/employees/${B.id}/manager-on?date=${today}`)).body
  check('"who was the boss on that day" answers both ways', before?.id === A.id && now?.id === ownerEmp.id, { before, now })
  r = await api(owner, 'POST', `/employees/${ownerEmp.id}/position`, { effectiveFrom: today, managerId: B.id, reason: 'Loop' })
  check('a reporting loop is refused (400)', r.status === 400, r.data)
  r = await api(owner, 'POST', `/employees/${B.id}/position`, { effectiveFrom: '2025-12-01', managerId: A.id, reason: 'Too early' })
  check('a change cannot start before the joining date (400)', r.status === 400, r.status)
  const ops = (await api(owner, 'POST', '/employees/org-units', { name: `Ops ${TAG}`, type: 'department', parentId: root.id })).body
  const future = ymd(new Date(Date.now() + 5 * 86400000))
  r = await api(owner, 'POST', `/employees/${B.id}/position`, { effectiveFrom: future, orgUnitId: ops.id, employmentType: 'part_time', reason: 'Transfer' })
  check('a future-dated change waits', r.status === 201 && !r.body.applied && (await prisma.employee.findUnique({ where: { id: B.id } })).orgUnitId === root.id, r.data)
  await prisma.employeePositionHistory.update({ where: { id: r.body.id }, data: { effectiveFrom: new Date(`${today}T00:00:00Z`) } })
  const job = await api(owner, 'POST', '/system/jobs/position-changes/run')
  const moved = await prisma.employee.findUnique({ where: { id: B.id } })
  check('…and the daily job applies it on the day', job.status === 200 && moved.orgUnitId === ops.id && moved.employmentType === 'part_time', { job: job.data, moved: moved.orgUnitId })
  r = await api(owner, 'GET', `/employees/${B.id}/record`)
  check('the record lists the history with names', r.body.positionHistory.length >= 3 && r.body.positionHistory.some((h) => h.department === `Ops ${TAG}`) && r.body.positionHistory.some((h) => h.manager?.startsWith('Ada')), r.body.positionHistory)

  // ─── Custom fields ─────────────────────────────────────────
  r = await api(owner, 'POST', '/employees/custom-fields', { label: 'T-shirt size', type: 'list', options: [{ code: 's', label: 'Small' }, { code: 'm', label: 'Medium' }] })
  check('HR adds a custom field', r.status === 201 && r.body.key === 't_shirt_size', r.data)
  r = await api(owner, 'POST', '/employees/custom-fields', { label: 'First name', type: 'text' })
  check("a custom field can't reuse a standard field's name (409)", r.status === 409, r.status)
  r = await api(owner, 'PATCH', `/employees/${B.id}/record`, { customFields: { t_shirt_size: 'xxl' } })
  check('custom values are checked (400)', r.status === 400, r.status)
  r = await api(owner, 'PATCH', `/employees/${B.id}/record`, { customFields: { t_shirt_size: 'm' } })
  check('…and saved', r.status === 200 && r.body.customFields.t_shirt_size === 'm', r.data)

  // ─── Required on create ────────────────────────────────────
  await api(owner, 'PUT', '/employees/form-settings', { fields: [{ field: 'dateOfBirth', mode: 'mandatory', employeeCanEdit: false }] })
  r = await api(owner, 'POST', '/employees', { firstName: 'Cy', lastName: TAG, workEmail: `cy.${TAG}@example.com`, orgUnitId: root.id, hireDate: '2026-01-05', employmentType: 'full_time' })
  check('a field set to Required must be filled when adding someone (400)', r.status === 400 && /Date of birth/.test(r.data.message), r.data)
  r = await api(owner, 'POST', '/employees/import', { rows: [{ first_name: 'Cy', last_name: TAG, work_email: `cy.${TAG}@example.com`, hire_date: '2026-01-05', department: root.name }], dryRun: false })
  check('…bulk import follows the same rule, already in Check file', r.body.created === 0 && r.body.rows[0].errors.some((e) => /date_of_birth is required/.test(e)), r.body?.rows?.[0])

  // ─── Rehire check & isolation ──────────────────────────────
  r = await api(owner, 'POST', '/employees/rehire-check', { firstName: 'ben', lastName: TAG.toUpperCase() })
  check('the add-person check finds someone with the same name', r.status === 200 && r.body.some((x) => x.id === B.id), r.data)
  r = await api(owner, 'POST', '/employees/rehire-check', { firstName: 'Someone', lastName: 'Else', identities: [{ documentType: 'passport', number: 'zn654321' }] })
  check('…or the same passport under another name', r.body.some((x) => x.id === B.id && /passport/.test(x.match)), r.data)
  const admin = await tokenFor('admin@marichihr.com')
  r = await api(admin, 'GET', `/employees/${B.id}/record`)
  check("another company's record is invisible (404)", r.status === 404, r.status)

  await prisma.tenant.update({ where: { id: tenant.id }, data: { active: false } })
  await prisma.user.updateMany({ where: { tenantId: tenant.id }, data: { active: false } })
  redis.disconnect()
  await done()
})()
