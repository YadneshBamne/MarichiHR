import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../../infrastructure/database/prisma'
import { AppError } from '../../shared/utils/AppError'
import { AccessUser } from '../../shared/utils/access'
import { digitax, digitaxForTenant, digitaxStatus, DigitaxError } from '../../integrations/digitax'

// Approved expense claims recorded as ZRA Smart Invoice purchases through DigiTax (Purchases › Add manual purchase),
// so the company's input VAT on staff purchases is on record with ZRA. Only fields from DigiTax's published schema
// are sent; each expense category maps to an item already registered in DigiTax. Per-diem allowances are not
// purchases and are never sent. Finance (expenses:finance) enters the supplier's TPIN and Smart Invoice number from
// the receipt.
export const SendBody = z.object({
  supplierTin: z.string().regex(/^\d{10}$/, 'TPIN is 10 digits').optional(),
  supplierName: z.string().trim().min(2).max(120).optional(),
  supplierInvoiceNumber: z.number().int().positive().max(2147483647).optional(),
}).strict()

const findSlug = async (slug: string) => (await prisma.tenant.findUnique({ where: { slug }, select: { id: true } }))?.id ?? null
async function mustConnect(tenantId: string) {
  if (!(await digitaxForTenant(tenantId, findSlug))) throw new AppError('DigiTax is not connected for this company', 400)
}
const fail = (e: unknown) => (e instanceof DigitaxError ? new AppError(e.message, e.status >= 500 || e.status === 0 ? 502 : 400) : e)
type Rec = { purchaseId?: string; status?: string; error?: string | null; sentAt?: string; supplierTin?: string; supplierName?: string; supplierInvoiceNumber?: number }

export const smartInvoice = {
  async connected(tenantId: string) { return digitaxForTenant(tenantId, findSlug) },

  // Finance-approved and paid receipt claims in ZMW, with their Smart Invoice record, and the category mapping
  async claims(u: AccessUser) {
    await mustConnect(u.tenantId)
    const [claims, categories] = await Promise.all([
      prisma.reimbursementClaim.findMany({ where: { tenantId: u.tenantId, status: { in: ['finance_approved', 'paid'] }, claimType: { not: 'per_diem' }, homeCurrency: 'ZMW' }, orderBy: { expenseDate: 'desc' }, take: 100, select: { id: true, expenseDate: true, description: true, receiptNumber: true, homeAmount: true, status: true, digitax: true, category: { select: { id: true, name: true, digitaxItemId: true } }, employee: { select: { firstName: true, lastName: true, employeeCode: true } } } }),
      prisma.expenseCategory.findMany({ where: { tenantId: u.tenantId, active: true }, orderBy: { name: 'asc' }, select: { id: true, name: true, digitaxItemId: true } }),
    ])
    return { claims: claims.map((c) => ({ ...c, expenseDate: c.expenseDate.toISOString().slice(0, 10), homeAmount: Number(c.homeAmount) })), categories }
  },

  // DigiTax items to map expense categories to
  async items(u: AccessUser) {
    await mustConnect(u.tenantId)
    try { return (await digitax.items()).map((i) => ({ id: i.id, name: i.item_name, classCode: i.item_class_code ?? null, status: i.status })) } catch (e) { throw fail(e) }
  },

  async mapCategory(u: AccessUser, categoryId: string, itemId: string | null) {
    await mustConnect(u.tenantId)
    const c = await prisma.expenseCategory.findFirst({ where: { id: categoryId, tenantId: u.tenantId } })
    if (!c) throw new AppError('Category not found', 404)
    if (itemId) {
      const item = (await digitax.items().catch((e) => { throw fail(e) })).find((i) => i.id === itemId)
      if (!item) throw new AppError('That item is not in DigiTax', 400)
      // DigiTax refuses purchases against items ZRA has not accepted yet (412)
      if (item.status !== 'COMPLETED') throw new AppError(`That item is ${item.status.toLowerCase()} with ZRA; map it once ZRA has accepted it`, 400)
    }
    await prisma.expenseCategory.update({ where: { id: c.id }, data: { digitaxItemId: itemId } })
    return { categoryId: c.id, digitaxItemId: itemId }
  },

  async send(u: AccessUser, claimId: string, b: z.infer<typeof SendBody>) {
    await mustConnect(u.tenantId)
    const claim = await prisma.reimbursementClaim.findFirst({ where: { id: claimId, tenantId: u.tenantId }, include: { category: true } })
    if (!claim) throw new AppError('Claim not found', 404)
    if (!['finance_approved', 'paid'].includes(claim.status)) throw new AppError('Only finance-approved or paid claims are recorded', 400)
    if (claim.claimType === 'per_diem') throw new AppError('Per-diem allowances are not purchases', 400)
    if (claim.homeCurrency !== 'ZMW') throw new AppError('Smart Invoice purchases are in ZMW', 400)
    if (!claim.category.digitaxItemId) throw new AppError(`Map the category "${claim.category.name}" to a DigiTax item first`, 400)
    const prev = (claim.digitax ?? {}) as Rec
    if (prev.purchaseId && prev.status !== 'FAILED') throw new AppError(`Already recorded (${prev.status})`, 409)

    const amount = Number(claim.homeAmount)
    const body = {
      purchase_date: claim.expenseDate.toISOString().slice(0, 10),
      ...(b.supplierTin && { supplier_tin: b.supplierTin }),
      ...(b.supplierName && { supplier_name: b.supplierName }),
      ...(b.supplierInvoiceNumber && { supplier_invoice_number: b.supplierInvoiceNumber }),
      items: [{ item_id: claim.category.digitaxItemId, quantity: 1, package_unit_quantity: 1, unit_price: amount, discount_rate: 0, discount_amount: 0, total_amount: amount }],
    }
    let rec: Rec
    try {
      const p = await digitax.addPurchase(body)
      rec = { purchaseId: p.id, status: p.status, error: null, sentAt: new Date().toISOString(), ...b }
    } catch (e) {
      rec = { ...prev, status: 'ERROR', error: (e as Error).message.slice(0, 300), sentAt: new Date().toISOString(), ...b }
    }
    await prisma.reimbursementClaim.update({ where: { id: claim.id }, data: { digitax: rec as any } })
    await prisma.auditLog.create({ data: { tenantId: u.tenantId, userId: u.userId, action: rec.status === 'ERROR' ? 'SMART_INVOICE_PURCHASE_FAILED' : 'SMART_INVOICE_PURCHASE_SENT', entityType: 'reimbursement_claim', entityId: claim.id, newValue: { purchaseId: rec.purchaseId ?? null, status: rec.status, error: rec.error ?? null, amount } } })
    if (rec.status === 'ERROR') throw new AppError(rec.error!, 400)
    return rec
  },

  // DigiTax queues purchases for ZRA: PENDING until ZRA answers, then COMPLETED or FAILED
  async refresh(u: AccessUser, claimId: string) {
    await mustConnect(u.tenantId)
    const claim = await prisma.reimbursementClaim.findFirst({ where: { id: claimId, tenantId: u.tenantId } })
    const rec = (claim?.digitax ?? null) as Rec | null
    if (!claim || !rec?.purchaseId) throw new AppError('Not recorded with DigiTax', 404)
    try {
      const p = await digitax.purchase(rec.purchaseId)
      const next = { ...rec, status: p.status }
      await prisma.reimbursementClaim.update({ where: { id: claim.id }, data: { digitax: next as any } })
      return next
    } catch (e) { throw fail(e) }
  },

  // Filing dashboard: connection, purchases by status, ZRA notices
  async overview(u: AccessUser) {
    if (!(await digitaxForTenant(u.tenantId, findSlug))) return { connected: false }
    const [status, rows, notices] = await Promise.all([
      digitaxStatus(),
      prisma.reimbursementClaim.findMany({ where: { tenantId: u.tenantId, digitax: { not: Prisma.DbNull } }, select: { digitax: true } }),
      digitax.notices().catch(() => null),
    ])
    const counts: Record<string, number> = {}
    for (const r of rows) { const s = (r.digitax as Rec | null)?.status; if (s) counts[s] = (counts[s] ?? 0) + 1 }
    return { connected: true, test: status.test, purchases: counts, notices: (notices ?? []).slice(0, 10).map((n) => ({ number: n.notice_number, date: n.notice_date, title: n.title, content: n.content, by: n.by, url: n.detail_url ?? null })), noticesError: notices ? null : 'Could not load ZRA notices' }
  },
}
