import crypto from 'crypto'
import { z } from 'zod'
import { prisma } from '../../infrastructure/database/prisma'
import { AppError } from '../../shared/utils/AppError'
import { AccessUser } from '../../shared/utils/access'
import { assertPublicUrl, sign } from '../automation/integrations.service'
import { GL_ACCOUNTS } from '../payroll/payroll.config'

// ERP-agnostic accounting export. A paid (or fully approved) payroll run becomes one balanced journal in a standard
// shape, posted to the company's own ledger accounts, optionally split by department or legal entity. Any ERP takes
// it as generic CSV / JSON / XML, a ready import file (QuickBooks Online; Xero and Tally to check against their
// import screen), or by a signed webhook. The format is documented in docs/integrations/accounting-export.md.

export type AccountKey = keyof typeof GL_ACCOUNTS
export const ACCOUNT_KEYS = Object.keys(GL_ACCOUNTS) as AccountKey[]
const Account = z.object({ code: z.string().trim().min(1).max(40), name: z.string().trim().min(1).max(120) }).strict()
export const SettingsBody = z.object({
  accounts: z.partialRecord(z.enum(ACCOUNT_KEYS as [AccountKey, ...AccountKey[]]), Account).optional(),
  deductionAccounts: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/), Account).optional(),
  splitBy: z.enum(['none', 'department', 'entity']).optional(),
  webhookUrl: z.string().trim().url().max(500).nullable().optional(),
  autoPush: z.boolean().optional(),
  rotateSecret: z.boolean().optional(),
}).strict()
export const FORMATS = ['csv', 'json', 'xml', 'quickbooks', 'xero', 'tally'] as const
export type Format = (typeof FORMATS)[number]

export interface JournalLine { accountKey: string; accountCode: string; accountName: string; description: string; debit: number; credit: number; dimension: string | null }
export interface Journal {
  journalRef: string; date: string; periodStart: string; periodEnd: string; currency: string; company: string
  splitBy: 'none' | 'department' | 'entity'; lines: JournalLine[]; totals: { debit: number; credit: number }; source: { system: 'MarichiHR'; payrollCycleId: string; payslips: number }
}

const cents = (n: number) => Math.round(Number(n) * 100)
const fromCents = (c: number) => Math.round(c) / 100
const ymd = (d: Date) => d.toISOString().slice(0, 10)
const mustPay = (u: AccessUser) => { if (!u.roleIds.some((r) => ['payroll_admin', 'compliance_officer'].includes(r))) throw new AppError('Payroll manages the accounting export', 403) }

async function settingsRow(tenantId: string) {
  return (await prisma.accountingSettings.findUnique({ where: { tenantId } })) ?? { tenantId, accounts: {}, deductionAccounts: {}, splitBy: 'none', webhookUrl: null, webhookSecret: null, autoPush: false }
}

// ─── Journal ─────────────────────────────────────────────────────────────────────────────────────────────
export async function buildJournal(tenantId: string, cycleId: string): Promise<Journal> {
  const cycle = await prisma.payrollCycle.findFirst({ where: { id: cycleId, tenantId } })
  if (!cycle) throw new AppError('Payroll run not found', 404)
  const done = cycle.status === 'disbursed' || cycle.status === 'locked' || (cycle.status === 'approved' && cycle.approvedBy && cycle.financeApprovedBy)
  if (!done) throw new AppError(`The journal is available once the run has both approvals (currently ${cycle.status})`, 400)
  const [s, tenant, slips, entities] = await Promise.all([
    settingsRow(tenantId),
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true, baseCurrency: true } }),
    prisma.payslip.findMany({ where: { payrollCycleId: cycle.id }, select: { grossEarnings: true, netPay: true, currency: true, employee: { select: { orgUnit: { select: { name: true } }, legalEntityId: true } }, lines: { select: { category: true, code: true, name: true, amount: true } } } }),
    prisma.legalEntity.findMany({ where: { tenantId }, select: { id: true, name: true } }),
  ])
  if (!slips.length) throw new AppError('This run has no payslips', 400)
  const acc = (k: AccountKey) => ({ ...GL_ACCOUNTS[k], ...((s.accounts as any)?.[k] ?? {}) })
  const dedAcc = (code: string) => (s.deductionAccounts as any)?.[code] ?? acc('DEDUCTIONS_PAYABLE')
  const split = (s.splitBy ?? 'none') as Journal['splitBy']
  const dim = (p: (typeof slips)[number]) => split === 'department' ? p.employee.orgUnit?.name ?? 'Unassigned' : split === 'entity' ? entities.find((e) => e.id === p.employee.legalEntityId)?.name ?? 'Whole company' : null
  const period = ymd(cycle.payPeriodStart).slice(0, 7)

  // Sums per dimension, in cents
  const groups = new Map<string | null, { gross: number; net: number; tax: number; employer: number; reimb: number; ded: Map<string, { name: string; c: number }> }>()
  for (const p of slips) {
    const key = dim(p)
    const g = groups.get(key) ?? { gross: 0, net: 0, tax: 0, employer: 0, reimb: 0, ded: new Map() }
    g.gross += cents(p.grossEarnings); g.net += cents(p.netPay)
    for (const l of p.lines) {
      if (l.category === 'TAX') g.tax += cents(l.amount)
      else if (l.category === 'EMP_CONTRIB') g.employer += cents(l.amount)
      else if (l.category === 'REIMB') g.reimb += cents(l.amount)
      else if (l.category === 'DED') { const d = g.ded.get(l.code) ?? { name: l.name, c: 0 }; d.c += cents(l.amount); g.ded.set(l.code, d) }
    }
    groups.set(key, g)
  }
  const lines: JournalLine[] = []
  const add = (accountKey: string, a: { code: string; name: string }, description: string, debit: number, credit: number, dimension: string | null) => {
    if (debit || credit) lines.push({ accountKey, accountCode: a.code, accountName: a.name, description, debit: fromCents(debit), credit: fromCents(credit), dimension })
  }
  for (const [d, g] of groups) {
    const sfx = d ? ` · ${d}` : ''
    add('SALARY_EXPENSE', acc('SALARY_EXPENSE'), `Gross salaries ${period}${sfx}`, g.gross, 0, d)
    add('EMPLOYER_CONTRIB_EXPENSE', acc('EMPLOYER_CONTRIB_EXPENSE'), `Employer contributions ${period}${sfx}`, g.employer, 0, d)
    add('REIMBURSEMENT_EXPENSE', acc('REIMBURSEMENT_EXPENSE'), `Reimbursements ${period}${sfx}`, g.reimb, 0, d)
    add('NET_PAYABLE', acc('NET_PAYABLE'), `Net salaries payable ${period}${sfx}`, 0, g.net, d)
    add('TAX_PAYABLE', acc('TAX_PAYABLE'), `PAYE withheld ${period}${sfx}`, 0, g.tax, d)
    for (const [code, x] of g.ded) add(`DEDUCTION:${code}`, dedAcc(code), `${x.name} (${code}) ${period}${sfx}`, 0, x.c, d)
    add('EMPLOYER_CONTRIB_PAYABLE', acc('EMPLOYER_CONTRIB_PAYABLE'), `Employer contributions payable ${period}${sfx}`, 0, g.employer, d)
  }
  const debit = fromCents(lines.reduce((t, l) => t + cents(l.debit), 0)), credit = fromCents(lines.reduce((t, l) => t + cents(l.credit), 0))
  if (Math.abs(debit - credit) > 0.01) throw new AppError(`The journal does not balance (debits ${debit.toFixed(2)}, credits ${credit.toFixed(2)}); no file produced`, 409)
  return {
    journalRef: `PAYROLL-${period}${cycle.offCycle ? '-OFFCYCLE' : ''}-${cycle.id.slice(0, 8)}`, date: ymd(cycle.payPeriodEnd), periodStart: ymd(cycle.payPeriodStart), periodEnd: ymd(cycle.payPeriodEnd),
    currency: slips[0].currency || tenant?.baseCurrency || 'USD', company: tenant?.name ?? '', splitBy: split, lines, totals: { debit, credit },
    source: { system: 'MarichiHR', payrollCycleId: cycle.id, payslips: slips.length },
  }
}

// ─── Formats ─────────────────────────────────────────────────────────────────────────────────────────────
const csvCell = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
const csv = (rows: unknown[][]) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const money = (n: number) => n.toFixed(2)

export function render(j: Journal, f: Format): { body: string; contentType: string; ext: string } {
  switch (f) {
    case 'json': return { body: JSON.stringify(j, null, 2), contentType: 'application/json', ext: 'json' }
    case 'xml': return { body: `<?xml version="1.0" encoding="UTF-8"?>\n<Journal ref="${xmlEsc(j.journalRef)}" date="${j.date}" currency="${j.currency}" periodStart="${j.periodStart}" periodEnd="${j.periodEnd}" company="${xmlEsc(j.company)}">\n${j.lines.map((l) => `  <Line account="${xmlEsc(l.accountCode)}" accountName="${xmlEsc(l.accountName)}" debit="${money(l.debit)}" credit="${money(l.credit)}"${l.dimension ? ` dimension="${xmlEsc(l.dimension)}"` : ''}>${xmlEsc(l.description)}</Line>`).join('\n')}\n  <Totals debit="${money(j.totals.debit)}" credit="${money(j.totals.credit)}"/>\n</Journal>\n`, contentType: 'application/xml', ext: 'xml' }
    // QuickBooks Online › Import journal entries (columns per Intuit's help article). Account Name must match QBO.
    case 'quickbooks': return { body: csv([['Journal No.', 'Journal Date', 'Account Name', 'Description', 'Debits', 'Credits'], ...j.lines.map((l) => [j.journalRef, j.date, l.accountName, l.dimension ? `${l.description}` : l.description, l.debit ? money(l.debit) : '', l.credit ? money(l.credit) : ''])]), contentType: 'text/csv; charset=utf-8', ext: 'csv' }
    // Xero › Manual journals › Import: debit positive, credit negative. Check the headers against the template Xero
    // offers on that screen before the first import.
    case 'xero': return { body: csv([['*Narration', '*Date', 'Description', '*AccountCode', '*TaxRate', '*Amount', 'TrackingName1', 'TrackingOption1'], ...j.lines.map((l, i) => [i === 0 ? `Payroll ${j.periodStart.slice(0, 7)}` : '', i === 0 ? j.date : '', l.description, l.accountCode, 'Tax Exempt', money(l.debit || -l.credit), l.dimension ? 'Department' : '', l.dimension ?? ''])]), contentType: 'text/csv; charset=utf-8', ext: 'csv' }
    // Tally XML import (Gateway of Tally › Import › Vouchers): one Journal voucher; ledgers must exist in Tally.
    // Debits carry ISDEEMEDPOSITIVE Yes and a negative amount. Test on a copy of the company first.
    case 'tally': return { body: `<ENVELOPE>\n <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>\n <BODY><IMPORTDATA>\n  <REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME></REQUESTDESC>\n  <REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">\n   <VOUCHER VCHTYPE="Journal" ACTION="Create">\n    <DATE>${j.date.replace(/-/g, '')}</DATE>\n    <VOUCHERTYPENAME>Journal</VOUCHERTYPENAME>\n    <VOUCHERNUMBER>${xmlEsc(j.journalRef)}</VOUCHERNUMBER>\n    <NARRATION>${xmlEsc(`Payroll ${j.periodStart} to ${j.periodEnd}`)}</NARRATION>\n${j.lines.map((l) => `    <ALLLEDGERENTRIES.LIST>\n     <LEDGERNAME>${xmlEsc(l.accountName)}</LEDGERNAME>\n     <ISDEEMEDPOSITIVE>${l.debit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>\n     <AMOUNT>${l.debit ? `-${money(l.debit)}` : money(l.credit)}</AMOUNT>\n    </ALLLEDGERENTRIES.LIST>`).join('\n')}\n   </VOUCHER>\n  </TALLYMESSAGE></REQUESTDATA>\n </IMPORTDATA></BODY>\n</ENVELOPE>\n`, contentType: 'application/xml', ext: 'xml' }
    default: return { body: csv([['Date', 'Journal Ref', 'Account Code', 'Account Name', 'Description', 'Debit', 'Credit', 'Dimension'], ...j.lines.map((l) => [j.date, j.journalRef, l.accountCode, l.accountName, l.description, money(l.debit), money(l.credit), l.dimension ?? ''])]), contentType: 'text/csv; charset=utf-8', ext: 'csv' }
  }
}

// ─── Settings, export, push ──────────────────────────────────────────────────────────────────────────────
export const accounting = {
  async settings(u: AccessUser) {
    mustPay(u)
    const s = await settingsRow(u.tenantId)
    return { accounts: Object.fromEntries(ACCOUNT_KEYS.map((k) => [k, { ...GL_ACCOUNTS[k], ...((s.accounts as any)?.[k] ?? {}) }])), deductionAccounts: s.deductionAccounts, splitBy: s.splitBy, webhookUrl: s.webhookUrl, hasSecret: !!s.webhookSecret, autoPush: s.autoPush, formats: FORMATS }
  },
  async save(u: AccessUser, b: z.infer<typeof SettingsBody>) {
    mustPay(u)
    if (b.webhookUrl) await assertPublicUrl(b.webhookUrl)
    const cur = await settingsRow(u.tenantId)
    const newSecret = (b.webhookUrl && !cur.webhookSecret) || b.rotateSecret ? `whsec_${crypto.randomBytes(24).toString('hex')}` : null
    const data = { ...(b.accounts && { accounts: { ...(cur.accounts as object), ...b.accounts } }), ...(b.deductionAccounts && { deductionAccounts: { ...(cur.deductionAccounts as object), ...b.deductionAccounts } }), ...(b.splitBy && { splitBy: b.splitBy }), ...(b.webhookUrl !== undefined && { webhookUrl: b.webhookUrl }), ...(b.autoPush !== undefined && { autoPush: b.autoPush }), ...(newSecret && { webhookSecret: newSecret }) }
    await prisma.accountingSettings.upsert({ where: { tenantId: u.tenantId }, update: data, create: { tenantId: u.tenantId, ...data } })
    await prisma.auditLog.create({ data: { tenantId: u.tenantId, userId: u.userId, action: 'ACCOUNTING_SETTINGS_UPDATED', entityType: 'accounting_settings', entityId: u.tenantId, newValue: { ...b, rotateSecret: undefined, secretIssued: !!newSecret } } })
    return { ...(await accounting.settings(u)), ...(newSecret && { webhookSecret: newSecret }) }
  },
  async export(u: AccessUser, cycleId: string, f: Format) {
    mustPay(u)
    const j = await buildJournal(u.tenantId, cycleId)
    await prisma.auditLog.create({ data: { tenantId: u.tenantId, userId: u.userId, action: 'PAYROLL_GL_EXPORTED', entityType: 'payroll_cycle', entityId: cycleId, newValue: { format: f, lines: j.lines.length, debit: j.totals.debit } } })
    return { ...render(j, f), filename: `journal-${j.periodStart.slice(0, 7)}-${f}` }
  },
  // Sends the journal as JSON to the company's ERP endpoint, signed like our webhooks:
  // X-MarichiHR-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>" with the secret>
  async push(tenantId: string, cycleId: string, actorUserId: string | null) {
    const s = await settingsRow(tenantId)
    if (!s.webhookUrl || !s.webhookSecret) throw new AppError('Set the ERP address first (Accounting export settings)', 400)
    await assertPublicUrl(s.webhookUrl)
    const j = await buildJournal(tenantId, cycleId)
    const body = JSON.stringify({ event: 'payroll.journal', journal: j })
    const ts = Math.floor(Date.now() / 1000)
    let status = 0, error: string | null = null
    try {
      const res = await fetch(s.webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'X-MarichiHR-Event': 'payroll.journal', 'X-MarichiHR-Signature': `t=${ts},v1=${sign(s.webhookSecret, ts, body)}`, 'Idempotency-Key': j.journalRef }, body, signal: AbortSignal.timeout(15_000) })
      status = res.status
    } catch (e: any) { error = String(e?.message || e).slice(0, 200) }
    const ok = status >= 200 && status < 300
    await prisma.auditLog.create({ data: { tenantId, userId: actorUserId, action: ok ? 'PAYROLL_JOURNAL_PUSHED' : 'PAYROLL_JOURNAL_PUSH_FAILED', entityType: 'payroll_cycle', entityId: cycleId, newValue: { status, error, journalRef: j.journalRef } } })
    if (!ok) throw new AppError(`The ERP did not accept the journal (${error ?? `HTTP ${status}`})`, 502)
    return { pushed: true, status, journalRef: j.journalRef }
  },
}

if (require.main === module) {
  const j: Journal = { journalRef: 'PAYROLL-2026-01-abcd', date: '2026-01-31', periodStart: '2026-01-01', periodEnd: '2026-01-31', currency: 'ZMW', company: 'X', splitBy: 'none', totals: { debit: 100, credit: 100 }, source: { system: 'MarichiHR', payrollCycleId: 'c', payslips: 1 },
    lines: [{ accountKey: 'SALARY_EXPENSE', accountCode: '6100', accountName: 'Salaries', description: 'Gross', debit: 100, credit: 0, dimension: null }, { accountKey: 'NET_PAYABLE', accountCode: '2100', accountName: 'Net pay', description: 'Net', debit: 0, credit: 100, dimension: null }] }
  const x = render(j, 'xero').body.split('\r\n')
  console.assert(x[1].includes(',6100,Tax Exempt,100.00') && x[2].includes(',2100,Tax Exempt,-100.00'), 'xero: debit +, credit -', x)
  console.assert(render(j, 'quickbooks').body.split('\r\n')[0] === 'Journal No.,Journal Date,Account Name,Description,Debits,Credits')
  const t = render(j, 'tally').body
  console.assert(t.includes('<ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>\n     <AMOUNT>-100.00') && t.includes('<DATE>20260131</DATE>'), 'tally debit negative')
  console.log('accounting formats ok')
}
