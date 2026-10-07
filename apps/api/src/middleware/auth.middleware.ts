import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { AppError } from '../shared/utils/AppError'

export interface AuthPayload {
  userId: string
  tenantId: string
  roleIds: string[]
  employeeId?: string
  pwc?: boolean
}

const PWC_ALLOWED = ['/api/v1/auth/me', '/api/v1/auth/change-password', '/api/v1/auth/logout']

declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload
    }
  }
}

export function authenticate(req: Request, res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AppError('No token provided', 401)
    }

    const token = authHeader.split(' ')[1]
    const payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET!) as AuthPayload
    if (payload.pwc && !PWC_ALLOWED.some((p) => req.originalUrl.split('?')[0] === p)) {
      throw new AppError('Set a new password before continuing', 403, 'PASSWORD_CHANGE_REQUIRED')
    }
    req.user = payload
    next()
  } catch (err) {
    if (err instanceof AppError) return next(err)
    next(new AppError('Invalid or expired token', 401))
  }
}
