import { z } from 'zod'
import { prisma } from '../../infrastructure/database/prisma'
import { notify, userIdsWithRole } from '../../infrastructure/notifications/notify'
import { AppError } from '../../shared/utils/AppError'
import { AccessUser } from '../../shared/utils/access'

// Tax notices: the declaration window (open / closing soon), annual certificates released, and statutory returns
// recorded as filed (with the authority's reference) so Payroll and Compliance see what is still to file.

const day = (d: Date) => d.toISOString().slice(0, 10)
const today = () => day(new Date())
const has = (u: AccessUser, r: string) => u.roleIds.includes(r)
const audit = (u: AccessUser, action: string, entityType: string, entityId: string, newValue?: any) =>
  prisma.auditLog.create({ data: { tenantId: u.tenantId, userId: u.userId, action, entityType, entityId, newValue } })
const staff = async (tenantId: string) => [...new Set([...(await userIdsWithRole(tenantId, 'payroll_admin')), ...(await userIdsWithRole(tenantId, 'compliance_officer'))])]
const people = async (tenantId: string) => (await prisma.user.findMany({ where: { tenantId, active: true, employee: { active: true } }, select: { id: true } })).map((x) => x.id)

export const WindowBody = z.object({ year: z.number().int().min(2000).max(2100), opensOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), closesOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict()
export const FilingBody = z.object({ cycleId: z.string().uuid(), authority: z.string().trim().min(2).max(40), reference: z.string().trim().min(2).max(100), filedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), note: z.string().trim().max(300).optional() }).strict()

// Sends what is due for one window; safe to call any number of times (each notice once)
async function windowNotices(w: { id: string; tenantId: string; year: number; opensOn: Date; closesOn: Date; openedAt: Date | null; remindedAt: Date | null }) {
  const t = today(), opens = day(w.opensOn), closes = day(w.closesOn)
  if (!w.openedAt && opens <= t && t <= closes) {
    const claimed = await prisma.taxDeclarationWindow.updateMany({ where: { id: w.id, openedAt: null }, data: { openedAt: new Date() } })
    if (claimed.count) await notify({ tenantId: w.tenantId, userIds: await people(w.tenantId), type: 'tax.declaration_window', title: `Tax declarations for ${w.year} are open`, body: `Declare what you will invest or claim, with proofs, by ${closes}.`, link: '/tax?tab=declaration', entityType: 'tax_declaration_window', entityId: w.id })
  }
  const remindFrom = day(new Date(w.closesOn.getTime() - 3 * 86_400_000))
  if (!w.remindedAt && remindFrom <= t && t <= closes) {
    const claimed = await prisma.taxDeclarationWindow.updateMany({ where: { id: w.id, remindedAt: null }, data: { remindedAt: new Date() } })
    if (claimed.count) {
      const doneEmps = (await prisma.taxDeclaration.findMany({ where: { tenantId: w.tenantId, year: w.year, status: { in: ['submitted', 'verified'] } }, select: { employeeId: true } })).map((d) => d.employeeId)
      const done = new Set((await prisma.employee.findMany({ where: { tenantId: w.tenantId, id: { in: doneEmps } }, select: { userId: true } })).map((e) => e.userId))
      const due = (await people(w.tenantId)).filter((x) => !done.has(x))
      await notify({ tenantId: w.tenantId, userIds: due, type: 'tax.declaration_window', title: `Tax declarations close on ${closes}`, body: `Submit your ${w.year} declaration before then, or tax is worked out without it.`, link: '/tax?tab=declaration', entityType: 'tax_declaration_window', entityId: w.id })
    }
  }
}

// Daily job: windows that open today, or close within 3 days
export async function declarationWindowJob(tenantId: string) {
  const t = new Date(`${today()}T00:00:00Z`)
  const rows = await prisma.taxDeclarationWindow.findMany({ where: { tenantId, closesOn: { gte: t }, OR: [{ openedAt: null }, { remindedAt: null }] } })
  for (const w of rows) await windowNotices(w)
  return { windows: rows.length }
}

// Called before a declaration is submitted
export async function assertWindowOpen(tenantId: string, year: number) {
  const w = await prisma.taxDeclarationWindow.findUnique({ where: { tenantId_year: { tenantId, year } } })
  if (!w) return
  const t = today()
  if (t < day(w.opensOn)) throw new AppError(`Declarations for ${year} open on ${day(w.opensOn)}`, 400)
  if (t > day(w.closesOn)) throw new AppError(`Declarations for ${year} closed on ${day(w.closesOn)}. Ask Payroll if you still need to change yours.`, 400)
}

export const taxNotices = {
  async window(u: AccessUser, year: number) {
    const w = await prisma.taxDeclarationWindow.findUnique({ where: { tenantId_year: { tenantId: u.tenantId, year } } })
    return w ? { year: w.year, opensOn: day(w.opensOn), closesOn: day(w.closesOn), open: day(w.opensOn) <= today() && today() <= day(w.closesOn) } : null
  },
  async setWindow(u: AccessUser, b: z.infer<typeof WindowBody>) {
    if (!has(u, 'payroll_admin')) throw new AppError('Payroll sets the declaration window', 403)
    if (b.closesOn < b.opensOn) throw new AppError('The window closes before it opens', 400)
    const data = { opensOn: new Date(`${b.opensOn}T00:00:00Z`), closesOn: new Date(`${b.closesOn}T00:00:00Z`) }
    const w = await prisma.taxDeclarationWindow.upsert({ where: { tenantId_year: { tenantId: u.tenantId, year: b.year } }, update: { ...data, remindedAt: null }, create: { tenantId: u.tenantId, year: b.year, ...data, createdBy: u.userId } })
    await audit(u, 'TAX_DECLARATION_WINDOW_SET', 'tax_declaration_window', w.id, b)
    await windowNotices(w)
    return taxNotices.window(u, b.year)
  },

  async releases(u: AccessUser) {
    return prisma.taxCertificateRelease.findMany({ where: { tenantId: u.tenantId }, orderBy: { year: 'desc' } })
  },
  // Everyone paid in that year is told their certificate is ready (once per year and basis)
  async releaseCertificates(u: AccessUser, year: number, basis: 'calendar' | 'april') {
    if (!has(u, 'payroll_admin')) throw new AppError('Payroll releases certificates', 403)
    const from = basis === 'april' ? new Date(Date.UTC(year, 3, 1)) : new Date(Date.UTC(year, 0, 1))
    const to = basis === 'april' ? new Date(Date.UTC(year + 1, 2, 31)) : new Date(Date.UTC(year, 11, 31))
    if (to > new Date()) throw new AppError('Release certificates after the year has ended', 400)
    const paid = await prisma.payslip.findMany({ where: { payrollCycle: { tenantId: u.tenantId, status: { in: ['disbursed', 'locked'] }, payPeriodEnd: { gte: from, lte: to } } }, select: { employee: { select: { userId: true } } }, distinct: ['employeeId'] })
    const users = paid.map((p) => p.employee.userId).filter((x): x is string => !!x)
    let r
    try { r = await prisma.taxCertificateRelease.create({ data: { tenantId: u.tenantId, year, basis, releasedBy: u.userId, people: users.length } }) } catch (e: any) { if (e?.code === 'P2002') throw new AppError('Already released for that year', 409); throw e }
    await audit(u, 'TAX_CERTIFICATES_RELEASED', 'tax_certificate_release', r.id, { year, basis, people: users.length })
    const label = basis === 'april' ? `${year}-${String(year + 1).slice(2)}` : String(year)
    await notify({ tenantId: u.tenantId, userIds: users, type: 'tax.certificate', title: `Your ${label} tax certificate is ready`, body: 'Download it from My tax statement.', link: '/tax', entityType: 'tax_certificate_release', entityId: r.id })
    return { ...r, notified: users.length }
  },

  // Filing status: every approved or paid regular run with the returns recorded as filed
  async filings(u: AccessUser) {
    if (!has(u, 'payroll_admin') && !has(u, 'compliance_officer')) throw new AppError('Forbidden', 403)
    const [cycles, rows] = await Promise.all([
      prisma.payrollCycle.findMany({ where: { tenantId: u.tenantId, status: { in: ['approved', 'disbursed', 'locked'] } }, orderBy: { payPeriodStart: 'desc' }, take: 24, select: { id: true, payPeriodStart: true, payPeriodEnd: true, status: true, offCycle: true } }),
      prisma.taxFiling.findMany({ where: { tenantId: u.tenantId } }),
    ])
    const users = await prisma.user.findMany({ where: { tenantId: u.tenantId, id: { in: [...new Set(rows.map((r) => r.filedBy))] } }, select: { id: true, fullName: true } })
    return cycles.map((c) => ({ ...c, payPeriodStart: day(c.payPeriodStart), payPeriodEnd: day(c.payPeriodEnd), filings: rows.filter((r) => r.cycleId === c.id).map((r) => ({ ...r, filedOn: day(r.filedOn), filedByName: users.find((x) => x.id === r.filedBy)?.fullName ?? null })) }))
  },
  async recordFiling(u: AccessUser, b: z.infer<typeof FilingBody>) {
    if (!has(u, 'payroll_admin') && !has(u, 'compliance_officer')) throw new AppError('Payroll or Compliance records filings', 403)
    const c = await prisma.payrollCycle.findFirst({ where: { id: b.cycleId, tenantId: u.tenantId, status: { in: ['approved', 'disbursed', 'locked'] } } })
    if (!c) throw new AppError('Payroll run not found (only approved or paid runs are filed)', 404)
    if (b.filedOn > today()) throw new AppError('The filing date is in the future', 400)
    const f = await prisma.taxFiling.upsert({
      where: { tenantId_cycleId_authority: { tenantId: u.tenantId, cycleId: c.id, authority: b.authority } },
      update: { reference: b.reference, filedOn: new Date(`${b.filedOn}T00:00:00Z`), note: b.note ?? null, filedBy: u.userId },
      create: { tenantId: u.tenantId, cycleId: c.id, authority: b.authority, reference: b.reference, filedOn: new Date(`${b.filedOn}T00:00:00Z`), note: b.note ?? null, filedBy: u.userId },
    })
    await audit(u, 'TAX_RETURN_FILED', 'payroll_cycle', c.id, { authority: b.authority, reference: b.reference, filedOn: b.filedOn })
    const month = c.payPeriodStart.toLocaleString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    await notify({ tenantId: u.tenantId, userIds: (await staff(u.tenantId)).filter((x) => x !== u.userId), type: 'tax.filed', title: `${b.authority} return for ${month} filed`, body: `Reference ${b.reference}, filed ${b.filedOn}.`, link: '/tax?tab=filings', entityType: 'payroll_cycle', entityId: c.id })
    return f
  },
}
