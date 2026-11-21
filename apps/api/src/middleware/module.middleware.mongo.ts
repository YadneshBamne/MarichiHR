import { Request, Response, NextFunction } from 'express'
import { AppError } from '../shared/utils/AppError'
import { hasFeature } from '../modules/company/plans.catalog'
import { Tenant } from '../infrastructure/mongo/mongo'

// MongoDB version of the installed-apps gate. Same cache and same 403 MODULE_DISABLED.
const cache = new Map<string, { modules: string[]; plan?: string | null; addons: string[]; at: number }>()
const TTL_MS = 60_000

async function tenantRow(tenantId: string) {
  const hit = cache.get(tenantId)
  if (hit && Date.now() - hit.at < TTL_MS) return hit
  const t: any = await Tenant.findById(tenantId).select('modules plan addons').lean()
  const row = { modules: (t?.modules ?? []) as string[], plan: t?.plan as string | null | undefined, addons: (t?.addons ?? []) as string[], at: Date.now() }
  cache.set(tenantId, row)
  return row
}
export async function tenantModules(tenantId: string): Promise<string[]> { return (await tenantRow(tenantId)).modules }

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

export async function tenantHasFeature(tenantId: string, key: string) {
  const t = await tenantRow(tenantId)
  return hasFeature(t.plan, t.addons, key)
}

// Refuse a feature the company's plan (plus add-ons) does not include
export function requireFeature(key: string) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user?.tenantId
      if (!tenantId) return next()
      const t = await tenantRow(tenantId)
      if (!hasFeature(t.plan, t.addons, key)) throw new AppError(`Your plan does not include ${key}. Change the plan or add it as an add-on.`, 403, 'NOT_IN_PLAN')
      next()
    } catch (err) { next(err) }
  }
}
