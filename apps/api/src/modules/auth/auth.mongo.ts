import { ssoPublic } from './oidc.sso'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import mongoose from 'mongoose'
import { LoginDto, AuthTokens, JwtPayload } from './auth.types'
import { AppError } from '../../shared/utils/AppError'
import { redis, soft } from '../../infrastructure/cache/redis'
import { encryptField, decryptField } from '../../shared/utils/crypto'
import { generateTotpSecret, verifyTotp, otpauthUrl, totpAt, currentStep } from '../../shared/utils/totp'
import { connectMongo, syncMongoIndexes, Tenant, Role, User, OrgUnit, Employee, RefreshToken, JobPosition, AuditLog } from '../../infrastructure/mongo/mongo'
import { bootstrapCompany } from '../company/company.bootstrap.mongo'

// MongoDB version of auth.service.ts + auth.repository.ts: same exports, same response shapes, same rules.
// Roles are embedded in the user document (roleName next to roleId), so there are no joins.
// ponytail: emails are matched case-insensitively with a collation scan per tenant; add a collated unique index if user counts grow large.

const CI = { locale: 'en', strength: 2 } as const
const ser = (d: any) => { if (!d) return d; const { _id, ...rest } = d; return { id: _id, ...rest } }

const now = () => new Date()
const liveRoles = (u: any) => (u.userRoles || []).filter((r: any) => !r.validUntil || r.validUntil > now())
const audit = (tenantId: string, userId: string, action: string, entityType: string, entityId: string) =>
  AuditLog.create({ tenantId, userId, action, entityType, entityId })

const EMP_BRIEF = 'employeeCode firstName lastName employmentStatus orgUnitId'

async function withEmployeeAndRoles(u: any) {
  if (!u) return null
  const emp: any = await Employee.findOne({ userId: u._id }).select(EMP_BRIEF).lean()
  return { ...ser(u), userRoles: liveRoles(u).map((r: any) => ({ role: { id: r.roleId, name: r.roleName }, scopeType: r.scopeType, scopeId: r.scopeId })), employee: ser(emp) }
}

export const authRepository = {
  async findUserByEmail(email: string, tenantId: string) {
    return withEmployeeAndRoles(await User.findOne({ email, tenantId, active: true }).collation(CI).lean())
  },
  async findTenantBySlug(slug: string) {
    return ser(await Tenant.findOne({ slug, active: true }).lean())
  },
  async createRefreshToken(userId: string, token: string, expiresAt: Date) {
    return RefreshToken.create({ userId, token, expiresAt })
  },
  async findRefreshToken(token: string) {
    const t: any = await RefreshToken.findOne({ token }).lean()
    if (!t) return null
    return { ...ser(t), user: await withEmployeeAndRoles(await User.findById(t.userId).lean()) }
  },
  async revokeRefreshToken(token: string) {
    return RefreshToken.updateOne({ token }, { revokedAt: now() })
  },
  async revokeAllUserRefreshTokens(userId: string) {
    return RefreshToken.updateMany({ userId, revokedAt: null }, { revokedAt: now() })
  },
  async updateLastLogin(userId: string) {
    return User.updateOne({ _id: userId }, { lastLoginAt: now() })
  },
  async findUserById(userId: string) {
    const u: any = await User.findById(userId).lean()
    if (!u) return null
    const [tenant, emp] = await Promise.all([Tenant.findById(u.tenantId).lean(), Employee.findOne({ userId }).lean()]) as any[]
    const roleDocs: any[] = await Role.find({ _id: { $in: liveRoles(u).map((r: any) => r.roleId) } }).select('description').lean()
    const desc = new Map(roleDocs.map((r) => [r._id, r.description]))
    let employee: any = null
    if (emp) {
      const [orgUnit, jobPosition, mgr]: any[] = await Promise.all([
        OrgUnit.findById(emp.orgUnitId).select('name type').lean(),
        emp.jobPositionId ? JobPosition.findById(emp.jobPositionId).select('title').lean() : null,
        emp.managerId ? Employee.findById(emp.managerId).lean() : null,
      ])
      const mgrUser: any = mgr ? await User.findById(mgr.userId).select('fullName avatarUrl').lean() : null
      employee = { ...ser(emp), orgUnit: ser(orgUnit), jobPosition: ser(jobPosition), manager: mgr ? { ...ser(mgr), user: mgrUser && { fullName: mgrUser.fullName, avatarUrl: mgrUser.avatarUrl } } : null }
    }
    return { ...ser(u), tenant: ser(tenant), employee, userRoles: liveRoles(u).map((r: any) => ({ role: { id: r.roleId, name: r.roleName, description: desc.get(r.roleId) ?? null }, scopeType: r.scopeType, scopeId: r.scopeId })) }
  },
}

function generateAccessToken(payload: JwtPayload): string {
  return jwt.sign(payload, process.env.JWT_ACCESS_SECRET!, { expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m' } as jwt.SignOptions)
}
const generateRefreshToken = () => crypto.randomBytes(64).toString('hex')

// Sessions slide: every refresh issues a new refresh token valid for another 30 days
const REFRESH_TOKEN_DAYS = 30
const ROTATION_GRACE_MS = 60_000
const getRefreshTokenExpiry = () => new Date(Date.now() + REFRESH_TOKEN_DAYS * 86_400_000)

const mfaSecretKey = () => `${process.env.JWT_ACCESS_SECRET}.mfa`
const MFA_MAX_FAILURES = 5

type LoginUser = NonNullable<Awaited<ReturnType<typeof authRepository.findUserByEmail>>>
type LoginTenant = { id: string; name: string; slug: string; baseCurrency?: string; timezone?: string; primaryCountry?: string | null; logoUrl?: string | null; modules?: string[]; onboardedAt?: Date | null; ownerUserId?: string | null }

const claimsFor = (user: any, tenantId: string): JwtPayload => ({
  userId: user.id, tenantId, employeeId: user.employee?.id || '', roleIds: user.userRoles.map((ur: any) => ur.role.name), email: user.email,
  ...(user.mustChangePassword && { pwc: true }),
})

export const tenantPayload = (t: LoginTenant) => ({
  id: t.id, name: t.name, slug: t.slug, baseCurrency: t.baseCurrency ?? null, timezone: t.timezone ?? null, primaryCountry: t.primaryCountry ?? null,
  logoUrl: t.logoUrl ?? null, modules: t.modules ?? [], onboardedAt: t.onboardedAt ?? null, ownerUserId: t.ownerUserId ?? null,
})

export const PASSWORD_RULE = 'Use at least 10 characters with a letter and a number'
export const strongPassword = (pw: string) => pw.length >= 10 && /[A-Za-z]/.test(pw) && /\d/.test(pw)

const LOGIN_MAX_FAILURES = 10
async function guardLogin(key: string) {
  if ((Number(await soft(() => redis.get(key), null)) || 0) >= LOGIN_MAX_FAILURES) throw new AppError('Too many failed sign-in attempts. Try again in 15 minutes.', 429)
}
async function failLogin(key: string): Promise<never> {
  await soft(() => redis.multi().incr(key).expire(key, 900).exec(), null)
  throw new AppError('Invalid credentials', 401)
}

export type LoginResult = (AuthTokens & { user: any }) | { mfaRequired: true; mfaToken: string }

async function issueSession(user: LoginUser, tenant: LoginTenant): Promise<AuthTokens & { user: any }> {
  const accessToken = generateAccessToken(claimsFor(user, tenant.id))
  const refreshTokenValue = generateRefreshToken()
  await Promise.all([authRepository.createRefreshToken(user.id, refreshTokenValue, getRefreshTokenExpiry()), authRepository.updateLastLogin(user.id)])
  return {
    accessToken, refreshToken: refreshTokenValue, expiresIn: 900,
    user: {
      id: user.id, email: user.email, fullName: user.fullName, avatarUrl: user.avatarUrl, mfaEnabled: user.mfaEnabled, tourDoneAt: user.tourDoneAt,
      locale: user.locale ?? null, mustChangePassword: user.mustChangePassword,
      roles: user.userRoles.map((ur: any) => ({ id: ur.role.id, name: ur.role.name })),
      employee: user.employee ? { id: user.employee.id, code: user.employee.employeeCode, firstName: user.employee.firstName, lastName: user.employee.lastName } : null,
      tenant: tenantPayload(tenant),
    },
  }
}

const isAlumniUser = (u: any) => (u.userRoles ?? []).length > 0 && (u.userRoles ?? []).every((r: any) => (r.role?.name ?? r.roleName) === 'alumni')

export async function completeLogin(user: LoginUser, tenant: LoginTenant): Promise<LoginResult> {
  // a former employee keeps a login only through the alumni portal (role `alumni`, switched on by HR)
  if (user.employee && user.employee.employmentStatus === 'terminated' && !isAlumniUser(user)) throw new AppError('Account has been deactivated', 401)
  if (user.mfaEnabled) {
    const mfaToken = jwt.sign({ sub: user.id, tenantId: tenant.id, purpose: 'mfa' }, mfaSecretKey(), { expiresIn: '5m' })
    return { mfaRequired: true, mfaToken }
  }
  return issueSession(user, tenant)
}

async function checkTotp(userId: string, secretEnc: string | null, lastStep: number | null, code: string) {
  const key = `mfa:fail:${userId}`
  const failures = Number(await soft(() => redis.get(key), null)) || 0
  if (failures >= MFA_MAX_FAILURES) throw new AppError('Too many invalid codes. Try again in 15 minutes.', 429)
  const step = secretEnc ? verifyTotp(decryptField(secretEnc), code, lastStep) : null
  if (step == null) {
    await soft(() => redis.multi().incr(key).expire(key, 900).exec(), null)
    throw new AppError('Invalid authentication code', 401)
  }
  await soft(() => redis.del(key), 0)
  await User.updateOne({ _id: userId }, { mfaLastStep: step })
}

const activeUser = async (userId: string) => {
  const u: any = await User.findById(userId).lean()
  if (!u || !u.active) throw new AppError('User not found', 404)
  return u
}

export const authService = {
  async login(dto: LoginDto, ip = ''): Promise<LoginResult> {
    const email = dto.email.trim().toLowerCase()
    const guardKey = `login:fail:${email}:${ip}`
    await guardLogin(guardKey)
    let tenant: any = dto.tenantSlug ? await authRepository.findTenantBySlug(dto.tenantSlug.trim().toLowerCase()) : null
    if (dto.tenantSlug && !tenant) return failLogin(guardKey)
    if (!tenant) {
      const users: any[] = await User.find({ email, active: true, passwordHash: { $ne: null } }).collation(CI).select('tenantId').lean()
      const tenants: any[] = users.length ? await Tenant.find({ _id: { $in: users.map((u) => u.tenantId) }, active: true }).limit(2).lean() : []
      if (tenants.length > 1) throw new AppError('This email is used in more than one organisation. Enter your organisation to continue.', 400, 'ORG_REQUIRED')
      if (!tenants.length) return failLogin(guardKey)
      tenant = ser(tenants[0])
    }
    const user = await authRepository.findUserByEmail(email, tenant.id)
    const passwordOk = async (hash: string) => (await bcrypt.compare(dto.password, hash)) || (dto.password !== dto.password.trim() && (await bcrypt.compare(dto.password.trim(), hash)))
    if (!user || !user.passwordHash || !(await passwordOk(user.passwordHash))) return failLogin(guardKey)
    await soft(() => redis.del(guardKey), 0)
    // A company can require single sign-on; its admins keep their password so a provider outage never locks everyone out
    if ((await ssoPublic(tenant.id)).enforce && !(user.userRoles ?? []).some((r: any) => ['system_admin', 'hr_admin'].includes(r.role?.name ?? r.roleName))) throw new AppError('Your company requires single sign-on. Use the single sign-on button.', 403, 'SSO_REQUIRED')
    return completeLogin(user, tenant)
  },

  async changePassword(userId: string, current: string, next: string) {
    const user = await activeUser(userId)
    if (!user.passwordHash || !(await bcrypt.compare(current, user.passwordHash))) throw new AppError('Your current password is not correct', 400)
    if (!strongPassword(next)) throw new AppError(PASSWORD_RULE, 400)
    if (current === next) throw new AppError('Choose a password different from the current one', 400)
    await User.updateOne({ _id: userId }, { passwordHash: await bcrypt.hash(next, 12), mustChangePassword: false })
    await authRepository.revokeAllUserRefreshTokens(userId)
    await audit(user.tenantId, userId, 'PASSWORD_CHANGED', 'user', userId)
    const fresh = await authRepository.findUserByEmail(user.email, user.tenantId)
    return issueSession(fresh!, ser(await Tenant.findById(user.tenantId).lean()))
  },

  async workspaceBranding(slug: string) {
    const t: any = await Tenant.findOne({ slug: slug.toLowerCase(), active: true }).select('name logoUrl').lean()
    if (!t) throw new AppError('Organisation not found', 404)
    return { name: t.name, logoUrl: t.logoUrl ?? null, sso: await ssoPublic(t._id) }
  },

  async verifyMfaLogin(mfaToken: string, code: string) {
    let claims: { sub: string; tenantId: string; purpose: string }
    try { claims = jwt.verify(mfaToken, mfaSecretKey()) as any } catch { throw new AppError('MFA session expired. Sign in again.', 401) }
    if (claims.purpose !== 'mfa') throw new AppError('MFA session expired. Sign in again.', 401)
    const tenant: any = await Tenant.findOne({ _id: claims.tenantId, active: true }).lean()
    const user: any = await User.findOne({ _id: claims.sub, tenantId: claims.tenantId, active: true }).lean()
    if (!tenant || !user || !user.mfaEnabled) throw new AppError('MFA session expired. Sign in again.', 401)
    await checkTotp(user._id, user.mfaSecret ?? null, user.mfaLastStep ?? null, code)
    const full = await authRepository.findUserByEmail(user.email, tenant._id)
    return issueSession(full!, ser(tenant))
  },

  async setTour(userId: string, status: 'done' | 'reset') {
    const r = await User.updateOne({ _id: userId, active: true }, { tourDoneAt: status === 'done' ? now() : null })
    if (!r.matchedCount) throw new AppError('User not found', 404)
    return { tourDoneAt: status === 'done' ? now().toISOString() : null }
  },

  async mfaSetup(userId: string) {
    const user = await activeUser(userId)
    if (user.mfaEnabled) throw new AppError('MFA is already enabled. Disable it first to re-enrol.', 409)
    const secret = generateTotpSecret()
    await User.updateOne({ _id: userId }, { mfaSecret: encryptField(secret), mfaLastStep: null })
    return { secret, otpauthUrl: otpauthUrl(secret, user.email) }
  },

  async mfaEnable(userId: string, code: string) {
    const user = await activeUser(userId)
    if (user.mfaEnabled) throw new AppError('MFA is already enabled', 409)
    if (!user.mfaSecret) throw new AppError('Start MFA setup first', 400)
    await checkTotp(userId, user.mfaSecret, user.mfaLastStep ?? null, code)
    await User.updateOne({ _id: userId }, { mfaEnabled: true })
    await audit(user.tenantId, userId, 'MFA_ENABLED', 'user', userId)
    return { mfaEnabled: true }
  },

  async mfaDisable(userId: string, code: string) {
    const user = await activeUser(userId)
    if (!user.mfaEnabled) throw new AppError('MFA is not enabled', 400)
    await checkTotp(userId, user.mfaSecret ?? null, user.mfaLastStep ?? null, code)
    await User.updateOne({ _id: userId }, { mfaEnabled: false, mfaSecret: null, mfaLastStep: null })
    await audit(user.tenantId, userId, 'MFA_DISABLED', 'user', userId)
    return { mfaEnabled: false }
  },

  async refresh(refreshTokenValue: string): Promise<AuthTokens> {
    const stored: any = await authRepository.findRefreshToken(refreshTokenValue)
    if (!stored) throw new AppError('Invalid refresh token', 401)
    if (stored.revokedAt) throw new AppError('Refresh token has been revoked', 401)
    if (stored.expiresAt < now()) throw new AppError('Refresh token has expired', 401)
    const user = stored.user
    if (!user) throw new AppError('Invalid refresh token', 401)

    // Rotation with a 60 s grace: the old token keeps working briefly so a page that reloads mid-refresh is not signed out
    const graceEnd = new Date(Date.now() + ROTATION_GRACE_MS)
    if (stored.expiresAt > graceEnd) await RefreshToken.updateOne({ _id: stored.id }, { expiresAt: graceEnd })

    if (!user.active || (user.employee?.employmentStatus === 'terminated' && !isAlumniUser(user))) {
      await authRepository.revokeAllUserRefreshTokens(user.id)
      throw new AppError('Account has been deactivated', 401)
    }
    const accessToken = generateAccessToken(claimsFor(user, user.tenantId))
    const newRefreshToken = generateRefreshToken()
    await authRepository.createRefreshToken(user.id, newRefreshToken, getRefreshTokenExpiry())
    return { accessToken, refreshToken: newRefreshToken, expiresIn: 900 }
  },

  async logout(refreshTokenValue: string): Promise<void> {
    const stored: any = await authRepository.findRefreshToken(refreshTokenValue)
    if (stored && !stored.revokedAt) await authRepository.revokeRefreshToken(refreshTokenValue)
  },

  async getMe(userId: string): Promise<any> {
    const user: any = await authRepository.findUserById(userId)
    if (!user) throw new AppError('User not found', 404)
    return {
      id: user.id, email: user.email, fullName: user.fullName, avatarUrl: user.avatarUrl, mfaEnabled: user.mfaEnabled, tourDoneAt: user.tourDoneAt,
      locale: user.locale ?? null, mustChangePassword: user.mustChangePassword, lastLoginAt: user.lastLoginAt,
      roles: user.userRoles.map((ur: any) => ({ id: ur.role.id, name: ur.role.name, description: ur.role.description, scopeType: ur.scopeType, scopeId: ur.scopeId })),
      employee: user.employee
        ? { id: user.employee.id, code: user.employee.employeeCode, firstName: user.employee.firstName, lastName: user.employee.lastName, employmentStatus: user.employee.employmentStatus, orgUnit: user.employee.orgUnit, jobPosition: user.employee.jobPosition, manager: user.employee.manager }
        : null,
      tenant: tenantPayload(user.tenant),
    }
  },
}

// Self-check: npx ts-node --files src/modules/auth/auth.mongo.ts  (needs MONGO_URI and REDIS_URL; creates a workspace, then deletes it)
if (require.main === module) {
  ;(async () => {
    await connectMongo()
    await syncMongoIndexes()
    const slug = `authcheck-${Date.now()}`, email = `${slug}@example.com`, pw = 'Correct-horse-1'
    const { tenantId, userId } = await bootstrapCompany({ companyName: 'Authcheck Ltd', slug, email, fullName: 'Auth Check', passwordHash: await bcrypt.hash(pw, 4) })
    const fails = async (p: Promise<any>, status: number) => p.then(() => false, (e) => e.statusCode === status || e.status === status)
    try {
      const res: any = await authService.login({ email: email.toUpperCase(), password: pw }, 'selfcheck')
      console.assert(res.accessToken && res.refreshToken, 'login issues tokens (email case-insensitive, no org given)')
      const claims: any = jwt.verify(res.accessToken, process.env.JWT_ACCESS_SECRET!)
      console.assert(claims.roleIds.sort().join() === 'employee,hr_admin,system_admin' && claims.employeeId === res.user.employee.id, 'JWT carries role names and employee id')
      console.assert(await fails(authService.login({ email, password: 'wrong-password-1', tenantSlug: slug }, 'selfcheck'), 401), 'wrong password is 401')
      const r2 = await authService.refresh(res.refreshToken)
      console.assert(r2.refreshToken !== res.refreshToken, 'refresh rotates the token')
      console.assert((await authService.refresh(res.refreshToken)).accessToken, 'old token works inside the 60 s grace')
      const me = await authService.getMe(userId)
      console.assert(me.tenant.slug === slug && me.employee.code === 'EMP0001' && me.roles.length === 3, 'getMe shape')
      // MFA: setup, enable with a real code, then login asks for the code
      const { secret } = await authService.mfaSetup(userId)
      await authService.mfaEnable(userId, totpAt(secret, currentStep()))
      const gate: any = await authService.login({ email, password: pw, tenantSlug: slug }, 'selfcheck')
      console.assert(gate.mfaRequired && gate.mfaToken, 'login now requires MFA')
      console.assert(await fails(authService.verifyMfaLogin(gate.mfaToken, '000000'), 401), 'bad MFA code is 401')
      // replay protection: a step already used is refused, so wait for the next step before the real code
      await mongoose.connection.collection('users').updateOne({ _id: userId as any }, { $set: { mfaLastStep: 0 } })
      console.assert((await authService.verifyMfaLogin(gate.mfaToken, totpAt(secret, currentStep()))).accessToken, 'good MFA code signs in')
      // password change revokes sessions
      await User.updateOne({ _id: userId }, { mfaEnabled: false }) // MFA off again so the password-change step runs without a code
      const changed: any = await authService.changePassword(userId, pw, 'Brand-new-pass-2')
      console.assert(changed.accessToken && (await fails(authService.refresh(r2.refreshToken), 401)), 'change password revokes old sessions')
      console.assert(await fails(authService.changePassword(userId, 'Brand-new-pass-2', 'short'), 400), 'weak new password refused')
      await authService.logout(changed.refreshToken)
      console.assert(await fails(authService.refresh(changed.refreshToken), 401), 'logout revokes the token')
      console.log('auth self-check done')
    } finally {
      const emp: any = await Employee.findOne({ tenantId }).select('_id').lean()
      if (emp) await mongoose.connection.collection('leave_balances').deleteMany({ employeeId: emp._id } as any)
      for (const c of ['roles', 'users', 'org_units', 'employees', 'audit_logs', 'leave_types', 'activity_types', 'expense_categories', 'payroll_input_types', 'shift_templates', 'resource_calendars'])
        await mongoose.connection.collection(c).deleteMany({ tenantId } as any)
      await Tenant.deleteOne({ _id: tenantId })
      await RefreshToken.deleteMany({ userId })
      await mongoose.disconnect()
      redis.disconnect()
    }
  })().catch((e) => { console.error(e); process.exit(1) })
}
