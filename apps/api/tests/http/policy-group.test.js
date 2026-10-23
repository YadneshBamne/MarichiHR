// Policies: critical policies block the app until accepted, country variants, questions routed to the policy owner,
// organisation-wide acceptance report.
const jwt = require('jsonwebtoken')
const { Redis } = require('ioredis')
const { api, check, done, prisma } = require('./lib')

const TAG = `pl${Date.now() % 1e7}`
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 })

;(async () => {
  await redis.keys('signup:*').then((k) => (k.length ? redis.del(...k) : 0)).catch(() => {})
  const ownerEmail = `owner.${TAG}@example.com`
  let r = await api(null, 'POST', '/auth/signup', { companyName: `PolG ${TAG}`, fullName: 'Pat Owner', email: ownerEmail, password: 'Owner-pass-123' })
  const hr = { token: r.body.accessToken }
  const tenant = await prisma.tenant.findFirst({ where: { users: { some: { email: ownerEmail } } } })
  await prisma.tenant.update({ where: { id: tenant.id }, data: { primaryCountry: 'ZM' } })
  const as = (emp, roleIds = ['employee']) => ({ token: jwt.sign({ userId: emp.userId, tenantId: tenant.id, employeeId: emp.id, roleIds, email: `${emp.id}@x` }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' }) })
  const root = await prisma.orgUnit.findFirst({ where: { tenantId: tenant.id, parentId: null } })
  const add = async (first, extra = {}) => {
    const x = await api(hr, 'POST', '/employees', { firstName: first, lastName: TAG, workEmail: `${first.toLowerCase()}.${TAG}@example.com`, orgUnitId: root.id, hireDate: '2025-01-06', employmentType: 'full_time' })
    const id = (x.body.employee ?? x.body).id
    await api(hr, 'PUT', `/employees/${id}/access`, { roles: ['employee'], password: 'generate', loginEnabled: true })
    if (extra.taxJurisdiction) await prisma.employee.update({ where: { id }, data: { taxJurisdiction: extra.taxJurisdiction } })
    return prisma.employee.findUnique({ where: { id } })
  }
  const zed = await add('Zola'), indi = await add('Indira', { taxJurisdiction: 'IN' }), legal = await add('Lex')
  const publish = async (body) => { const p = (await api(hr, 'POST', '/policies', body)).body; await api(hr, 'POST', `/policies/${p.id}/publish`, {}); return p }

  // ─── Critical ───────────────────────────────────────────
  r = await api(hr, 'POST', '/policies', { title: 'Bad critical', body: 'x', critical: true, requiresAcceptance: false })
  check('a critical policy must ask for acceptance (400)', r.status === 400, r.data)
  const safety = await publish({ title: 'Site safety rules', body: 'Wear a helmet on site.', critical: true })
  r = await api(as(zed), 'GET', '/leave/requests/me')
  check('until Zola accepts it, the rest of the app answers 403 POLICY_ACCEPTANCE_REQUIRED', r.status === 403 && r.data.code === 'POLICY_ACCEPTANCE_REQUIRED' && /Site safety rules/.test(r.data.message), r.data)
  r = await api(as(zed), 'GET', '/policies/blocking')
  check('…and the app can ask which policies are blocking', r.status === 200 && r.body.length === 1 && r.body[0].id === safety.id, r.data)
  r = await api(as(zed), 'GET', `/policies/${safety.id}`)
  check('she can still open the policy', r.status === 200, r.status)
  r = await api(as(zed), 'POST', `/policies/${safety.id}/accept`)
  r = await api(as(zed), 'GET', '/leave/requests/me')
  check('after accepting, everything opens again', r.status === 200, r.status)

  // ─── Country variant ────────────────────────────────────
  const india = await publish({ title: 'Leave policy (India)', body: 'Indian leave rules.', countries: ['IN'], requiresAcceptance: true })
  await api(as(indi), 'POST', `/policies/${safety.id}/accept`)
  r = await api(as(zed), 'GET', '/policies')
  check('Zola (Zambia) does not get the India variant', r.status === 200 && !r.body.some((p) => p.id === india.id), r.body?.map((p) => p.title))
  r = await api(as(indi), 'GET', '/policies')
  check('Indira (tax country India) does', r.body.some((p) => p.id === india.id), r.body?.map((p) => p.title))

  // ─── Owner routing ──────────────────────────────────────
  const it = await publish({ title: 'Acceptable use of IT', body: 'Do not share passwords.', ownerUserId: legal.userId, requiresAcceptance: false })
  await api(as(legal), 'POST', `/policies/${safety.id}/accept`)
  r = await api(as(zed), 'POST', '/policies/queries', { policyId: it.id, question: 'Can I use my own laptop?' })
  const q = r.body
  const toLegal = await prisma.notification.findFirst({ where: { tenantId: tenant.id, userId: legal.userId, type: 'policy.query' } })
  const hrUser = await prisma.user.findFirst({ where: { email: ownerEmail } })
  const toHR = await prisma.notification.findFirst({ where: { tenantId: tenant.id, userId: hrUser.id, type: 'policy.query', entityId: q.id } })
  check('a question on the IT policy goes to its owner, not HR', !!toLegal && !toHR, { toLegal: !!toLegal, toHR: !!toHR })
  r = await api(as(legal), 'GET', '/policies/queries?scope=owned')
  check('the owner sees it under questions about their policies', r.body.some((x) => x.id === q.id), r.body)
  r = await api(as(indi), 'POST', `/policies/queries/${q.id}/answer`, { answer: 'Yes', close: false })
  check('someone else cannot answer it (403)', r.status === 403, r.status)
  r = await api(as(legal), 'POST', `/policies/queries/${q.id}/answer`, { answer: 'Only with IT approval.', close: true })
  check('the owner answers it', r.status === 200, r.data)

  // ─── Report ─────────────────────────────────────────────
  r = await api(hr, 'GET', '/policies/report')
  const row = r.body?.policies.find((p) => p.id === safety.id)
  const owner = await prisma.employee.findFirst({ where: { tenantId: tenant.id, userId: hrUser.id } })
  check('the report shows the safety policy accepted by 3 of 4, missing the owner', !!row && row.accepted === 3 && row.audience === 4 && row.missing.length === 1, row)
  r = await api(as(zed), 'GET', '/policies/report')
  check('only HR sees the report (403)', r.status === 403, r.status)
  check('owner is the one missing', row?.missing[0] === 'Pat Owner', row?.missing)

  await prisma.tenant.update({ where: { id: tenant.id }, data: { active: false } })
  redis.disconnect()
  await done()
})()
