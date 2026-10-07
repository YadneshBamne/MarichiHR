import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import { authRepository } from './auth.repository'
import { LoginDto, AuthTokens, JwtPayload } from './auth.types'
import { AppError } from '../../shared/utils/AppError'

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

export const authService = {
  async login(dto: LoginDto): Promise<AuthTokens & { user: any }> {
    const tenant = await authRepository.findTenantBySlug(dto.tenantSlug)
    if (!tenant) {
      throw new AppError('Invalid credentials', 401)
    }

    const user = await authRepository.findUserByEmail(dto.email, tenant.id)
    if (!user || !user.passwordHash) {
      throw new AppError('Invalid credentials', 401)
    }

    if (user.employee && user.employee.employmentStatus === 'terminated') {
      throw new AppError('Account has been deactivated', 401)
    }

    const passwordValid = await bcrypt.compare(dto.password, user.passwordHash)
    if (!passwordValid) {
      throw new AppError('Invalid credentials', 401)
    }

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
        roles: roleIds,
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
