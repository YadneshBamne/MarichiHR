import { Request, Response, NextFunction } from 'express'
import { AppError } from '../shared/utils/AppError'
import { Tenant } from '../infrastructure/mongo/mongo'

// MongoDB version of the installed-apps gate. Same cache and same 403 MODULE_DISABLED.
const cache = new Map<string, { modules: string[]; at: number }>()
const TTL_MS = 60_000

export async function tenantModules(tenantId: string): Promise<string[]> {
  const hit = cache.get(tenantId)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.modules
  const t: any = await Tenant.findById(tenantId).select('modules').lean()
  const modules: string[] = t?.modules ?? []
  cache.set(tenantId, { modules, at: Date.now() })
  return modules
}

export const forgetTenantModules = (tenantId: string) => cache.delete(tenantId)

export function requireModule(key: string, except: string[] = []) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (except.some((p) => req.path.startsWith(p))) return next()
      const tenantId = req.user?.tenantId
      if (!tenantId) return next()
      if (!(await tenantModules(tenantId)).includes(key)) throw new AppError(`The ${key} app is not installed for your company`, 403, 'MODULE_DISABLED')
      next()
    } catch (err) { next(err) }
  }
}
