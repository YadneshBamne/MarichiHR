// Self-service onboarding and data requests: HR asks, the person fills in sections HR normally keeps, submits each
// section, HR sends one back with a note or accepts it, the request completes, permissions close again. Throwaway company.
const jwt = require('jsonwebtoken')
const { Redis } = require('ioredis')
const { api, tokenFor, check, done, prisma } = require('./lib')

const TAG = `rq${Date.now() % 1e7}`
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 })
const sign = (u, roles) => ({ token: jwt.sign({ userId: u.userId, tenantId: u.tenantId, employeeId: u.id, roleIds: roles, email: u.workEmail }, process.env.JWT_ACCESS_SECRET, { expiresIn: '1h' }) })

;(async () => {
  const keys = await redis.keys('signup:*'); if (keys.length) await redis.del(...keys)
  const email = `owner.${TAG}@example.com`
  let r = await api(null, 'POST', '/auth/signup', { companyName: `Req ${TAG}`, fullName: 'Ria Owner', email, password: 'Owner-pass-123' })
  const owner = { token: r.body.accessToken }
  const tenant = await prisma.tenant.findFirst({ where: { users: { some: { email } } } })
  const ownerEmp = await prisma.employee.findFirst({ where: { tenantId: tenant.id } })
  const root = await prisma.orgUnit.findFirst({ where: { tenantId: tenant.id, parentId: null } })
  const add = async (first, managerId) => (await api(owner, 'POST', '/employees', { firstName: first, lastName: TAG, workEmail: `${first.toLowerCase()}.${TAG}@example.com`, orgUnitId: root.id, hireDate: '2026-01-05', employmentType: 'full_time', ...(managerId && { managerId }) })).body.employee
  const A = await add('Amy'), B = await add('Bob', A.id)
  const tA = sign(A, ['employee', 'manager']), tB = sign(B, ['employee'])
  const bUser = await prisma.user.findFirst({ where: { employee: { id: B.id } } })
  await api(owner, 'PUT', '/employees/form-settings', { fields: [{ field: 'education', mode: 'display', employeeCanEdit: false }] })

  r = await api(tB, 'PATCH', `/employees/${B.id}/record`, { values: { gender: 'male' } })
  check('before any request, gender is for HR to set (403)', r.status === 403, r.status)

  // ─── Onboarding ────────────────────────────────────────────
  r = await api(tA, 'POST', '/profile-requests', { employeeIds: [B.id], sections: ['personal'], kind: 'onboarding' })
  check('a manager cannot start onboarding (403)', r.status === 403, r.status)
  r = await api(owner, 'POST', '/profile-requests', { employeeIds: [B.id], sections: ['personal', 'education', 'documents'], kind: 'onboarding', note: 'Welcome aboard', dueDate: '2026-12-31' })
  const reqId = r.body?.ids?.[0]
  check('HR starts onboarding for Bob', r.status === 201 && r.body.created === 1, r.data)
  check('…and Bob is notified', !!(await prisma.notification.findFirst({ where: { userId: bUser.id, type: 'profile.request', entityId: reqId } })))
  r = await api(owner, 'POST', '/profile-requests', { employeeIds: [B.id], sections: ['family'], kind: 'onboarding' })
  check('one onboarding at a time per person (409)', r.status === 409, r.status)
  r = await api(tB, 'GET', '/profile-requests?mine=1')
  check('Bob sees his request with its three sections', r.body.length === 1 && r.body[0].sections.length === 3 && r.body[0].progress.total === 3, r.body)
  r = await api(tA, 'GET', `/profile-requests/${reqId}`)
  check("his manager cannot open it (404)", r.status === 404, r.status)

  r = await api(tB, 'PATCH', `/employees/${B.id}/record`, { values: { gender: 'male', maritalStatus: 'single' } })
  check('while asked, Bob fills in fields HR normally keeps', r.status === 200 && r.body.values.gender === 'male', r.data)
  r = await api(tB, 'PATCH', `/employees/${B.id}/record`, { values: { firstName: 'Robert' } })
  check('…but never locked fields like his name (403)', r.status === 403, r.status)
  r = await api(tB, 'POST', `/employees/${B.id}/record/education`, { qualification: 'diploma', institute: 'Evelyn Hone College' })
  check('…and a section the form keeps for HR (education)', r.status === 201, r.data)
  r = await api(tB, 'GET', `/employees/${B.id}/record`)
  check('his record says what he may edit right now', r.body.can.edit.gender === true && r.body.can.edit.education === true && r.body.can.edit.firstName === false)

  // ─── Submit, send back, accept ─────────────────────────────
  r = await api(tB, 'POST', `/profile-requests/${reqId}/sections/personal/submit`)
  check('Bob submits his personal details', r.status === 200 && r.body.sections.find((s) => s.section === 'personal').status === 'submitted', r.data)
  r = await api(tB, 'POST', `/profile-requests/${reqId}/sections/personal/submit`)
  check('…once (400)', r.status === 400, r.status)
  r = await api(owner, 'POST', `/profile-requests/${reqId}/sections/personal/review`, { accept: false })
  check('sending back needs a note (400)', r.status === 400, r.status)
  r = await api(owner, 'POST', `/profile-requests/${reqId}/sections/personal/review`, { accept: false, note: 'Please add your blood group' })
  check('HR sends it back with a note', r.status === 200 && r.body.sections.find((s) => s.section === 'personal').status === 'rejected', r.data)
  check('…Bob is told what to fix', !!(await prisma.notification.findFirst({ where: { userId: bUser.id, type: 'profile.returned' } })))
  r = await api(tB, 'PATCH', `/employees/${B.id}/record`, { values: { bloodGroup: 'a_pos' } })
  await api(tB, 'POST', `/profile-requests/${reqId}/sections/personal/submit`)
  r = await api(owner, 'POST', `/profile-requests/${reqId}/sections/personal/review`, { accept: true })
  check('he fixes and resubmits; HR accepts', r.status === 200 && r.body.sections.find((s) => s.section === 'personal').status === 'accepted' && r.body.progress.done === 1, r.data)
  r = await api(tB, 'PATCH', `/employees/${B.id}/record`, { values: { gender: 'female' } })
  check('an accepted section closes again for him (403)', r.status === 403, r.status)
  for (const s of ['education', 'documents']) {
    await api(tB, 'POST', `/profile-requests/${reqId}/sections/${s}/submit`)
    r = await api(owner, 'POST', `/profile-requests/${reqId}/sections/${s}/review`, { accept: true })
  }
  check('when every section is accepted the onboarding is complete', r.body.status === 'completed' && !!r.body.completedAt, r.body)
  check('…and Bob hears it', !!(await prisma.notification.findFirst({ where: { userId: bUser.id, type: 'profile.completed' } })))

  // ─── Data requests to many people, cancel ──────────────────
  r = await api(owner, 'POST', '/profile-requests', { employeeIds: [A.id, B.id], sections: ['education'], kind: 'update', note: 'Annual check' })
  check('HR asks several people for one section at once', r.status === 201 && r.body.created === 2, r.data)
  const bReq = (await api(tB, 'GET', '/profile-requests?mine=1&status=open')).body[0]
  r = await api(owner, 'POST', `/profile-requests/${bReq.id}/cancel`)
  check('HR can cancel a request', r.status === 200, r.status)
  r = await api(tB, 'POST', `/employees/${B.id}/record/education`, { qualification: 'bachelors', institute: 'UNZA' })
  check('…which closes the section again (403)', r.status === 403, r.status)

  // ─── Nobody reviews themselves; isolation ──────────────────
  r = await api(owner, 'POST', '/profile-requests', { employeeIds: [ownerEmp.id], sections: ['contact'], kind: 'update' })
  const own = r.body.ids[0]
  r = await api(owner, 'POST', `/profile-requests/${own}/sections/contact/submit`)
  r = await api(owner, 'POST', `/profile-requests/${own}/sections/contact/review`, { accept: true })
  check('HR cannot accept their own details (403)', r.status === 403, r.status)
  const admin = await tokenFor('admin@marichihr.com')
  r = await api(admin, 'GET', `/profile-requests/${reqId}`)
  check("another company's request is invisible (404)", r.status === 404, r.status)

  await prisma.tenant.update({ where: { id: tenant.id }, data: { active: false } })
  await prisma.user.updateMany({ where: { tenantId: tenant.id }, data: { active: false } })
  redis.disconnect()
  await done()
})()
