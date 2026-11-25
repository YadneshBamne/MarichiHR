import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { AppError } from '../shared/utils/AppError'
import { blockingPolicies } from '../modules/policies/policies.service'
import { accessRevoked, watchRevocations } from '../infrastructure/auth/revoke'

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

// A former employee's login (role `alumni` only) opens the alumni page and nothing else: their own pages, sign-in/out and the bell
const ALUMNI_OPEN = ['/api/v1/alumni', '/api/v1/auth', '/api/v1/notifications']
const alumniMayOpen = (path: string) => ALUMNI_OPEN.some((p) => path === p || path.startsWith(p + '/'))

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
    watchRevocations()
    if (accessRevoked(payload.userId, (payload as any).iat)) throw new AppError('Your access has ended. Sign in again.', 401, 'ACCESS_REVOKED')
    req.user = payload
    const path = req.originalUrl.split('?')[0]
    const alumniOnly = (payload as any).roleIds?.length === 1 && (payload as any).roleIds[0] === 'alumni'
    if (alumniOnly && !alumniMayOpen(path)) throw new AppError('This account can only open the alumni page', 403, 'ALUMNI_RESTRICTED')
    if (POLICY_OPEN.some((p) => path.startsWith(p))) return next()
    if (alumniOnly) return next() // former employees are not asked to accept company policies
    blockingPolicies({ ...payload, employeeId: payload.employeeId ?? '' } as any)
      .then((open) => (open.length ? next(new AppError(`Please read and accept: ${open.map((p) => p.title).join(', ')}`, 403, 'POLICY_ACCEPTANCE_REQUIRED')) : next()))
      .catch(() => next()) // never lock people out because the check itself failed
  } catch (err) {
    if (err instanceof AppError) return next(err)
    next(new AppError('Invalid or expired token', 401))
  }
}
