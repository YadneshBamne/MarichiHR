import { prisma } from '../../infrastructure/database/prisma'

export const authRepository = {
  async findUserByEmail(email: string, tenantId: string) {
    return prisma.user.findFirst({
      where: {
        email,
        tenantId,
        active: true,
      },
      include: {
        employee: {
          select: {
            id: true,
            employeeCode: true,
            firstName: true,
            lastName: true,
            employmentStatus: true,
            orgUnitId: true,
          },
        },
        userRoles: {
          where: {
            OR: [
              { validUntil: null },
              { validUntil: { gt: new Date() } },
            ],
          },
          include: {
            role: {
              select: { id: true, name: true },
            },
          },
        },
      },
    })
  },

  async findTenantBySlug(slug: string) {
    return prisma.tenant.findUnique({
      where: { slug, active: true },
    })
  },

  async createRefreshToken(userId: string, token: string, expiresAt: Date) {
    return prisma.refreshToken.create({
      data: { userId, token, expiresAt },
    })
  },

  async findRefreshToken(token: string) {
    return prisma.refreshToken.findUnique({
      where: { token },
      include: {
        user: {
          include: {
            employee: {
              select: {
                id: true,
                employeeCode: true,
                firstName: true,
                lastName: true,
                employmentStatus: true,
              },
            },
            userRoles: {
              where: {
                OR: [
                  { validUntil: null },
                  { validUntil: { gt: new Date() } },
                ],
              },
              include: {
                role: { select: { id: true, name: true } },
              },
            },
          },
        },
      },
    })
  },

  async revokeRefreshToken(token: string) {
    return prisma.refreshToken.update({
      where: { token },
      data: { revokedAt: new Date() },
    })
  },

  async revokeAllUserRefreshTokens(userId: string) {
    return prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    })
  },

  async updateLastLogin(userId: string) {
    return prisma.user.update({
      where: { id: userId },
      data: { lastLoginAt: new Date() },
    })
  },

  async findUserById(userId: string) {
    return prisma.user.findUnique({
      where: { id: userId },
      include: {
        tenant: {
          select: {
            id: true,
            name: true,
            slug: true,
            baseCurrency: true,
            timezone: true,
            logoUrl: true,
            modules: true,
            onboardedAt: true,
            ownerUserId: true,
          },
        },
        employee: {
          include: {
            orgUnit: { select: { id: true, name: true, type: true } },
            jobPosition: { select: { id: true, title: true } },
            manager: {
              include: {
                user: { select: { fullName: true, avatarUrl: true } },
              },
            },
          },
        },
        userRoles: {
          where: {
            OR: [
              { validUntil: null },
              { validUntil: { gt: new Date() } },
            ],
          },
          include: {
            role: { select: { id: true, name: true, description: true } },
          },
        },
      },
    })
  },
}
