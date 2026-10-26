import { prisma } from '../../infrastructure/database/prisma'
import { notify, userIdsWithRole } from '../../infrastructure/notifications/notify'
import { AppError } from '../../shared/utils/AppError'
import { AccessUser } from '../../shared/utils/access'
import { ADAPTERS, adapterFor, filingMode, FilingReturn } from '../../integrations/filing/adapters'
import { digitaxStatus } from '../../integrations/digitax'
import { smartInvoice } from '../expenses/smart-invoice.service'

// Filing dashboard: every approved or paid run, the returns it owes (from its payslip lines) and their status, and
// submission through the filing adapters (sandbox now; live once the provider keys are set).
const day = (d: Date) => d.toISOString().slice(0, 10)
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const staffOnly = (u: AccessUser) => { if (!u.roleIds.some((r) => ['payroll_admin', 'compliance_officer'].includes(r))) throw new AppError('Forbidden', 403) }

export const filingService = {
  async dashboard(u: AccessUser) {
    staffOnly(u)
    const cycles = await prisma.payrollCycle.findMany({ where: { tenantId: u.tenantId, status: { in: ['approved', 'disbursed', 'locked'] } }, orderBy: { payPeriodStart: 'desc' }, take: 24, select: { id: true, payPeriodStart: true, payPeriodEnd: true, status: true, offCycle: true } })
    const ids = cycles.map((c) => c.id)
    const [sums, filings] = await Promise.all([
      ids.length ? prisma.$queryRaw<{ cycle: string; code: string; total: number }[]>`SELECT p."payrollCycleId" AS cycle, l.code, SUM(l.amount)::float AS total FROM payslip_lines l JOIN payslips p ON p.id = l."payslipId" WHERE p."payrollCycleId" = ANY(${ids}) GROUP BY 1, 2` : [],
      prisma.taxFiling.findMany({ where: { tenantId: u.tenantId, cycleId: { in: ids } } }),
    ])
    const mode = filingMode()
    return {
      mode,
      adapters: ADAPTERS.map((a) => ({ authority: a.authority, label: a.label, provider: a.provider, liveReady: a.keys.every((k) => !!process.env[k]) && a.provider !== null })),
      // DigiTax belongs to one company (DIGITAX_TENANT): others see nothing of it
      ...(await smartInvoice.connected(u.tenantId) ? { digitax: await digitaxStatus(), smartInvoice: await smartInvoice.overview(u) } : {}),
      cycles: cycles.map((c) => ({
        ...c, payPeriodStart: day(c.payPeriodStart), payPeriodEnd: day(c.payPeriodEnd),
        returns: ADAPTERS.map((a) => {
          const amount = round2(sums.filter((s) => s.cycle === c.id && a.codes.includes(s.code)).reduce((t, s) => t + Number(s.total), 0))
          const f = filings.find((x) => x.cycleId === c.id && x.authority === a.authority)
          return amount > 0 || f ? { authority: a.authority, label: a.label, provider: a.provider, amount, filing: f ? { reference: f.reference, status: f.status, mode: f.mode, filedOn: day(f.filedOn) } : null } : null
        }).filter(Boolean),
      })),
    }
  },

  // Packages the return from the run's payslips and sends it through the authority's adapter
  async submit(u: AccessUser, cycleId: string, authority: string) {
    staffOnly(u)
    const a = adapterFor(authority)
    if (!a) throw new AppError('Unknown authority', 404)
    const c = await prisma.payrollCycle.findFirst({ where: { id: cycleId, tenantId: u.tenantId, status: { in: ['approved', 'disbursed', 'locked'] } } })
    if (!c) throw new AppError('Payroll run not found (only approved or paid runs are filed)', 404)
    const existing = await prisma.taxFiling.findUnique({ where: { tenantId_cycleId_authority: { tenantId: u.tenantId, cycleId: c.id, authority } } })
    if (existing && ['submitted', 'accepted', 'filed'].includes(existing.status) && existing.mode !== 'sandbox') throw new AppError(`Already filed (reference ${existing.reference})`, 409)
    const [slips, tenant, entity] = await Promise.all([
      prisma.payslip.findMany({ where: { payrollCycleId: c.id }, select: { grossEarnings: true, currency: true, employee: { select: { employeeCode: true, firstName: true, lastName: true } }, lines: { where: { code: { in: a.codes } }, select: { amount: true } } } }),
      prisma.tenant.findUnique({ where: { id: u.tenantId }, select: { name: true, legalName: true, primaryCountry: true, baseCurrency: true } }),
      c.legalEntityId ? prisma.legalEntity.findFirst({ where: { id: c.legalEntityId, tenantId: u.tenantId } }) : prisma.legalEntity.findFirst({ where: { tenantId: u.tenantId, active: true }, orderBy: { createdAt: 'asc' } }),
    ])
    const rows = slips.map((s) => ({ employeeCode: s.employee.employeeCode, name: `${s.employee.firstName} ${s.employee.lastName}`, gross: Number(s.grossEarnings), amount: round2(s.lines.reduce((t, l) => t + Number(l.amount), 0)) })).filter((r) => r.amount > 0)
    const ret: FilingReturn = {
      authority, period: { from: day(c.payPeriodStart), to: day(c.payPeriodEnd) },
      employer: { name: entity?.legalName ?? entity?.name ?? tenant?.legalName ?? tenant?.name ?? '', taxId: entity?.taxId ?? null, country: entity?.country ?? tenant?.primaryCountry ?? null },
      currency: slips[0]?.currency ?? tenant?.baseCurrency ?? 'USD', rows, total: round2(rows.reduce((t, r) => t + r.amount, 0)),
    }
    const problems = a.validate(ret)
    if (problems.length) throw new AppError(problems.join('. '), 400)
    const mode = filingMode()
    let result
    try { result = await a.submit(ret, mode) } catch (e: any) { throw new AppError(e?.message || 'The filing service did not answer', 502) }
    const data = { reference: result.reference || '(none)', filedOn: new Date(`${day(new Date())}T00:00:00Z`), filedBy: u.userId, mode, status: result.status, response: result.raw as any, note: null }
    const f = await prisma.taxFiling.upsert({ where: { tenantId_cycleId_authority: { tenantId: u.tenantId, cycleId: c.id, authority } }, update: data, create: { tenantId: u.tenantId, cycleId: c.id, authority, ...data } })
    await prisma.auditLog.create({ data: { tenantId: u.tenantId, userId: u.userId, action: 'TAX_RETURN_SUBMITTED', entityType: 'payroll_cycle', entityId: c.id, newValue: { authority, mode, status: result.status, reference: result.reference, rows: rows.length, total: ret.total } } })
    const staff = [...new Set([...(await userIdsWithRole(u.tenantId, 'payroll_admin')), ...(await userIdsWithRole(u.tenantId, 'compliance_officer'))])].filter((x) => x !== u.userId)
    await notify({ tenantId: u.tenantId, userIds: staff, type: 'tax.filed', title: `${authority} return ${result.status}${mode === 'sandbox' ? ' (test mode)' : ''}`, body: `${ret.period.from.slice(0, 7)} · ${rows.length} people · ${ret.total} ${ret.currency} · ref ${data.reference}`, link: '/tax?tab=filings', entityType: 'payroll_cycle', entityId: c.id })
    return { ...f, filedOn: day(f.filedOn), rows: rows.length, total: ret.total }
  },
}
