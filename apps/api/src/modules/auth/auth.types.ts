export interface LoginDto {
  email: string
  password: string
  tenantSlug: string
}

export interface RefreshDto {
  refreshToken: string
}

export interface AuthTokens {
  accessToken: string
  refreshToken: string
  expiresIn: number
}

export interface JwtPayload {
  userId: string
  tenantId: string
  employeeId: string
  roleIds: string[]
  email: string
}
