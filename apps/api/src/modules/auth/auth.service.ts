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
type LoginTenant = { id: string; name: string; slug: string }

export type LoginResult = (AuthTokens & { user: any }) | { mfaRequired: true; mfaToken: string }

async function issueSession(user: LoginUser, tenant: LoginTenant): Promise<AuthTokens & { user: any }> {
  const roleIds = user.userRoles.map((ur) => ur.role.name)
  const payload: JwtPayload = {
    userId: user.id,
    tenantId: tenant.id,
    employeeId: user.employee?.id || '',
    roleIds,
    email: user.email,
  }

  const accessToken = generateAccessToken(payload)
  const refreshTokenValue = generateRefreshToken()
  const refreshTokenExpiry = getRefreshTokenExpiry()

  await authRepository.createRefreshToken(user.id, refreshTokenValue, refreshTokenExpiry)
  await authRepository.updateLastLogin(user.id)

  return {
    accessToken,
    refreshToken: refreshTokenValue,
    expiresIn: 900,
    user: {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      avatarUrl: user.avatarUrl,
      roles: user.userRoles.map((ur) => ({ id: ur.role.id, name: ur.role.name })),
      employee: user.employee
        ? {
            id: user.employee.id,
            code: user.employee.employeeCode,
            firstName: user.employee.firstName,
            lastName: user.employee.lastName,
          }
        : null,
      tenant: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
      },
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
  async login(dto: LoginDto): Promise<LoginResult> {
    const tenant = await authRepository.findTenantBySlug(dto.tenantSlug)
    if (!tenant) {
      throw new AppError('Invalid credentials', 401)
    }

    const user = await authRepository.findUserByEmail(dto.email, tenant.id)
    if (!user || !user.passwordHash) {
      throw new AppError('Invalid credentials', 401)
    }

    const passwordValid = await bcrypt.compare(dto.password, user.passwordHash)
    if (!passwordValid) {
      throw new AppError('Invalid credentials', 401)
    }

    return completeLogin(user, tenant)
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

    const roleIds = user.userRoles.map((ur) => ur.role.name)
    const payload: JwtPayload = {
      userId: user.id,
      tenantId: user.tenantId,
      employeeId: user.employee?.id || '',
      roleIds,
      email: user.email,
    }

    const accessToken = generateAccessToken(payload)
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
      tenant: user.tenant,
    }
  },
}
