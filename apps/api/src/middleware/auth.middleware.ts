import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { AppError } from '../shared/utils/AppError'
import { blockingPolicies } from '../modules/policies/policies.service'

export interface AuthPayload {
  userId: string
  tenantId: string
  roleIds: string[]
  employeeId?: string
  pwc?: boolean
}

const PWC_ALLOWED = ['/api/v1/auth/me', '/api/v1/auth/change-password', '/api/v1/auth/logout']
// While a critical policy waits for acceptance only these stay open (to read and accept it, and to sign out)
const POLICY_OPEN = ['/api/v1/auth/', '/api/v1/policies', '/api/v1/notifications', '/api/v1/dashboard/counts', '/api/v1/documents/']

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
    const path = req.originalUrl.split('?')[0]
    if (POLICY_OPEN.some((p) => path.startsWith(p))) return next()
    blockingPolicies({ ...payload, employeeId: payload.employeeId ?? '' } as any)
      .then((open) => (open.length ? next(new AppError(`Please read and accept: ${open.map((p) => p.title).join(', ')}`, 403, 'POLICY_ACCEPTANCE_REQUIRED')) : next()))
      .catch(() => next()) // never lock people out because the check itself failed
  } catch (err) {
    if (err instanceof AppError) return next(err)
    next(new AppError('Invalid or expired token', 401))
  }
}
