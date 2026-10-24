import { z } from 'zod'
import { prisma } from '../../infrastructure/database/prisma'
import { AppError } from '../../shared/utils/AppError'
import { AccessUser } from '../../shared/utils/access'

// Legal entities of a group company: each employs people (employees.legalEntityId) and can run its own payroll in its
// own currency (payroll_cycles.legalEntityId). A company with one entity needs none of this.
export const EntityBody = z.object({
  name: z.string().trim().min(2).max(120),
  legalName: z.string().trim().max(200).nullable().optional(),
  country: z.string().regex(/^[A-Z]{2}$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  taxId: z.string().trim().max(60).nullable().optional(),
  address: z.string().trim().max(500).nullable().optional(),
  active: z.boolean().optional(),
}).strict()

export const entityService = {
  async list(u: AccessUser) {
    const rows = await prisma.legalEntity.findMany({ where: { tenantId: u.tenantId }, orderBy: { name: 'asc' } })
    const counts = await prisma.employee.groupBy({ by: ['legalEntityId'], where: { tenantId: u.tenantId, active: true, legalEntityId: { in: rows.map((r) => r.id) } }, _count: true })
    return rows.map((r) => ({ ...r, people: counts.find((c) => c.legalEntityId === r.id)?._count ?? 0 }))
  },
  async save(u: AccessUser, id: string | null, b: z.infer<typeof EntityBody>) {
    const data = { ...b, legalName: b.legalName ?? null, taxId: b.taxId ?? null, address: b.address ?? null }
    try {
      const row = id
        ? await (async () => { const e = await prisma.legalEntity.findFirst({ where: { id, tenantId: u.tenantId } }); if (!e) throw new AppError('Entity not found', 404); return prisma.legalEntity.update({ where: { id }, data }) })()
        : await prisma.legalEntity.create({ data: { ...data, tenantId: u.tenantId } })
      await prisma.auditLog.create({ data: { tenantId: u.tenantId, userId: u.userId, action: id ? 'ENTITY_UPDATED' : 'ENTITY_CREATED', entityType: 'legal_entity', entityId: row.id, newValue: b } })
      return row
    } catch (e: any) {
      if (e?.code === 'P2002') throw new AppError('An entity with that name exists', 409)
      throw e
    }
  },
}

export async function assertEntity(tenantId: string, legalEntityId?: string | null) {
  if (legalEntityId && !(await prisma.legalEntity.findFirst({ where: { id: legalEntityId, tenantId, active: true } }))) throw new AppError('Legal entity not found', 404)
}
