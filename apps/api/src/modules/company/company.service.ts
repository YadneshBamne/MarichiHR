import bcrypt from 'bcryptjs'
import { Prisma } from '@prisma/client'
import { prisma } from '../../infrastructure/database/prisma'
import { AppError } from '../../shared/utils/AppError'
import { forgetTenantTimezone } from '../../shared/utils/businessDate'
import { forgetTenantModules } from '../../middleware/module.middleware'
import { authRepository } from '../auth/auth.repository'
import { bootstrapCompany } from './company.bootstrap'
import { completeLogin } from '../auth/auth.service'
import { takeGoogleSignup } from '../auth/google.sso'
import {
  APP_KEYS,
} from './company.catalog'

const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 40) || 'company'

async function freeSlug(name: string) {
  const base = slugify(name)
  for (let i = 0; i < 20; i++) {
    const slug = i === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 6)}`
    if (!(await prisma.tenant.findUnique({ where: { slug }, select: { id: true } }))) return slug
  }
  throw new AppError('Could not reserve a workspace address, try a different company name', 409)
}

export const companyService = {
  // Self-serve signup: a new company with everything a fresh workspace needs, its owner as the first employee,
  // and a signed-in session. The owner then picks apps and fills in the company profile (onboarding).
  async signup(body: { companyName: string; fullName: string; email?: string; password?: string; googleCode?: string }) {
    // With Google: email, account link and photo come from the verified Google profile, and there is no password
    const google = body.googleCode ? await takeGoogleSignup(body.googleCode) : null
    if (body.googleCode && !google) throw new AppError('Your Google sign-up expired. Choose Continue with Google again.', 400)
    const email = (google?.email ?? body.email!).trim().toLowerCase()
    const [slug, passwordHash] = await Promise.all([freeSlug(body.companyName), google ? null : bcrypt.hash(body.password!, 12)])
    const { tenantId } = await bootstrapCompany({ companyName: body.companyName.trim(), slug, email, fullName: body.fullName, passwordHash, googleSub: google?.sub, avatarUrl: google?.picture })
    const [tenant, owner] = await Promise.all([prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } }), authRepository.findUserByEmail(email, tenantId)])
    return { workspace: tenant.slug, ...(await completeLogin(owner!, tenant)) }
  },

  async get(tenantId: string) {
    const t = await prisma.tenant.findUnique({ where: { id: tenantId } })
    if (!t) throw new AppError('Company not found', 404)
    return shape(t)
  },

  async update(tenantId: string, userId: string, body: Record<string, any>) {
    const before = await prisma.tenant.findUnique({ where: { id: tenantId } })
    if (!before) throw new AppError('Company not found', 404)
    const data: Prisma.TenantUpdateInput = {}
    for (const k of ['name', 'legalName', 'industry', 'companySize', 'primaryCountry', 'baseCurrency', 'timezone', 'logoUrl'] as const) {
      if (body[k] !== undefined) (data as any)[k] = body[k]
    }
    if (body.primaryCountry) data.countryCodes = { set: [...new Set([body.primaryCountry, ...before.countryCodes])] }
    if (body.fiscalYearStartMonth) data.fiscalYearStart = new Date(Date.UTC(new Date().getUTCFullYear(), body.fiscalYearStartMonth - 1, 1))
    const t = await prisma.tenant.update({ where: { id: tenantId }, data })
    // The root org unit carries the company name; keep it in step on rename
    if (body.name && body.name !== before.name) await prisma.orgUnit.updateMany({ where: { tenantId, parentId: null, name: before.name }, data: { name: body.name } })
    if (body.timezone) {
      await prisma.resourceCalendar.updateMany({ where: { tenantId, timezone: before.timezone }, data: { timezone: body.timezone } })
      forgetTenantTimezone(tenantId)
    }
    const { logoUrl: _a, ...oldVal } = shape(before)
    const { logoUrl: _b, ...newVal } = shape(t)
    await prisma.auditLog.create({ data: { tenantId, userId, action: 'COMPANY_UPDATED', entityType: 'tenant', entityId: tenantId, oldValue: oldVal as any, newValue: { ...newVal, logoChanged: body.logoUrl !== undefined } as any } })
    return shape(t)
  },

  async setModules(tenantId: string, userId: string, modules: string[]) {
    const clean = APP_KEYS.filter((k) => modules.includes(k))
    const before = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { modules: true } })
    const t = await prisma.tenant.update({ where: { id: tenantId }, data: { modules: clean } })
    forgetTenantModules(tenantId)
    await prisma.auditLog.create({ data: { tenantId, userId, action: 'APPS_CHANGED', entityType: 'tenant', entityId: tenantId, oldValue: { modules: before?.modules ?? [] }, newValue: { modules: clean } } })
    return shape(t)
  },

  async completeOnboarding(tenantId: string) {
    const t = await prisma.tenant.update({ where: { id: tenantId }, data: { onboardedAt: new Date() } })
    return shape(t)
  },
}

export function shape(t: any) {
  return {
    id: t.id, name: t.name, slug: t.slug, legalName: t.legalName, industry: t.industry, companySize: t.companySize,
    primaryCountry: t.primaryCountry, baseCurrency: t.baseCurrency, timezone: t.timezone, logoUrl: t.logoUrl,
    fiscalYearStartMonth: new Date(t.fiscalYearStart).getUTCMonth() + 1, modules: t.modules ?? [], ownerUserId: t.ownerUserId,
    onboardedAt: t.onboardedAt,
  }
}
