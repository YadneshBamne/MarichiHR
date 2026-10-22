import { randomUUID } from 'crypto'
import { z } from 'zod'
import { prisma } from '../../infrastructure/database/prisma'
import { notify, userIdsWithRole, userIdOfEmployee } from '../../infrastructure/notifications/notify'
import { AppError } from '../../shared/utils/AppError'
import { AccessUser, assertCompensationAccess } from '../../shared/utils/access'
import { storage } from '../../infrastructure/storage/storage'

// Tax declarations: each person lists what they will invest or claim this year, with proof documents; a Payroll
// admin verifies each line (accepting all or part of it) or returns the declaration. Verified amounts in sections
// the computed regime allows lower the TDS projection (India new regime: employer NPS only). Others are recorded.

export const SECTIONS = [
  { key: '80CCD2', label: 'Employer NPS contribution (80CCD(2))', cap: null, newRegime: true },
  { key: '80C', label: 'Investments: PF, PPF, ELSS, life insurance, tuition (80C)', cap: 150000, newRegime: false },
  { key: '80CCD1B', label: 'Own NPS contribution (80CCD(1B))', cap: 50000, newRegime: false },
  { key: '80D', label: 'Health insurance premium (80D)', cap: 50000, newRegime: false },
  { key: 'HRA', label: 'House rent paid (HRA exemption)', cap: null, newRegime: false },
  { key: '24B', label: 'Home loan interest (24(b))', cap: 200000, newRegime: false },
  { key: 'OTHER', label: 'Other (describe it)', cap: null, newRegime: false },
] as const

interface Item { id: string; section: string; description: string; amount: number; documentId?: string | null; verifiedAmount?: number | null; status: 'pending' | 'accepted' | 'rejected' }

export const ItemsBody = z.object({
  regime: z.enum(['new', 'old']).default('new'),
  items: z.array(z.object({
    id: z.string().max(40).optional(),
    section: z.enum(SECTIONS.map((s) => s.key) as [string, ...string[]]),
    description: z.string().trim().max(200).default(''),
    amount: z.number().positive().max(1e9),
    documentId: z.string().uuid().nullable().optional(),
  }).strict()).max(30),
}).strict()
export const VerifyBody = z.object({
  approve: z.boolean(),
  note: z.string().trim().max(500).optional(),
  items: z.array(z.object({ id: z.string().max(40), verifiedAmount: z.number().min(0).max(1e9), status: z.enum(['accepted', 'rejected']) }).strict()).max(30).default([]),
}).strict()

const isPayroll = (u: AccessUser) => u.roleIds.includes('payroll_admin')
const round2 = (n: number) => Math.round(n * 100) / 100

function view(d: any) {
  const items = (d?.items ?? []) as Item[]
  const applied = appliedFrom(items)
  return d ? { ...d, items: items.map((i) => ({ ...i, sectionLabel: SECTIONS.find((s) => s.key === i.section)?.label ?? i.section, appliesToTax: !!SECTIONS.find((s) => s.key === i.section)?.newRegime })), declared: round2(items.reduce((a, i) => a + i.amount, 0)), verified: round2(items.reduce((a, i) => a + (i.status === 'accepted' ? i.verifiedAmount ?? 0 : 0), 0)), applied } : null
}

// Verified amounts the tax computation may use, per section capped
function appliedFrom(items: Item[]) {
  let total = 0
  for (const s of SECTIONS.filter((x) => x.newRegime)) {
    const sum = items.filter((i) => i.section === s.key && i.status === 'accepted').reduce((a, i) => a + (i.verifiedAmount ?? 0), 0)
    total += s.cap == null ? sum : Math.min(s.cap, sum)
  }
  return round2(total)
}

export async function verifiedExemption(tenantId: string, employeeId: string, year: number) {
  const d = await prisma.taxDeclaration.findUnique({ where: { tenantId_employeeId_year: { tenantId, employeeId, year } } })
  return d?.status === 'verified' ? appliedFrom(d.items as unknown as Item[]) : 0
}

export const declarationsService = {
  // Payroll opens a proof only through the declaration that cites it (a 60-second link, audit-logged)
  async proof(u: AccessUser, id: string, documentId: string) {
    if (!u.roleIds.some((r) => ['payroll_admin', 'compliance_officer'].includes(r))) throw new AppError('Not found', 404)
    const d = await prisma.taxDeclaration.findFirst({ where: { id, tenantId: u.tenantId } })
    if (!d || !(d.items as unknown as Item[]).some((i) => i.documentId === documentId)) throw new AppError('Not found', 404)
    const doc = await prisma.employeeDocument.findFirst({ where: { id: documentId, tenantId: u.tenantId, employeeId: d.employeeId, active: true } })
    if (!doc) throw new AppError('Not found', 404)
    const url = await storage().signedUrl(doc.fileKey, 60, doc.fileName)
    await prisma.auditLog.create({ data: { tenantId: u.tenantId, userId: u.userId, action: 'DOCUMENT_DOWNLOADED', entityType: 'employee', entityId: d.employeeId, newValue: { documentId: doc.id, via: 'tax_declaration' } } })
    return { url, expiresInSeconds: 60 }
  },

  sections: () => SECTIONS,

  async get(u: AccessUser, year: number, employeeId?: string) {
    const emp = employeeId ?? u.employeeId
    if (!emp) throw new AppError('Not found', 404)
    await assertCompensationAccess(u, emp)
    return view(await prisma.taxDeclaration.findUnique({ where: { tenantId_employeeId_year: { tenantId: u.tenantId, employeeId: emp, year } } }))
  },

  // The person keeps editing until they submit; a returned declaration can be fixed and sent again
  async save(u: AccessUser, year: number, b: z.infer<typeof ItemsBody>) {
    if (!u.employeeId) throw new AppError('Only employees declare', 403)
    const existing = await prisma.taxDeclaration.findUnique({ where: { tenantId_employeeId_year: { tenantId: u.tenantId, employeeId: u.employeeId, year } } })
    if (existing && !['draft', 'returned'].includes(existing.status)) throw new AppError(`This declaration is ${existing.status}; ask Payroll to return it to change it`, 400)
    const docs = b.items.map((i) => i.documentId).filter(Boolean) as string[]
    if (docs.length && (await prisma.employeeDocument.count({ where: { id: { in: docs }, tenantId: u.tenantId, employeeId: u.employeeId, active: true } })) !== new Set(docs).size) throw new AppError('Proof document not found', 404)
    for (const i of b.items) if (i.section === 'OTHER' && !i.description) throw new AppError('Describe the "Other" item', 400)
    const items: Item[] = b.items.map((i) => ({ id: i.id ?? randomUUID().slice(0, 8), section: i.section, description: i.description, amount: round2(i.amount), documentId: i.documentId ?? null, verifiedAmount: null, status: 'pending' }))
    const data = { regime: b.regime, items: items as any, status: existing?.status === 'returned' ? 'returned' : 'draft' }
    const d = existing
      ? await prisma.taxDeclaration.update({ where: { id: existing.id }, data })
      : await prisma.taxDeclaration.create({ data: { tenantId: u.tenantId, employeeId: u.employeeId, year, ...data } })
    return view(d)
  },

  async submit(u: AccessUser, year: number) {
    if (!u.employeeId) throw new AppError('Only employees declare', 403)
    const d = await prisma.taxDeclaration.findUnique({ where: { tenantId_employeeId_year: { tenantId: u.tenantId, employeeId: u.employeeId, year } } })
    if (!d || !(d.items as unknown as Item[]).length) throw new AppError('Add at least one item first', 400)
    const r = await prisma.taxDeclaration.updateMany({ where: { id: d.id, status: { in: ['draft', 'returned'] } }, data: { status: 'submitted', submittedAt: new Date(), note: null } })
    if (!r.count) throw new AppError(`This declaration is already ${d.status}`, 400)
    await prisma.auditLog.create({ data: { tenantId: u.tenantId, userId: u.userId, action: 'TAX_DECLARATION_SUBMITTED', entityType: 'tax_declaration', entityId: d.id, newValue: { year } } })
    const emp = await prisma.employee.findUnique({ where: { id: u.employeeId }, select: { firstName: true, lastName: true } })
    await notify({ tenantId: u.tenantId, userIds: (await userIdsWithRole(u.tenantId, 'payroll_admin')).filter((x) => x !== u.userId), type: 'payroll.declaration', title: `Tax declaration to verify: ${emp?.firstName} ${emp?.lastName}`, body: `${year}`, link: '/tax?tab=declarations', entityType: 'tax_declaration', entityId: d.id })
    return { status: 'submitted' }
  },

  async list(u: AccessUser, year: number, status?: string) {
    if (!isPayroll(u) && !u.roleIds.includes('compliance_officer')) throw new AppError('Only Payroll sees declarations', 403)
    const rows = await prisma.taxDeclaration.findMany({ where: { tenantId: u.tenantId, year, ...(status ? { status } : { status: { not: 'draft' } }) }, orderBy: { submittedAt: 'asc' } })
    const emps = await prisma.employee.findMany({ where: { id: { in: rows.map((r) => r.employeeId) } }, select: { id: true, firstName: true, lastName: true, employeeCode: true } })
    const name = new Map(emps.map((e) => [e.id, `${e.firstName} ${e.lastName} (${e.employeeCode})`]))
    return rows.map((r) => ({ ...view(r), employee: name.get(r.employeeId) ?? null }))
  },

  // A Payroll admin (never the person themselves) accepts each line, possibly for less, or returns the declaration
  async verify(u: AccessUser, id: string, b: z.infer<typeof VerifyBody>) {
    if (!isPayroll(u)) throw new AppError('Only Payroll admins verify declarations', 403)
    const d = await prisma.taxDeclaration.findFirst({ where: { id, tenantId: u.tenantId } })
    if (!d) throw new AppError('Declaration not found', 404)
    if (d.employeeId === u.employeeId) throw new AppError('You cannot verify your own declaration', 403)
    if (d.status !== 'submitted') throw new AppError(`This declaration is ${d.status}`, 400)
    if (!b.approve && !b.note) throw new AppError('Say what needs fixing', 400)
    const items = (d.items as unknown as Item[]).map((i) => {
      const v = b.items.find((x) => x.id === i.id)
      if (b.approve && !v) throw new AppError(`Decide every line (${SECTIONS.find((s) => s.key === i.section)?.label ?? i.section})`, 400)
      if (v && v.verifiedAmount > i.amount) throw new AppError('A line cannot be verified for more than was declared', 400)
      return v ? { ...i, status: v.status, verifiedAmount: v.status === 'accepted' ? round2(v.verifiedAmount) : 0 } : i
    })
    const r = await prisma.taxDeclaration.updateMany({ where: { id, status: 'submitted' }, data: { items: items as any, status: b.approve ? 'verified' : 'returned', note: b.note ?? null, verifiedBy: b.approve ? u.userId : null, verifiedAt: b.approve ? new Date() : null } })
    if (!r.count) throw new AppError('Someone else just acted on this declaration', 409)
    await prisma.auditLog.create({ data: { tenantId: u.tenantId, userId: u.userId, action: b.approve ? 'TAX_DECLARATION_VERIFIED' : 'TAX_DECLARATION_RETURNED', entityType: 'tax_declaration', entityId: id, newValue: { note: b.note ?? null } } })
    const uid = await userIdOfEmployee(u.tenantId, d.employeeId)
    if (uid) await notify({ tenantId: u.tenantId, userIds: [uid], type: 'payroll.declaration', title: b.approve ? 'Your tax declaration is verified' : 'Your tax declaration needs changes', body: b.note ?? `${d.year}`, link: '/tax?tab=declaration', entityType: 'tax_declaration', entityId: id })
    return view(await prisma.taxDeclaration.findUnique({ where: { id } }))
  },
}
