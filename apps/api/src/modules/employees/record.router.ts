import { Router } from 'express'
import { z } from 'zod'
import { requireRoles } from '../../middleware/rbac.middleware'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { LIST_KEYS } from '../masters/masters.catalog'
import { SCALAR_FIELDS } from './record.catalog'
import * as rec from './record.service'

// Full employee record, form builder, custom fields, position history and the rehire check. Mounted inside the
// employees router (after authentication, before its /:id routes).
const id = z.string().uuid()
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
const t = (max = 200) => z.string().trim().max(max)
const opt = (max = 200) => t(max).nullable().optional()
const code = z.string().trim().min(1).max(40)
const year = z.number().int().min(1900).max(2100)
const scalar = z.union([t(500), z.number(), z.boolean(), z.null(), z.array(code).max(30)])

const SECTIONS = {
  addresses: z.object({ kind: z.enum(['present', 'permanent', 'contact']), line1: t().min(1), line2: opt(), city: opt(100), state: opt(100), postalCode: opt(20), country: z.string().length(2).toUpperCase().nullable().optional() }).strict(),
  family: z.object({ name: t(120).min(1), relationship: code, dateOfBirth: ymd.nullable().optional(), gender: code.nullable().optional(), bloodGroup: code.nullable().optional(), nationality: code.nullable().optional(), profession: opt(100), phone: opt(40), isDependent: z.boolean().optional(), nomineeShare: z.number().min(0).max(100).nullable().optional() }).strict(),
  emergencyContacts: z.object({ name: t(120).min(1), relationship: code, phone: t(40).min(5), altPhone: opt(40), email: z.string().trim().email().max(200).nullable().optional(), priority: z.number().int().min(1).max(9).optional() }).strict(),
  education: z.object({ qualification: code, institute: t(160).min(1), specialisation: opt(120), startYear: year.nullable().optional(), endYear: year.nullable().optional(), grade: opt(40) }).strict(),
  previousEmployment: z.object({ company: t(160).min(1), designation: opt(120), fromDate: ymd.nullable().optional(), toDate: ymd.nullable().optional(), reasonForLeaving: opt(300), lastSalary: z.number().min(0).max(1e10).nullable().optional(), currency: z.string().length(3).toUpperCase().nullable().optional(), pfMemberId: opt(40) }).strict(),
} as const
type Section = keyof typeof SECTIONS
const sectionKey = z.enum(Object.keys(SECTIONS) as [Section, ...Section[]])
const Identity = z.object({ documentType: code, number: t(40).min(3).optional(), issueDate: ymd.nullable().optional(), expiryDate: ymd.nullable().optional(), issuingCountry: z.string().length(2).toUpperCase().nullable().optional(), details: opt(100) }).strict()

export const recordRouter = Router()
const hr = requireRoles('hr_admin', 'system_admin')
const p = (req: any, k = 'id') => String(req.params[k])

// Form builder settings: everyone reads them (forms render from them); HR changes them
recordRouter.get('/form-settings', asyncHandler(async (req, res) => res.json({ success: true, data: await rec.fieldSettings(req.user!.tenantId) })))
recordRouter.put('/form-settings', hr, validate(z.object({ body: z.object({ fields: z.array(z.object({ field: z.string().max(40), mode: z.enum(['display', 'mandatory', 'hidden']), employeeCanEdit: z.boolean() }).strict()).min(1).max(100) }).strict() })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await rec.saveFieldSettings(req.user!, req.body.fields) })
}))
const CustomField = z.object({ label: t(80).min(1), section: z.enum(['personal', 'job', 'custom']).optional(), type: z.enum(['text', 'number', 'date', 'yes_no', 'list']), masterList: z.enum(LIST_KEYS as [string, ...string[]]).nullable().optional(), options: z.array(z.object({ code, label: t(80).min(1) }).strict()).max(100).nullable().optional() }).strict()
recordRouter.post('/custom-fields', hr, validate(z.object({ body: CustomField })), asyncHandler(async (req, res) => {
  res.status(201).json({ success: true, data: await rec.saveCustomField(req.user!, null, req.body) })
}))
recordRouter.patch('/custom-fields/:id', hr, validate(z.object({ params: z.object({ id }), body: z.object({ label: t(80).min(1), section: z.enum(['personal', 'job', 'custom']).optional(), options: CustomField.shape.options, active: z.boolean().optional() }).strict() })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await rec.saveCustomField(req.user!, p(req), { ...req.body, type: 'text' }) })
}))
recordRouter.post('/rehire-check', hr, validate(z.object({ body: z.object({ firstName: t(80).min(1), lastName: t(80).min(1), dateOfBirth: ymd.optional(), identities: z.array(z.object({ documentType: code, number: t(40) }).strict()).max(10).optional() }).strict() })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await rec.rehireCheck(req.user!, req.body) })
}))

// The record
recordRouter.get('/:id/record', validate(z.object({ params: z.object({ id }) })), asyncHandler(async (req, res) => res.json({ success: true, data: await rec.getRecord(req.user!, p(req)) })))
recordRouter.patch('/:id/record', validate(z.object({ params: z.object({ id }), body: z.object({ values: z.partialRecord(z.enum(SCALAR_FIELDS as [string, ...string[]]), scalar).optional(), customFields: z.record(z.string().max(40), z.union([t(500), z.number(), z.boolean(), z.null()])).optional() }).strict() })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await rec.updateFields(req.user!, p(req), req.body.values ?? {}, req.body.customFields) })
}))
recordRouter.post('/:id/record/:section', validate(z.object({ params: z.object({ id, section: sectionKey }) })), asyncHandler(async (req, res) => {
  const section = req.params.section as Section
  const body = SECTIONS[section].parse(req.body)
  res.status(201).json({ success: true, data: await rec.addEntry(req.user!, p(req), section, body) })
}))
recordRouter.patch('/:id/record/:section/:entryId', validate(z.object({ params: z.object({ id, section: sectionKey, entryId: id }) })), asyncHandler(async (req, res) => {
  const section = req.params.section as Section
  const body = (SECTIONS[section] as any).partial().parse(req.body)
  res.json({ success: true, data: await rec.updateEntry(req.user!, p(req), section, p(req, 'entryId'), body) })
}))
recordRouter.delete('/:id/record/:section/:entryId', validate(z.object({ params: z.object({ id, section: sectionKey, entryId: id }) })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await rec.removeEntry(req.user!, p(req), req.params.section as Section, p(req, 'entryId')) })
}))

// Identities
recordRouter.post('/:id/identities', validate(z.object({ params: z.object({ id }), body: Identity })), asyncHandler(async (req, res) => {
  res.status(201).json({ success: true, data: await rec.saveIdentity(req.user!, p(req), req.body, null) })
}))
recordRouter.patch('/:id/identities/:identityId', validate(z.object({ params: z.object({ id, identityId: id }), body: Identity.omit({ documentType: true }).extend({ documentType: code.optional() }) })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await rec.saveIdentity(req.user!, p(req), req.body, p(req, 'identityId')) })
}))
recordRouter.post('/:id/identities/:identityId/verify', validate(z.object({ params: z.object({ id, identityId: id }) })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await rec.verifyIdentity(req.user!, p(req), p(req, 'identityId')) })
}))
recordRouter.post('/:id/identities/:identityId/reveal', validate(z.object({ params: z.object({ id, identityId: id }) })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await rec.revealIdentity(req.user!, p(req), p(req, 'identityId')) })
}))
recordRouter.delete('/:id/identities/:identityId', validate(z.object({ params: z.object({ id, identityId: id }) })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await rec.removeIdentity(req.user!, p(req), p(req, 'identityId')) })
}))

// Position history
recordRouter.post('/:id/position', validate(z.object({ params: z.object({ id }), body: z.object({
  effectiveFrom: ymd, orgUnitId: id.optional(), jobPositionId: id.nullable().optional(), managerId: id.nullable().optional(), workLocationId: id.nullable().optional(),
  employmentType: code.optional(), employeeCategory: code.nullable().optional(), reason: t(300).min(2),
}).strict() })), asyncHandler(async (req, res) => {
  res.status(201).json({ success: true, data: await rec.changePosition(req.user!, p(req), req.body) })
}))
recordRouter.get('/:id/manager-on', validate(z.object({ params: z.object({ id }), query: z.object({ date: ymd }) })), asyncHandler(async (req, res) => {
  await rec.getRecord(req.user!, p(req)) // same access rule as the record
  res.json({ success: true, data: await rec.managerOn(req.user!.tenantId, p(req), String(req.query.date)) })
}))
