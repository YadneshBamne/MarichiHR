import { Request, Response, NextFunction } from 'express'
import { authenticate } from './auth.middleware'

export function tenantMiddleware(req: Request, res: Response, next: NextFunction) {
  authenticate(req, res, next)
}
