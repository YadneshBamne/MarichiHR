import bcrypt from 'bcryptjs'
import { AppError } from '../../shared/utils/AppError'
import { forgetTenantTimezone } from '../../shared/utils/businessDate'
import { forgetTenantModules } from '../../middleware/module.middleware.mongo'
import { authRepository, completeLogin } from '../auth/auth.mongo'
import { bootstrapCompany } from './company.bootstrap.mongo'
import { APP_KEYS } from './company.catalog'
import { Tenant, OrgUnit, ResourceCalendar, AuditLog } from '../../infrastructure/mongo/mongo'

// MongoDB version of company.service.ts: self-serve signup (the whole workspace in one transaction), company profile,
// installed apps and onboarding.
// ponytail: Google sign-up is off on this version, and the leave credit for the founder and the statutory floors on a country
// change are skipped until the leave module is ported.

const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 40) || 'company'

async function freeSlug(name: string) {
  const base = slugify(name)
  for (let i = 0; i < 20; i++) {
    const slug = i === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 6)}`
    if (!(await Tenant.exists({ slug }))) return slug
  }
  throw new AppError('Could not reserve a workspace address, try a different company name', 409)
}

const ser = (d: any) => { if (!d) return d; const { _id, ...rest } = d; return { id: _id, ...rest } }

export function shape(t: any) {
  return {
    id: t.id, name: t.name, slug: t.slug, legalName: t.legalName, industry: t.industry, companySize: t.companySize,
    primaryCountry: t.primaryCountry, baseCurrency: t.baseCurrency, timezone: t.timezone, logoUrl: t.logoUrl,
    fiscalYearStartMonth: new Date(t.fiscalYearStart).getUTCMonth() + 1, modules: t.modules ?? [], ownerUserId: t.ownerUserId,
    onboardedAt: t.onboardedAt, employeeCodePrefix: t.employeeCodePrefix, employeeCodeDigits: t.employeeCodeDigits,
  }
}

const load = async (tenantId: string) => {
  const t: any = await Tenant.findById(tenantId).lean()
  if (!t) throw new AppError('Company not found', 404)
  return ser(t)
}

export const companyService = {
  async signup(body: { companyName: string; fullName: string; email?: string; password?: string; googleCode?: string }) {
    if (body.googleCode) throw new AppError('Google sign-up is off. Use your email and a password.', 400)
    const email = body.email!.trim().toLowerCase()
    const [slug, passwordHash] = await Promise.all([freeSlug(body.companyName), bcrypt.hash(body.password!, 12)])
    const { tenantId } = await bootstrapCompany({ companyName: body.companyName.trim(), slug, email, fullName: body.fullName, passwordHash })
    const [tenant, owner] = await Promise.all([load(tenantId), authRepository.findUserByEmail(email, tenantId)])
    return { workspace: tenant.slug, ...(await completeLogin(owner!, tenant)) }
  },

  async get(tenantId: string) { return shape(await load(tenantId)) },

  async update(tenantId: string, userId: string, body: Record<string, any>) {
    const before = await load(tenantId)
    const set: Record<string, unknown> = {}
    for (const k of ['name', 'legalName', 'industry', 'companySize', 'primaryCountry', 'baseCurrency', 'timezone', 'logoUrl', 'employeeCodePrefix', 'employeeCodeDigits']) if (body[k] !== undefined) set[k] = body[k]
    const update: any = { $set: set }
    if (body.primaryCountry) update.$addToSet = { countryCodes: body.primaryCountry }
    if (body.fiscalYearStartMonth) set.fiscalYearStart = new Date(Date.UTC(new Date().getUTCFullYear(), body.fiscalYearStartMonth - 1, 1))
    const t: any = ser(await Tenant.findByIdAndUpdate(tenantId, update, { returnDocument: 'after' }).lean())
    // The root org unit carries the company name; keep it in step on rename
    if (body.name && body.name !== before.name) await OrgUnit.updateMany({ tenantId, parentId: { $in: [null, undefined] }, name: before.name }, { name: body.name })
    if (body.timezone) { await ResourceCalendar.updateMany({ tenantId, timezone: before.timezone }, { timezone: body.timezone }); forgetTenantTimezone(tenantId) }
    const { logoUrl: _a, ...oldVal } = shape(before)
    const { logoUrl: _b, ...newVal } = shape(t)
    await AuditLog.create({ tenantId, userId, action: 'COMPANY_UPDATED', entityType: 'tenant', entityId: tenantId, oldValue: oldVal, newValue: { ...newVal, logoChanged: body.logoUrl !== undefined } })
    return shape(t)
  },

  async setModules(tenantId: string, userId: string, modules: string[]) {
    const clean = APP_KEYS.filter((k) => modules.includes(k))
    const before = await load(tenantId)
    const t: any = ser(await Tenant.findByIdAndUpdate(tenantId, { modules: clean }, { returnDocument: 'after' }).lean())
    forgetTenantModules(tenantId)
    await AuditLog.create({ tenantId, userId, action: 'APPS_CHANGED', entityType: 'tenant', entityId: tenantId, oldValue: { modules: before.modules ?? [] }, newValue: { modules: clean } })
    return shape(t)
  },

  async completeOnboarding(tenantId: string) {
    return shape(ser(await Tenant.findByIdAndUpdate(tenantId, { onboardedAt: new Date() }, { returnDocument: 'after' }).lean()))
  },
}
