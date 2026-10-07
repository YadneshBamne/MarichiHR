// Self-serve companies: signup, company profile and logo, installed apps (API gating), HR-issued login access with
// forced password change, email-only login, throttling, tenant isolation. Creates test companies and deactivates them at the end.
const { Redis } = require('ioredis')
const { api, tokenFor, check, done, prisma } = require('./lib')

const TAG = `p23${Date.now() % 1e7}`
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 })
const clearSignupLimit = async () => { const keys = await redis.keys('signup:ip:*'); if (keys.length) await redis.del(...keys) }
const bearer = (t) => ({ token: t })

;(async () => {
  await clearSignupLimit()
  const created = []
  const email = `owner.${TAG}@example.com`
  const password = `Start${TAG}x9`

  // ─── SIGNUP ────────────────────────────────────────────────
  let r = await api(null, 'POST', '/auth/signup', { companyName: `Acme ${TAG}`, fullName: 'Ada Owner', email, password: 'short1' })
  check('weak password rejected with the rule', r.status === 400 && /10 characters/.test(r.data.message), r.data)
  r = await api(null, 'POST', '/auth/signup', { companyName: `Acme ${TAG}`, fullName: 'Ada Owner', email, password, plan: 'free' })
  check('signup body is strict', r.status === 400, r.data)
  r = await api(null, 'POST', '/auth/signup', { companyName: `Acme ${TAG}`, fullName: 'Ada Owner', email: email.toUpperCase(), password })
  const sign = r.body
  check('signup creates the company and signs the owner in', r.status === 201 && sign.accessToken && sign.workspace?.startsWith('acme-') && sign.user.email === email, r.data)
  const owner = bearer(sign?.accessToken)
  const tenantId = sign?.user?.tenant?.id
  created.push(tenantId)
  check('owner is employee + HR admin + system admin; company not onboarded yet; all apps installed',
    ['employee', 'hr_admin', 'system_admin'].every((n) => sign.user.roles.some((x) => x.name === n)) && sign.user.tenant.onboardedAt === null && sign.user.tenant.modules.length === 5 && sign.user.tenant.ownerUserId === sign.user.id, sign.user)
  const counts = await Promise.all([
    prisma.role.count({ where: { tenantId } }), prisma.leaveType.count({ where: { tenantId } }), prisma.activityType.count({ where: { tenantId } }),
    prisma.expenseCategory.count({ where: { tenantId } }), prisma.resourceCalendar.count({ where: { tenantId } }), prisma.orgUnit.count({ where: { tenantId } }),
    prisma.leaveBalance.count({ where: { employee: { tenantId } } }),
  ])
  check('workspace bootstrapped: 6 roles, 8 leave types, 8 activity types, 5 expense categories, a calendar, a root unit, owner balances', JSON.stringify(counts) === JSON.stringify([6, 8, 8, 5, 1, 1, 8]), counts)
  r = await api(owner, 'GET', '/employees/' + (await tokenFor('jane.mutale@marichihr.com')).employeeId)
  check('new company cannot see another company\'s people (404)', r.status === 404, r.data)

  // ─── COMPANY PROFILE ───────────────────────────────────────
  r = await api(owner, 'PATCH', '/company', { name: `Acme Works ${TAG}`, legalName: 'Acme Works Ltd', industry: 'Software', companySize: '11-50', primaryCountry: 'ke', baseCurrency: 'kes', timezone: 'Africa/Nairobi', fiscalYearStartMonth: 7, logoUrl: PNG })
  check('owner sets name, legal name, country, currency, time zone, fiscal year and logo', r.status === 200 && r.body.name === `Acme Works ${TAG}` && r.body.baseCurrency === 'KES' && r.body.timezone === 'Africa/Nairobi' && r.body.fiscalYearStartMonth === 7 && r.body.logoUrl === PNG, r.data)
  check('renaming the company renames its root org unit', !!(await prisma.orgUnit.findFirst({ where: { tenantId, parentId: null, name: `Acme Works ${TAG}` } })))
  r = await api(owner, 'PATCH', '/company', { logoUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' })
  check('SVG logos are refused (only PNG, JPEG, WebP)', r.status === 400, r.data)
  r = await api(owner, 'PATCH', '/company', { timezone: 'Mars/Olympus' })
  check('unknown time zone refused', r.status === 400 && /time zone/i.test(r.data.message), r.data)
  r = await api(owner, 'PATCH', '/company', { slug: 'hijack' })
  check('workspace address cannot be changed through the profile (strict)', r.status === 400, r.data)
  r = await api(null, 'GET', `/auth/workspace/${sign.workspace}`)
  check('login page can show the company name and logo for a workspace', r.status === 200 && r.body.name === `Acme Works ${TAG}` && r.body.logoUrl === PNG && !r.body.id, r.data)
  r = await api(null, 'GET', '/auth/workspace/no-such-workspace-x')
  check('unknown workspace is 404', r.status === 404, r.data)

  // ─── APPS ──────────────────────────────────────────────────
  r = await api(owner, 'PUT', '/company/modules', { modules: ['leave', 'attendance'] })
  check('owner installs only Leave and Attendance', r.status === 200 && JSON.stringify(r.body.modules) === '["leave","attendance"]', r.data)
  r = await api(owner, 'GET', '/payroll/cycles')
  check('an app that is not installed is refused by the API (403 MODULE_DISABLED)', r.status === 403 && r.data.code === 'MODULE_DISABLED', r.data)
  r = await api(owner, 'GET', '/expenses/claims/me')
  check('expenses refused too', r.status === 403 && r.data.code === 'MODULE_DISABLED', r.data)
  r = await api(owner, 'GET', '/leave/types')
  check('installed app works', r.status === 200 && r.body.length === 8, r.data)
  r = await api(owner, 'GET', `/leave/contracts/employee/${sign.user.employee.id}`)
  check('employment contracts stay available without the payroll app', r.status === 200, r.data)
  r = await api(owner, 'PUT', '/company/modules', { modules: ['leave', 'crm'] })
  check('unknown app refused', r.status === 400, r.data)
  r = await api(owner, 'POST', '/company/onboarding/complete')
  check('finishing onboarding stamps onboardedAt', r.status === 200 && !!r.body.onboardedAt, r.data)
  r = await api(owner, 'GET', '/auth/me')
  check('/auth/me carries the company branding and apps for the shell', r.status === 200 && r.body.tenant.logoUrl === PNG && JSON.stringify(r.body.tenant.modules) === '["leave","attendance"]', r.data)

  // ─── PEOPLE + LOGIN ACCESS ─────────────────────────────────
  const root = await prisma.orgUnit.findFirst({ where: { tenantId, parentId: null } })
  r = await api(owner, 'POST', '/employees', { firstName: 'Max', lastName: 'Manager', workEmail: `max.${TAG}@example.com`, orgUnitId: root.id, hireDate: '2026-10-01', employmentType: 'full_time' })
  const max = r.body?.employee
  check('HR adds an employee; no temporary password is generated or returned', r.status === 201 && max && r.body.tempPassword === undefined, r.data)
  const maxUser = await prisma.user.findFirst({ where: { tenantId, email: `max.${TAG}@example.com` } })
  check('new employee has no password until access is granted', maxUser && maxUser.passwordHash === null)
  check('nothing password-like is kept in the event log', !(await prisma.domainEvent.findFirst({ where: { tenantId, eventType: 'employee.created' } }))?.payload?.tempPassword)
  r = await api(null, 'POST', '/auth/login', { email: `max.${TAG}@example.com`, password: 'anything123' })
  check('they cannot sign in yet', r.status === 401, r.data)
  r = await api(owner, 'PUT', `/employees/${max.id}/access`, { roles: ['manager'], password: 'generate', loginEnabled: true })
  const temp = r.body?.temporaryPassword
  check('HR grants manager access with a generated temporary password (shown once)', r.status === 200 && temp && temp.length >= 14 && r.body.roles.includes('manager') && r.body.roles.includes('employee') && r.body.mustChangePassword === true, r.data)
  r = await api(owner, 'GET', `/employees/${max.id}/access`)
  check('access view never returns the password', r.status === 200 && r.body.temporaryPassword === undefined && r.body.hasPassword === true, r.data)
  r = await api(null, 'POST', '/auth/login', { email: `max.${TAG}@example.com`, password: temp })
  const maxTok = bearer(r.body?.accessToken)
  check('employee signs in with just email + password (organisation found automatically)', r.status === 200 && r.body.user.mustChangePassword === true && r.body.user.tenant.id === tenantId, r.data)
  r = await api(maxTok, 'GET', '/leave/types')
  check('until they set a new password every other API is refused (403 PASSWORD_CHANGE_REQUIRED)', r.status === 403 && r.data.code === 'PASSWORD_CHANGE_REQUIRED', r.data)
  r = await api(maxTok, 'GET', '/auth/me')
  check('/auth/me still works so the app can show the change-password screen', r.status === 200 && r.body.mustChangePassword === true, r.data)
  r = await api(maxTok, 'POST', '/auth/change-password', { currentPassword: temp, newPassword: 'weakpass' })
  check('new password must be strong', r.status === 400, r.data)
  r = await api(maxTok, 'POST', '/auth/change-password', { currentPassword: 'wrong-one-123', newPassword: `Mine${TAG}z1` })
  check('current password must be right', r.status === 400, r.data)
  r = await api(maxTok, 'POST', '/auth/change-password', { currentPassword: temp, newPassword: `Mine${TAG}z1` })
  const max2 = bearer(r.body?.accessToken)
  check('password changed: fresh session without the restriction', r.status === 200 && r.body.user.mustChangePassword === false, r.data)
  r = await api(max2, 'GET', '/leave/types')
  check('employee portal works after the change', r.status === 200, r.data)
  r = await api(max2, 'GET', '/leave/requests/pending')
  check('manager role is in effect (approvals inbox open)', r.status === 200, r.data)
  r = await api(max2, 'PUT', `/employees/${max.id}/access`, { roles: ['hr_admin'] })
  check('a manager cannot change access (403)', r.status === 403, r.data)
  r = await api(owner, 'PUT', `/employees/${sign.user.employee.id}/access`, { roles: ['employee'] })
  check('admins cannot remove their own admin access', r.status === 400, r.data)
  r = await api(owner, 'PUT', `/employees/${sign.user.employee.id}/access`, { loginEnabled: false })
  check('admins cannot disable their own login', r.status === 400, r.data)

  // HR-only admin (not system admin) cannot hand out system admin
  r = await api(owner, 'PUT', `/employees/${max.id}/access`, { roles: ['manager', 'hr_admin'] })
  const maxHr = (await api(null, 'POST', '/auth/login', { email: `max.${TAG}@example.com`, password: `Mine${TAG}z1` })).body
  check('roles change signs the person out and takes effect at next sign-in', r.status === 200 && maxHr.user.roles.some((x) => x.name === 'hr_admin'), maxHr)
  r = await api(bearer(maxHr.accessToken), 'PUT', `/employees/${sign.user.employee.id}/access`, { roles: ['employee', 'hr_admin', 'system_admin', 'compliance_officer'] })
  check('an HR admin cannot grant system or compliance roles (403)', r.status === 403, r.data)

  // Deactivated logins cannot refresh
  r = await api(owner, 'PUT', `/employees/${max.id}/access`, { loginEnabled: false })
  check('HR disables a login', r.status === 200 && r.body.loginEnabled === false, r.data)
  r = await api(null, 'POST', '/auth/refresh', { refreshToken: maxHr.refreshToken })
  check('disabled login cannot refresh its session', r.status === 401, r.data)
  r = await api(null, 'POST', '/auth/login', { email: `max.${TAG}@example.com`, password: `Mine${TAG}z1` })
  check('disabled login cannot sign in', r.status === 401, r.data)

  // ─── SAME EMAIL IN TWO COMPANIES ───────────────────────────
  await clearSignupLimit()
  r = await api(null, 'POST', '/auth/signup', { companyName: `Beta ${TAG}`, fullName: 'Ada Owner', email, password })
  created.push(r.body?.user?.tenant?.id)
  check('the same person can own a second company', r.status === 201, r.data)
  r = await api(null, 'POST', '/auth/login', { email, password })
  check('email in two companies: sign-in asks for the organisation (ORG_REQUIRED)', r.status === 400 && r.data.code === 'ORG_REQUIRED', r.data)
  r = await api(null, 'POST', '/auth/login', { email, password, tenantSlug: sign.workspace })
  check('with the organisation it signs into the right one', r.status === 200 && r.body.user.tenant.id === tenantId, r.data)

  // ─── THROTTLING ────────────────────────────────────────────
  const ghost = `ghost.${TAG}@example.com`
  let last
  for (let i = 0; i < 11; i++) last = await api(null, 'POST', '/auth/login', { email: ghost, password: 'Nope12345678' })
  check('after 10 failed sign-ins the 11th is refused (429)', last.status === 429, last.data)

  r = await api(await tokenFor('admin@marichihr.com'), 'GET', '/payroll/cycles')
  check('existing company keeps every app (payroll still open)', r.status === 200, r.data)

  // ─── CLEANUP: test companies are deactivated (jobs skip them) ──
  await prisma.tenant.updateMany({ where: { id: { in: created.filter(Boolean) } }, data: { active: false } })
  await redis.quit()
  await done()
})().catch(async (e) => { console.error(e); await redis.quit(); await prisma.$disconnect(); process.exit(1) })
