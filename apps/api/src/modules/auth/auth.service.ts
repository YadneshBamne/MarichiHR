import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import { authRepository } from './auth.repository'
import { LoginDto, AuthTokens, JwtPayload } from './auth.types'
import { AppError } from '../../shared/utils/AppError'
import { prisma } from '../../infrastructure/database/prisma'
import { redis } from '../../infrastructure/cache/redis'
import { encryptField, decryptField } from '../../shared/utils/crypto'
import { generateTotpSecret, verifyTotp, otpauthUrl } from '../../shared/utils/totp'

function generateAccessToken(payload: JwtPayload): string {
  return jwt.sign(payload, process.env.JWT_ACCESS_SECRET!, {
    expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
  } as jwt.SignOptions)
}

function generateRefreshToken(): string {
  return crypto.randomBytes(64).toString('hex')
}

function getRefreshTokenExpiry(): Date {
  const days = 7
  const expiry = new Date()
  expiry.setDate(expiry.getDate() + days)
  return expiry
}

// Short-lived token that proves the password (or Google) step passed and only a TOTP code is missing.
// Signed with a derived secret so `authenticate` can never accept it as an access token.
const mfaSecretKey = () => `${process.env.JWT_ACCESS_SECRET}.mfa`
const MFA_MAX_FAILURES = 5

type LoginUser = NonNullable<Awaited<ReturnType<typeof authRepository.findUserByEmail>>>
type LoginTenant = { id: string; name: string; slug: string; logoUrl?: string | null; modules?: string[]; onboardedAt?: Date | null; ownerUserId?: string | null }

// pwc = "password change required": authenticate() only lets such tokens reach the change-password endpoints
const claimsFor = (user: { id: string; email: string; mustChangePassword?: boolean; userRoles: { role: { name: string } }[]; employee?: { id: string } | null }, tenantId: string): JwtPayload => ({
  userId: user.id,
  tenantId,
  employeeId: user.employee?.id || '',
  roleIds: user.userRoles.map((ur) => ur.role.name),
  email: user.email,
  ...(user.mustChangePassword && { pwc: true }),
})

export const tenantPayload = (t: LoginTenant) => ({ id: t.id, name: t.name, slug: t.slug, logoUrl: t.logoUrl ?? null, modules: t.modules ?? [], onboardedAt: t.onboardedAt ?? null, ownerUserId: t.ownerUserId ?? null })

export const PASSWORD_RULE = 'Use at least 10 characters with a letter and a number'
export const strongPassword = (pw: string) => pw.length >= 10 && /[A-Za-z]/.test(pw) && /\d/.test(pw)

// Failed password attempts per email+IP; after 10 in 15 minutes sign-in is refused for that pair
const LOGIN_MAX_FAILURES = 10
async function guardLogin(key: string) {
  if ((Number(await redis.get(key)) || 0) >= LOGIN_MAX_FAILURES) throw new AppError('Too many failed sign-in attempts. Try again in 15 minutes.', 429)
}
async function failLogin(key: string): Promise<never> {
  await redis.multi().incr(key).expire(key, 900).exec()
  throw new AppError('Invalid credentials', 401)
}

export type LoginResult = (AuthTokens & { user: any }) | { mfaRequired: true; mfaToken: string }

async function issueSession(user: LoginUser, tenant: LoginTenant): Promise<AuthTokens & { user: any }> {
  const accessToken = generateAccessToken(claimsFor(user, tenant.id))
  const refreshTokenValue = generateRefreshToken()
  const refreshTokenExpiry = getRefreshTokenExpiry()

  await Promise.all([authRepository.createRefreshToken(user.id, refreshTokenValue, refreshTokenExpiry), authRepository.updateLastLogin(user.id)])

  return {
    accessToken,
    refreshToken: refreshTokenValue,
    expiresIn: 900,
    user: {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      avatarUrl: user.avatarUrl,
      mfaEnabled: user.mfaEnabled,
      tourDoneAt: user.tourDoneAt,
      mustChangePassword: user.mustChangePassword,
      roles: user.userRoles.map((ur) => ({ id: ur.role.id, name: ur.role.name })),
      employee: user.employee
        ? {
            id: user.employee.id,
            code: user.employee.employeeCode,
            firstName: user.employee.firstName,
            lastName: user.employee.lastName,
          }
        : null,
      tenant: tenantPayload(tenant),
    },
  }
}

// Shared tail of every sign-in path (password, Google): deactivation check, then MFA or a session
export async function completeLogin(user: LoginUser, tenant: LoginTenant): Promise<LoginResult> {
  if (user.employee && user.employee.employmentStatus === 'terminated') {
    throw new AppError('Account has been deactivated', 401)
  }
  if (user.mfaEnabled) {
    const mfaToken = jwt.sign({ sub: user.id, tenantId: tenant.id, purpose: 'mfa' }, mfaSecretKey(), { expiresIn: '5m' })
    return { mfaRequired: true, mfaToken }
  }
  return issueSession(user, tenant)
}

// Wrong codes are counted per user in Redis; after MFA_MAX_FAILURES in 15 minutes every attempt is refused
async function checkTotp(userId: string, secretEnc: string | null, lastStep: number | null, code: string) {
  const key = `mfa:fail:${userId}`
  const failures = Number(await redis.get(key)) || 0
  if (failures >= MFA_MAX_FAILURES) throw new AppError('Too many invalid codes. Try again in 15 minutes.', 429)
  const step = secretEnc ? verifyTotp(decryptField(secretEnc), code, lastStep) : null
  if (step == null) {
    await redis.multi().incr(key).expire(key, 900).exec()
    throw new AppError('Invalid authentication code', 401)
  }
  await redis.del(key)
  await prisma.user.update({ where: { id: userId }, data: { mfaLastStep: step } })
}

export const authService = {
  // The organisation is optional: an email that belongs to exactly one active company signs straight in
  async login(dto: LoginDto, ip = ''): Promise<LoginResult> {
    const email = dto.email.trim().toLowerCase()
    const guardKey = `login:fail:${email}:${ip}`
    await guardLogin(guardKey)
    let tenant = dto.tenantSlug ? await authRepository.findTenantBySlug(dto.tenantSlug.trim().toLowerCase()) : null
    if (dto.tenantSlug && !tenant) return failLogin(guardKey)
    if (!tenant) {
      const matches = await prisma.user.findMany({
        where: { email: { equals: email, mode: 'insensitive' }, active: true, passwordHash: { not: null }, tenant: { active: true } },
        select: { tenant: true }, take: 2,
      })
      if (matches.length > 1) throw new AppError('This email is used in more than one organisation. Enter your organisation to continue.', 400, 'ORG_REQUIRED')
      if (!matches.length) return failLogin(guardKey)
      tenant = matches[0].tenant
    }

    const user = await authRepository.findUserByEmail(email, tenant.id)
    if (!user || !user.passwordHash || !(await bcrypt.compare(dto.password, user.passwordHash))) return failLogin(guardKey)
    await redis.del(guardKey)
    return completeLogin(user, tenant)
  },

  // Required after an HR-issued temporary password; also available to anyone signed in
  async changePassword(userId: string, current: string, next: string) {
    const user = await prisma.user.findUnique({ where: { id: userId }, include: { tenant: true } })
    if (!user || !user.active) throw new AppError('User not found', 404)
    if (!user.passwordHash || !(await bcrypt.compare(current, user.passwordHash))) throw new AppError('Your current password is not correct', 400)
    if (!strongPassword(next)) throw new AppError(PASSWORD_RULE, 400)
    if (current === next) throw new AppError('Choose a password different from the current one', 400)
    await prisma.user.update({ where: { id: userId }, data: { passwordHash: await bcrypt.hash(next, 12), mustChangePassword: false } })
    await authRepository.revokeAllUserRefreshTokens(userId)
    await prisma.auditLog.create({ data: { tenantId: user.tenantId, userId, action: 'PASSWORD_CHANGED', entityType: 'user', entityId: userId } })
    const fresh = await authRepository.findUserByEmail(user.email, user.tenantId)
    return issueSession(fresh!, user.tenant)
  },

  async workspaceBranding(slug: string) {
    const t = await prisma.tenant.findFirst({ where: { slug: slug.toLowerCase(), active: true }, select: { name: true, logoUrl: true } })
    if (!t) throw new AppError('Organisation not found', 404)
    return t
  },

  async verifyMfaLogin(mfaToken: string, code: string) {
    let claims: { sub: string; tenantId: string; purpose: string }
    try {
      claims = jwt.verify(mfaToken, mfaSecretKey()) as any
    } catch {
      throw new AppError('MFA session expired. Sign in again.', 401)
    }
    if (claims.purpose !== 'mfa') throw new AppError('MFA session expired. Sign in again.', 401)
    const tenant = await prisma.tenant.findFirst({ where: { id: claims.tenantId, active: true } })
    const user = await prisma.user.findFirst({ where: { id: claims.sub, tenantId: claims.tenantId, active: true } })
    if (!tenant || !user || !user.mfaEnabled) throw new AppError('MFA session expired. Sign in again.', 401)
    await checkTotp(user.id, user.mfaSecret, user.mfaLastStep, code)
    const full = await authRepository.findUserByEmail(user.email, tenant.id)
    return issueSession(full!, tenant)
  },

  // Enrolment: setup stores a fresh (encrypted) secret, enable proves the app has it, disable needs a current code
  // First-login product tour: done/skipped stamps the time, reset clears it so the tour shows again
  async setTour(userId: string, status: 'done' | 'reset') {
    const r = await prisma.user.updateMany({ where: { id: userId, active: true }, data: { tourDoneAt: status === 'done' ? new Date() : null } })
    if (!r.count) throw new AppError('User not found', 404)
    return { tourDoneAt: status === 'done' ? new Date().toISOString() : null }
  },

  async mfaSetup(userId: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } })
    if (!user || !user.active) throw new AppError('User not found', 404)
    if (user.mfaEnabled) throw new AppError('MFA is already enabled. Disable it first to re-enrol.', 409)
    const secret = generateTotpSecret()
    await prisma.user.update({ where: { id: user.id }, data: { mfaSecret: encryptField(secret), mfaLastStep: null } })
    return { secret, otpauthUrl: otpauthUrl(secret, user.email) }
  },

  async mfaEnable(userId: string, code: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } })
    if (!user || !user.active) throw new AppError('User not found', 404)
    if (user.mfaEnabled) throw new AppError('MFA is already enabled', 409)
    if (!user.mfaSecret) throw new AppError('Start MFA setup first', 400)
    await checkTotp(user.id, user.mfaSecret, user.mfaLastStep, code)
    await prisma.user.update({ where: { id: user.id }, data: { mfaEnabled: true } })
    await prisma.auditLog.create({ data: { tenantId: user.tenantId, userId: user.id, action: 'MFA_ENABLED', entityType: 'user', entityId: user.id } })
    return { mfaEnabled: true }
  },

  async mfaDisable(userId: string, code: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } })
    if (!user || !user.active) throw new AppError('User not found', 404)
    if (!user.mfaEnabled) throw new AppError('MFA is not enabled', 400)
    await checkTotp(user.id, user.mfaSecret, user.mfaLastStep, code)
    await prisma.user.update({ where: { id: user.id }, data: { mfaEnabled: false, mfaSecret: null, mfaLastStep: null } })
    await prisma.auditLog.create({ data: { tenantId: user.tenantId, userId: user.id, action: 'MFA_DISABLED', entityType: 'user', entityId: user.id } })
    return { mfaEnabled: false }
  },

  async refresh(refreshTokenValue: string): Promise<AuthTokens> {
    const storedToken = await authRepository.findRefreshToken(refreshTokenValue)

    if (!storedToken) {
      throw new AppError('Invalid refresh token', 401)
    }

    if (storedToken.revokedAt) {
      throw new AppError('Refresh token has been revoked', 401)
    }

    if (storedToken.expiresAt < new Date()) {
      throw new AppError('Refresh token has expired', 401)
    }

    const user = storedToken.user

    await authRepository.revokeRefreshToken(refreshTokenValue)

    // A deactivated or offboarded user cannot keep a session alive by refreshing
    if (!user.active || user.employee?.employmentStatus === 'terminated') {
      await authRepository.revokeAllUserRefreshTokens(user.id)
      throw new AppError('Account has been deactivated', 401)
    }

    const accessToken = generateAccessToken(claimsFor(user, user.tenantId))
    const newRefreshToken = generateRefreshToken()
    const refreshTokenExpiry = getRefreshTokenExpiry()

    await authRepository.createRefreshToken(user.id, newRefreshToken, refreshTokenExpiry)

    return {
      accessToken,
      refreshToken: newRefreshToken,
      expiresIn: 900,
    }
  },

  async logout(refreshTokenValue: string): Promise<void> {
    const storedToken = await authRepository.findRefreshToken(refreshTokenValue)
    if (storedToken && !storedToken.revokedAt) {
      await authRepository.revokeRefreshToken(refreshTokenValue)
    }
  },

  async getMe(userId: string): Promise<any> {
    const user = await authRepository.findUserById(userId)
    if (!user) {
      throw new AppError('User not found', 404)
    }

    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      avatarUrl: user.avatarUrl,
      mfaEnabled: user.mfaEnabled,
      tourDoneAt: user.tourDoneAt,
      mustChangePassword: user.mustChangePassword,
      lastLoginAt: user.lastLoginAt,
      roles: user.userRoles.map((ur) => ({
        id: ur.role.id,
        name: ur.role.name,
        description: ur.role.description,
        scopeType: ur.scopeType,
        scopeId: ur.scopeId,
      })),
      employee: user.employee
        ? {
            id: user.employee.id,
            code: (user.employee as any).employeeCode,
            firstName: (user.employee as any).firstName,
            lastName: (user.employee as any).lastName,
            employmentStatus: (user.employee as any).employmentStatus,
            orgUnit: (user.employee as any).orgUnit,
            jobPosition: (user.employee as any).jobPosition,
            manager: (user.employee as any).manager,
          }
        : null,
      tenant: tenantPayload(user.tenant),
    }
  },
}
