import { Router } from 'express'
import { z } from 'zod'
import { authenticate } from './middleware/auth.middleware'
import { requirePermission, requireRoles } from './middleware/rbac.middleware'
import { validate } from './middleware/validate.middleware'
import { asyncHandler } from './shared/utils/asyncHandler'
import { AppError } from './shared/utils/AppError'
import { EntityBody } from './modules/company/entities.service'
import { PayGroup, LegalEntity, Employee, AuditLog } from './infrastructure/mongo/mongo'

// Small routes the payroll and company screens call that sit inline in the Postgres routers: pay groups, legal entities and
// the flexi-basket check. Mounted ahead of the original routers only in MongoDB mode (see app.ts).
// ponytail: the flexi-basket is not ported, so every employee simply has no basket ("enabled: false").

const ser = (d: any) => { if (!d) return d; const { _id, ...rest } = d; return { id: _id, ...rest } }
const countBy = async (tenantId: string, field: 'payGroupId' | 'legalEntityId', ids: string[]) => {
  const rows: any[] = await Employee.aggregate([{ $match: { tenantId, active: true, [field]: { $in: ids } } }, { $group: { _id: `$${field}`, n: { $sum: 1 } } }])
  return new Map<string, number>(rows.map((r) => [r._id, r.n]))
}
const dup = (e: any, msg: string) => { if (e?.code === 11000) throw new AppError(msg, 409); throw e }

const PayGroupBody = z.object({ name: z.string().trim().min(2).max(80), frequency: z.enum(['monthly', 'bi_weekly', 'weekly']), active: z.boolean().optional() }).strict()
const id = z.object({ id: z.string().uuid() })

export const mongoExtras = Router()

mongoExtras.get('/salary/flexi/mine', authenticate, asyncHandler(async (_req, res) => { res.json({ success: true, data: { enabled: false } }) }))

mongoExtras.get('/payroll/pay-groups', authenticate, asyncHandler(async (req, res) => {
  const rows: any[] = await PayGroup.find({ tenantId: req.user!.tenantId }).collation({ locale: 'en', strength: 2 }).sort({ name: 1 }).lean()
  const counts = await countBy(req.user!.tenantId, 'payGroupId', rows.map((r) => r._id))
  res.json({ success: true, data: rows.map((r) => ({ ...ser(r), people: counts.get(r._id) ?? 0 })) })
}))
mongoExtras.post('/payroll/pay-groups', authenticate, requirePermission('payroll:run'), validate(z.object({ body: PayGroupBody })), asyncHandler(async (req, res) => {
  const { tenantId, userId } = req.user!
  const g: any = await PayGroup.create({ tenantId, active: true, ...req.body }).catch((e) => dup(e, 'A pay group with that name exists'))
  await AuditLog.create({ tenantId, userId, action: 'PAY_GROUP_CREATED', entityType: 'pay_group', entityId: g._id, newValue: req.body })
  res.status(201).json({ success: true, data: ser(g.toObject()) })
}))
mongoExtras.put('/payroll/pay-groups/:id', authenticate, requirePermission('payroll:run'), validate(z.object({ params: id, body: PayGroupBody })), asyncHandler(async (req, res) => {
  const g: any = await PayGroup.findOneAndUpdate({ _id: String(req.params.id), tenantId: req.user!.tenantId }, { $set: req.body }, { returnDocument: 'after' }).lean()
  if (!g) throw new AppError('Pay group not found', 404)
  res.json({ success: true, data: ser(g) })
}))

mongoExtras.get('/company/entities', authenticate, asyncHandler(async (req, res) => {
  const rows: any[] = await LegalEntity.find({ tenantId: req.user!.tenantId }).collation({ locale: 'en', strength: 2 }).sort({ name: 1 }).lean()
  const counts = await countBy(req.user!.tenantId, 'legalEntityId', rows.map((r) => r._id))
  res.json({ success: true, data: rows.map((r) => ({ ...ser(r), people: counts.get(r._id) ?? 0 })) })
}))
const saveEntity = (create: boolean) => asyncHandler(async (req, res) => {
  const { tenantId, userId } = req.user!
  const b = { ...req.body, legalName: req.body.legalName ?? null, taxId: req.body.taxId ?? null, address: req.body.address ?? null }
  let row: any
  if (create) row = (await LegalEntity.create({ ...b, tenantId, active: b.active ?? true }).catch((e) => dup(e, 'An entity with that name exists'))).toObject()
  else {
    row = await LegalEntity.findOneAndUpdate({ _id: String(req.params.id), tenantId }, { $set: b }, { returnDocument: 'after' }).lean().catch((e) => dup(e, 'An entity with that name exists'))
    if (!row) throw new AppError('Entity not found', 404)
  }
  await AuditLog.create({ tenantId, userId, action: create ? 'ENTITY_CREATED' : 'ENTITY_UPDATED', entityType: 'legal_entity', entityId: row._id, newValue: req.body })
  res.status(create ? 201 : 200).json({ success: true, data: ser(row) })
})
mongoExtras.post('/company/entities', authenticate, requireRoles('system_admin', 'hr_admin'), validate(z.object({ body: EntityBody })), saveEntity(true))
mongoExtras.put('/company/entities/:id', authenticate, requireRoles('system_admin', 'hr_admin'), validate(z.object({ params: id, body: EntityBody })), saveEntity(false))
