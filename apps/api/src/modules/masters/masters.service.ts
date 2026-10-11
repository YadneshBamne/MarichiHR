import { prisma } from '../../infrastructure/database/prisma'
import { AppError } from '../../shared/utils/AppError'
import { MASTER_LISTS, listByKey } from './masters.catalog'

type Actor = { tenantId: string; userId: string }

// Each company gets the catalog's values the first time anything reads its masters (and again when the catalog
// gains new lists or values). Existing rows are never touched, so renamed or retired values stay as the company left them.
const seeded = new Set<string>() // ponytail: per-process; a restarted server re-runs one cheap insert per company
export async function ensureDefaults(tenantId: string) {
  if (seeded.has(tenantId)) return
  await prisma.masterValue.createMany({
    data: MASTER_LISTS.flatMap((l) => l.values.map((val, i) => ({ tenantId, list: l.key, code: val.code, label: val.label, sortOrder: (i + 1) * 10, isSystem: true, meta: (val.meta ?? undefined) as any }))),
    skipDuplicates: true,
  })
  seeded.add(tenantId)
}

const listOrThrow = (key: string) => {
  const l = listByKey.get(key)
  if (!l) throw new AppError('Unknown list', 404)
  return l
}
const audit = (a: Actor, action: string, entityId: string, newValue: any, oldValue?: any) =>
  prisma.auditLog.create({ data: { tenantId: a.tenantId, userId: a.userId, action, entityType: 'master_value', entityId, newValue, oldValue } })
const slug = (s: string) => s.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().toLowerCase().replace(/[\s-]+/g, '_').slice(0, 40) || 'value'

export const mastersService = {
  // Every list with its values; inactive ones only for admins managing them
  async all(tenantId: string, includeInactive: boolean) {
    await ensureDefaults(tenantId)
    const rows = await prisma.masterValue.findMany({ where: { tenantId, ...(includeInactive ? {} : { active: true }) }, orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }] })
    return MASTER_LISTS.map((l) => ({
      key: l.key, name: l.name, group: l.group, description: l.description,
      values: rows.filter((r) => r.list === l.key).map((r) => ({ id: r.id, code: r.code, label: r.label, active: r.active, isSystem: r.isSystem, sortOrder: r.sortOrder, meta: r.meta })),
    }))
  },

  async add(a: Actor, list: string, body: { label: string; code?: string; meta?: Record<string, unknown> }) {
    listOrThrow(list)
    await ensureDefaults(a.tenantId)
    const code = body.code ?? slug(body.label)
    const clash = await prisma.masterValue.findFirst({ where: { tenantId: a.tenantId, list, OR: [{ code }, { label: { equals: body.label, mode: 'insensitive' } }] } })
    if (clash) throw new AppError(clash.code === code ? `The code ${code} is already in this list` : `"${clash.label}" is already in this list${clash.active ? '' : ' (retired: restore it instead)'}`, 409)
    const last = await prisma.masterValue.aggregate({ where: { tenantId: a.tenantId, list }, _max: { sortOrder: true } })
    const row = await prisma.masterValue.create({ data: { tenantId: a.tenantId, list, code, label: body.label, sortOrder: (last._max.sortOrder ?? 0) + 10, meta: (body.meta ?? undefined) as any } })
    await audit(a, 'MASTER_VALUE_ADDED', row.id, { list, code, label: row.label })
    return row
  },

  async update(a: Actor, list: string, id: string, body: { label?: string; active?: boolean; meta?: Record<string, unknown> }) {
    listOrThrow(list)
    const row = await prisma.masterValue.findFirst({ where: { id, tenantId: a.tenantId, list } })
    if (!row) throw new AppError('Value not found', 404)
    if (body.label && body.label.toLowerCase() !== row.label.toLowerCase()) {
      const clash = await prisma.masterValue.findFirst({ where: { tenantId: a.tenantId, list, id: { not: id }, label: { equals: body.label, mode: 'insensitive' } } })
      if (clash) throw new AppError(`"${clash.label}" is already in this list`, 409)
    }
    if (body.active === false) {
      const left = await prisma.masterValue.count({ where: { tenantId: a.tenantId, list, active: true, id: { not: id } } })
      if (!left && list !== 'cost_centre') throw new AppError('Keep at least one active value in this list', 400)
    }
    const updated = await prisma.masterValue.update({ where: { id }, data: body as any })
    await audit(a, body.active === false ? 'MASTER_VALUE_RETIRED' : body.active === true ? 'MASTER_VALUE_RESTORED' : 'MASTER_VALUE_UPDATED', id, { list, code: row.code, ...body }, { label: row.label, active: row.active })
    return updated
  },

  // New order for a whole list (ids from the same company and list only)
  async reorder(a: Actor, list: string, ids: string[]) {
    listOrThrow(list)
    const rows = await prisma.masterValue.findMany({ where: { tenantId: a.tenantId, list }, select: { id: true } })
    if (rows.length !== ids.length || !rows.every((r) => ids.includes(r.id))) throw new AppError('Send every value of the list exactly once', 400)
    await prisma.$transaction(ids.map((id, i) => prisma.masterValue.update({ where: { id }, data: { sortOrder: (i + 1) * 10 } })))
    return { ok: true }
  },
}

// ─── Used by other modules ─────────────────────────────────

// Throws 400 when a value is not an active code of its list: assertMasters(tenantId, { gender: 'female', bank: 'zanaco' })
export async function assertMasters(tenantId: string, values: Record<string, string | null | undefined>) {
  const wanted = Object.entries(values).filter(([, code]) => code != null && code !== '') as [string, string][]
  if (!wanted.length) return
  await ensureDefaults(tenantId)
  const rows = await prisma.masterValue.findMany({ where: { tenantId, active: true, OR: wanted.map(([list, code]) => ({ list, code })) }, select: { list: true, code: true } })
  for (const [list, code] of wanted) {
    if (!rows.some((r) => r.list === list && r.code === code)) throw new AppError(`"${code}" is not in the ${listByKey.get(list)?.name ?? list} list. Pick a value from the list or add it in Masters.`, 400)
  }
}

// Code for something typed by a person (code or label, any case), for imports; null if not in the list
export async function resolveMaster(tenantId: string, list: string, input: string) {
  await ensureDefaults(tenantId)
  const t = input.trim()
  const row = await prisma.masterValue.findFirst({ where: { tenantId, list, active: true, OR: [{ code: { equals: t, mode: 'insensitive' } }, { label: { equals: t, mode: 'insensitive' } }] }, select: { code: true } })
  return row?.code ?? null
}

// Display labels for codes (unknown codes show as stored)
export async function masterLabels(tenantId: string, list: string) {
  await ensureDefaults(tenantId)
  const rows = await prisma.masterValue.findMany({ where: { tenantId, list }, select: { code: true, label: true, meta: true } })
  return new Map(rows.map((r) => [r.code, r]))
}
