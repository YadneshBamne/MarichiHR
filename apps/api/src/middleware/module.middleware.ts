import { Request, Response, NextFunction } from 'express'
import { prisma } from '../infrastructure/database/prisma'
import { AppError } from '../shared/utils/AppError'

// Installed apps per company, cached briefly so the gate costs no extra database round trip on most requests
const cache = new Map<string, { modules: string[]; at: number }>()
const TTL_MS = 60_000

export async function tenantModules(tenantId: string): Promise<string[]> {
  const hit = cache.get(tenantId)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.modules
  const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { modules: true } })
  const modules = t?.modules ?? []
  cache.set(tenantId, { modules, at: Date.now() })
  return modules
}

export const forgetTenantModules = (tenantId: string) => cache.delete(tenantId)

// Refuse an app's API when the company hasn't installed it. `except` path prefixes stay open (e.g. contracts under /leave).
export function requireModule(key: string, except: string[] = []) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (except.some((p) => req.path.startsWith(p))) return next()
      const tenantId = req.user?.tenantId
      if (!tenantId) return next() // unauthenticated requests are rejected by the router's own auth
      if (!(await tenantModules(tenantId)).includes(key)) throw new AppError(`The ${key} app is not installed for your company`, 403, 'MODULE_DISABLED')
      next()
    } catch (err) {
      next(err)
    }
  }
}
