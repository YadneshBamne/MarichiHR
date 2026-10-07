import { Router } from 'express'
import { z } from 'zod'
import { authenticate } from '../../middleware/auth.middleware'
import { requireRoles } from '../../middleware/rbac.middleware'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { companyService } from './company.service'
import { APP_KEYS } from './company.catalog'

const isTimeZone = (tz: string) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true } catch { return false } }
// Logos are small images kept inline as data URLs (resized to 256px by the browser before upload)
const logo = z.string().max(400_000, 'Logo is too large; use an image under 300 KB').regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/, 'Logo must be a PNG, JPEG or WebP image')

export const UpdateCompanySchema = z.object({
  body: z.object({
    name: z.string().trim().min(2).max(80).optional(),
    legalName: z.string().trim().max(120).nullable().optional(),
    industry: z.string().trim().max(60).nullable().optional(),
    companySize: z.enum(['1-10', '11-50', '51-200', '201-1000', '1000+']).nullable().optional(),
    primaryCountry: z.string().length(2).toUpperCase().optional(),
    baseCurrency: z.string().length(3).toUpperCase().optional(),
    timezone: z.string().refine(isTimeZone, 'Unknown time zone').optional(),
    fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
    logoUrl: logo.nullable().optional(),
  }).strict(),
})

export const SetModulesSchema = z.object({ body: z.object({ modules: z.array(z.enum(APP_KEYS)).max(APP_KEYS.length) }).strict() })

export const companyRouter = Router()
companyRouter.use(authenticate)

// Everyone in the company can read its profile (name, logo, installed apps); admins change it
companyRouter.get('/', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await companyService.get(req.user!.tenantId) })
}))

const admins = requireRoles('system_admin', 'hr_admin')
companyRouter.patch('/', admins, validate(UpdateCompanySchema), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await companyService.update(req.user!.tenantId, req.user!.userId, req.body) })
}))
companyRouter.put('/modules', requireRoles('system_admin'), validate(SetModulesSchema), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await companyService.setModules(req.user!.tenantId, req.user!.userId, req.body.modules) })
}))
companyRouter.post('/onboarding/complete', admins, asyncHandler(async (req, res) => {
  res.json({ success: true, data: await companyService.completeOnboarding(req.user!.tenantId) })
}))
