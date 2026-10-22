// Job openings say why the hire is needed (new post, or a replacement and for whom) and the experience wanted.
const { Redis } = require('ioredis')
const { api, check, done, prisma } = require('./lib')

const TAG = `or${Date.now() % 1e7}`
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 })

;(async () => {
  await redis.keys('signup:*').then((k) => (k.length ? redis.del(...k) : 0)).catch(() => {})
  const ownerEmail = `owner.${TAG}@example.com`
  let r = await api(null, 'POST', '/auth/signup', { companyName: `Opening ${TAG}`, fullName: 'Ora Owner', email: ownerEmail, password: 'Owner-pass-123' })
  const owner = { token: r.body.accessToken }
  const tenant = await prisma.tenant.findFirst({ where: { users: { some: { email: ownerEmail } } } })
  const root = await prisma.orgUnit.findFirst({ where: { tenantId: tenant.id, parentId: null } })
  const leaver = (await api(owner, 'POST', '/employees', { firstName: 'Leaver', lastName: TAG, workEmail: `leaver.${TAG}@example.com`, orgUnitId: root.id, hireDate: '2024-01-08', employmentType: 'full_time' })).body.employee
  const base = { title: 'Sales executive', orgUnitId: root.id }

  r = await api(owner, 'POST', '/recruitment/openings', { ...base, reason: 'replacement' })
  check('a replacement must say who is replaced (400)', r.status === 400, r.data)
  r = await api(owner, 'POST', '/recruitment/openings', { ...base, experienceMinYears: 5, experienceMaxYears: 2 })
  check('the experience range cannot be upside down (400)', r.status === 400, r.data)
  r = await api(owner, 'POST', '/recruitment/openings', { ...base, reason: 'replacement', replacesEmployeeId: leaver.id, experienceMinYears: 2, experienceMaxYears: 5 })
  const o = r.body
  check('HR opens a replacement post with 2–5 years of experience', r.status === 201 && o.reason === 'replacement' && o.replacesEmployeeId === leaver.id && o.experienceMinYears === 2, r.data)
  r = await api(owner, 'GET', `/recruitment/openings/${o.id}`)
  check('the opening shows whom it replaces and the experience', r.body.replacesEmployee === `Leaver ${TAG}` && r.body.experienceMaxYears === 5, r.body)
  r = await api(owner, 'PATCH', `/recruitment/openings/${o.id}`, { reason: 'new_post' })
  check('switching to a new post clears the replaced person', r.status === 200 && r.body.reason === 'new_post' && r.body.replacesEmployeeId === null, r.data)
  r = await api(owner, 'POST', '/recruitment/openings', base)
  check('an opening defaults to a new post', r.status === 201 && r.body.reason === 'new_post', r.data)

  await prisma.tenant.update({ where: { id: tenant.id }, data: { active: false } })
  redis.disconnect()
  await done()
})()
