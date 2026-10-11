// Master engine: every company starts with the default lists, admins add/rename/retire/reorder values, every
// dropdown-backed field only accepts active values of its list, imports read labels, isolation. Throwaway company.
const { Redis } = require('ioredis')
const { api, tokenFor, check, done, prisma } = require('./lib')

const TAG = `mv${Date.now() % 1e7}`
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 })

;(async () => {
  const keys = await redis.keys('signup:*'); if (keys.length) await redis.del(...keys)
  const email = `owner.${TAG}@example.com`
  let r = await api(null, 'POST', '/auth/signup', { companyName: `Masters ${TAG}`, fullName: 'Mia Owner', email, password: 'Owner-pass-123' })
  const owner = { token: r.body.accessToken }
  const tenant = await prisma.tenant.findFirst({ where: { users: { some: { email } } } })
  const root = await prisma.orgUnit.findFirst({ where: { tenantId: tenant.id, parentId: null } })
  const list = async (key, all) => (await api(owner, 'GET', `/masters${all ? '?all=1' : ''}`)).body.find((l) => l.key === key)

  // ─── Defaults ──────────────────────────────────────────────
  r = await api(owner, 'GET', '/masters')
  const keysSeen = r.body.map((l) => l.key)
  check('a new company starts with every list and its defaults', r.status === 200 && ['gender', 'marital_status', 'blood_group', 'nationality', 'relationship', 'qualification', 'identity_document', 'document_category', 'employment_type', 'source_of_hire', 'exit_type', 'exit_reason', 'bank'].every((k) => keysSeen.includes(k)) && r.body.find((l) => l.key === 'gender').values.length === 4, keysSeen)
  check('exit types carry who ends employment', (await list('exit_type')).values.find((x) => x.code === 'resignation').meta.endedBy === 'employee')

  // ─── Edit ──────────────────────────────────────────────────
  r = await api(owner, 'POST', '/masters/employment_type', { label: 'Consultant' })
  const consultant = r.body
  check('admin adds a value; the code is made from the label', r.status === 201 && consultant.code === 'consultant' && !consultant.isSystem, r.data)
  r = await api(owner, 'POST', '/masters/employment_type', { label: 'consultant' })
  check('the same label twice is refused (409)', r.status === 409, r.status)
  r = await api(owner, 'POST', '/masters/not_a_list', { label: 'x' })
  check('unknown lists are refused (400)', r.status === 400, r.status)
  const gender = await list('gender')
  const female = gender.values.find((x) => x.code === 'female')
  r = await api(owner, 'PATCH', `/masters/gender/${female.id}`, { label: 'Woman' })
  check('a shipped value can be renamed; its code stays', r.status === 200 && r.body.label === 'Woman' && r.body.code === 'female', r.data)
  r = await api(owner, 'PATCH', `/masters/gender/${female.id}`, { code: 'w' })
  check('codes cannot be edited (400)', r.status === 400, r.status)
  const intern = (await list('employment_type')).values.find((x) => x.code === 'intern')
  r = await api(owner, 'PATCH', `/masters/employment_type/${intern.id}`, { active: false })
  check('a value can be retired', r.status === 200 && !(await list('employment_type')).values.some((x) => x.code === 'intern') && (await list('employment_type', true)).values.some((x) => x.code === 'intern' && !x.active))
  const et = await list('employment_type', true)
  const ids = et.values.map((x) => x.id).reverse()
  r = await api(owner, 'PUT', '/masters/employment_type/order', { ids })
  check('a list can be reordered', r.status === 200 && (await list('employment_type', true)).values[0].id === ids[0], r.data)
  r = await api(owner, 'PUT', '/masters/employment_type/order', { ids: ids.slice(1) })
  check('a reorder must include every value (400)', r.status === 400, r.status)
  const cc = await api(owner, 'POST', '/masters/cost_centre', { label: 'CC-100 Operations', code: 'CC100' })
  check('cost centres start empty and take custom codes', cc.status === 201 && cc.body.code === 'CC100', cc.data)

  // ─── Fields only accept list values ────────────────────────
  const person = (extra) => ({ firstName: 'Ola', lastName: TAG, workEmail: `ola.${Math.random().toString(36).slice(2, 8)}.${TAG}@example.com`, orgUnitId: root.id, hireDate: '2026-10-01', employmentType: 'full_time', ...extra })
  r = await api(owner, 'POST', '/employees', person({ gender: 'female', nationality: 'ZM', emergencyContactRelation: 'spouse', employmentType: 'consultant' }))
  const ola = r.body?.employee
  check('a person with list values (including a custom employment type) is created', r.status === 201 && ola.gender === 'female' && ola.employmentType === 'consultant', r.data)
  r = await api(owner, 'POST', '/employees', person({ gender: 'robot' }))
  check('a value not in the list is refused with the list name (400)', r.status === 400 && /Gender list/.test(r.data.message), r.data)
  r = await api(owner, 'POST', '/employees', person({ employmentType: 'intern' }))
  check('a retired value cannot be used for new records (400)', r.status === 400, r.status)
  r = await api(owner, 'PATCH', `/employees/${ola.id}`, { nationality: 'XX' })
  check('updates are checked too (400)', r.status === 400, r.status)
  r = await api(owner, 'PATCH', `/employees/${ola.id}`, { employmentType: 'part_time', firstName: 'Olabisi' })
  check('…and valid ones go through, employment type included', r.status === 200 && (await prisma.employee.findUnique({ where: { id: ola.id } })).employmentType === 'part_time', r.data)
  r = await api(owner, 'PATCH', `/employees/${ola.id}/bank`, { bankName: 'mystery-bank', bankAccountNo: '1234567890' })
  check('bank must come from the Bank list (400)', r.status === 400, r.status)
  r = await api(owner, 'PATCH', `/employees/${ola.id}/bank`, { bankName: 'zanaco', bankAccountNo: '1234567890' })
  check('…a listed bank is accepted', r.status === 200, r.data)

  // ─── Import reads labels ───────────────────────────────────
  r = await api(owner, 'POST', '/employees/import', { rows: [{ first_name: 'Ibi', last_name: TAG, work_email: `ibi.${TAG}@example.com`, hire_date: '2026-10-01', department: root.name, gender: 'WOMAN', nationality: 'zambian', employment_type: 'Consultant' }, { first_name: 'Bad', last_name: TAG, work_email: `bad.${TAG}@example.com`, hire_date: '2026-10-01', department: root.name, gender: 'robot', employment_type: 'Intern' }], dryRun: true })
  const [ok, bad] = r.body.rows
  check('import accepts labels in any case (renamed "Woman", "zambian", "Consultant")', ok.errors.length === 0, ok.errors)
  check('import names the list a bad value is missing from, retired values included', bad.errors.some((e) => /Gender list/.test(e)) && bad.errors.some((e) => /Employment type list/.test(e)), bad.errors)

  // ─── Who & isolation ───────────────────────────────────────
  const jane = await tokenFor('jane.mutale@marichihr.com'), admin = await tokenFor('admin@marichihr.com')
  r = await api(jane, 'GET', '/masters')
  check('any signed-in person can read the lists (dropdowns need them)', r.status === 200 && r.body.length > 10)
  r = await api(jane, 'POST', '/masters/gender', { label: 'Other' })
  check('an employee cannot change a list (403)', r.status === 403, r.status)
  r = await api(admin, 'PATCH', `/masters/gender/${female.id}`, { label: 'Hijack' })
  check("another company's values are out of reach (404)", r.status === 404, r.status)
  check("Marichi Labs still sees its own label, not this company's rename", (await api(admin, 'GET', '/masters')).body.find((l) => l.key === 'gender').values.some((x) => x.code === 'female' && x.label === 'Female'))
  check('every change is in the audit log', (await prisma.auditLog.count({ where: { tenantId: tenant.id, entityType: 'master_value' } })) >= 4)

  await prisma.tenant.update({ where: { id: tenant.id }, data: { active: false } })
  await prisma.user.updateMany({ where: { tenantId: tenant.id }, data: { active: false } })
  redis.disconnect()
  await done()
})()
