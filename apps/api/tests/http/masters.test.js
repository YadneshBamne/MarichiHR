// Masters: the overview, department tree rules (no loops, no orphaned sub-units), archiving positions and
// locations only when nobody uses them, who may see the hub, isolation. Runs in a throwaway company.
const { Redis } = require('ioredis')
const { api, tokenFor, check, done, prisma } = require('./lib')

const TAG = `ms${Date.now() % 1e7}`
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 })

;(async () => {
  const keys = await redis.keys('signup:*'); if (keys.length) await redis.del(...keys)
  const email = `owner.${TAG}@example.com`
  let r = await api(null, 'POST', '/auth/signup', { companyName: `Masters ${TAG}`, fullName: 'Mo Owner', email, password: 'Owner-pass-123' })
  const owner = { token: r.body.accessToken }
  const tenant = await prisma.tenant.findFirst({ where: { users: { some: { email } } } })

  r = await api(owner, 'GET', '/employees/masters')
  const root = r.body.units.find((u) => !u.parentId)
  check('the hub lists departments with headcount and every master count', r.status === 200 && root && root.headcount === 1 && ['positions', 'locations', 'leaveTypes', 'expenseCats', 'calendars'].every((k) => typeof r.body.counts[k] === 'number'), r.body?.counts)

  const ops = (await api(owner, 'POST', '/employees/org-units', { name: 'Operations', type: 'department', parentId: root.id })).body
  const team = (await api(owner, 'POST', '/employees/org-units', { name: 'Field team', type: 'team', parentId: ops.id })).body
  r = await api(owner, 'PATCH', `/employees/org-units/${ops.id}`, { parentId: team.id })
  check('a department cannot move under its own sub-unit (400)', r.status === 400, r.data)
  r = await api(owner, 'POST', `/employees/org-units/${ops.id}/archive`, { reason: 'test' })
  check('a department with sub-units cannot be archived (400)', r.status === 400, r.data)
  r = await api(owner, 'POST', `/employees/org-units/${team.id}/archive`, { reason: 'test' })
  check('an empty team can', r.status === 200, r.data)

  const pos = (await api(owner, 'POST', '/employees/job-positions', { title: 'Driver', orgUnitId: ops.id })).body
  const loc = (await api(owner, 'POST', '/employees/work-locations', { name: 'Depot', city: 'Ndola', countryCode: 'ZM' })).body
  const emp = (await api(owner, 'POST', '/employees/import', { rows: [{ first_name: 'Dee', last_name: 'Driver', work_email: `dee.${TAG}@example.com`, hire_date: '2026-10-01', department: 'Operations', job_title: 'Driver', work_location: 'Depot' }], dryRun: false })).body
  check('someone holds the position and location', emp.created === 1, emp)
  r = await api(owner, 'POST', `/employees/job-positions/${pos.id}/archive`)
  check('a position in use cannot be archived (400)', r.status === 400 && /1 active person/.test(r.data.message), r.data)
  r = await api(owner, 'POST', `/employees/work-locations/${loc.id}/archive`)
  check('a location in use cannot be archived (400)', r.status === 400, r.status)
  const unused = (await api(owner, 'POST', '/employees/job-positions', { title: 'Spare', orgUnitId: ops.id })).body
  r = await api(owner, 'POST', `/employees/job-positions/${unused.id}/archive`)
  check('an unused position is archived and leaves the list', r.status === 200 && !(await api(owner, 'GET', '/employees/job-positions')).body.some((p) => p.id === unused.id), r.data)
  check('…and the audit log says so', !!(await prisma.auditLog.findFirst({ where: { tenantId: tenant.id, action: 'JOB_POSITION_ARCHIVED', entityId: unused.id } })))

  const john = await tokenFor('john.banda@marichihr.com'), admin = await tokenFor('admin@marichihr.com')
  r = await api(john, 'GET', '/employees/masters')
  check('a manager cannot open the masters hub (403)', r.status === 403, r.status)
  r = await api(admin, 'POST', `/employees/job-positions/${pos.id}/archive`)
  check("another company's position is out of reach (404)", r.status === 404, r.status)
  r = await api(admin, 'GET', '/employees/masters')
  check("the hub shows only the caller's own departments", r.status === 200 && !r.body.units.some((u) => u.id === ops.id))

  await prisma.tenant.update({ where: { id: tenant.id }, data: { active: false } })
  await prisma.user.updateMany({ where: { tenantId: tenant.id }, data: { active: false } })
  redis.disconnect()
  await done()
})()
