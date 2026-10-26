import { z } from 'zod'
import { prisma } from '../../infrastructure/database/prisma'
import { AppError } from '../../shared/utils/AppError'
import { AccessUser } from '../../shared/utils/access'
import { BankFileRow } from './payroll.export'

// Bank salary-file layouts a company configures to match its bank: delimited (CSV, semicolon, pipe…), fixed-width,
// or ISO 20022 pain.001.001.03 XML. Columns are fields of the payment; preamble/trailer lines and constant columns
// take {tokens}: {date:YYYYMMDD}, {count}, {total}, {totalCents}, {hashFnb} and the company's own values in `vars`
// ({ownAccount}, {corporateId}…). Presets are starting points, each marked with where it comes from; sources and
// what could not be verified are listed in docs/integrations/bank-formats.md.
export const FIELDS = ['employeeCode', 'name', 'bankName', 'accountNumber', 'branchSwift', 'amount', 'amountCents', 'currency', 'reference', 'paymentDate', 'text'] as const
const Column = z.object({
  field: z.enum(FIELDS),
  label: z.string().trim().max(40).optional(),
  width: z.number().int().min(1).max(200).optional(), // fixed-width: characters; delimited: maximum length (cut)
  align: z.enum(['left', 'right']).optional(),
  pad: z.string().length(1).optional(), // fixed-width: fill character (' ' or '0')
  format: z.string().trim().max(60).optional(), // paymentDate: YYYYMMDD | DD/MM/YYYY | YYYY-MM-DD…; text: the value, {tokens} allowed
}).strict()
const VarName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,30}$/)
export const FormatBody = z.object({
  name: z.string().trim().min(2).max(80),
  kind: z.enum(['delimited', 'fixed', 'pain001']),
  delimiter: z.string().min(1).max(3).default(','),
  header: z.boolean().default(true),
  columns: z.array(Column).max(30).default([]),
  vars: z.record(VarName, z.string().trim().max(140)).default({}),
  preamble: z.array(z.string().max(500)).max(5).default([]),
  trailer: z.array(z.string().max(500)).max(5).default([]),
  active: z.boolean().optional(),
}).strict()
type Format = z.infer<typeof FormatBody>
type Col = z.infer<typeof Column>

// verified = layout taken from the bank's or standard body's own published document; confirm = partly documented or
// not published, compare with the bank's template before the first live file; generic = our own starting point.
export interface Preset extends Omit<Format, 'active'> { status: 'verified' | 'confirm' | 'generic'; source?: string; notes?: string; needs?: { key: string; label: string }[] }

export const PRESETS: Preset[] = [
  { status: 'generic', name: 'Generic CSV', kind: 'delimited', delimiter: ',', header: true, vars: {}, preamble: [], trailer: [], columns: [{ field: 'employeeCode', label: 'Employee Code' }, { field: 'name', label: 'Beneficiary Name' }, { field: 'bankName', label: 'Bank Name' }, { field: 'accountNumber', label: 'Account Number' }, { field: 'branchSwift', label: 'Branch/SWIFT' }, { field: 'amount', label: 'Amount' }, { field: 'currency', label: 'Currency' }, { field: 'reference', label: 'Payment Reference' }] },
  { status: 'generic', name: 'Semicolon, date first', kind: 'delimited', delimiter: ';', header: true, vars: {}, preamble: [], trailer: [], columns: [{ field: 'paymentDate', label: 'Date', format: 'DD/MM/YYYY' }, { field: 'accountNumber', label: 'Account' }, { field: 'branchSwift', label: 'Branch' }, { field: 'name', label: 'Name' }, { field: 'amount', label: 'Amount' }, { field: 'reference', label: 'Narrative' }] },
  { status: 'generic', name: 'Fixed width (cents, no header)', kind: 'fixed', delimiter: ',', header: false, vars: {}, preamble: [], trailer: [], columns: [{ field: 'text', format: 'SAL', width: 3 }, { field: 'accountNumber', width: 20, align: 'left' }, { field: 'branchSwift', width: 11, align: 'left' }, { field: 'name', width: 35, align: 'left' }, { field: 'amountCents', width: 15, align: 'right', pad: '0' }, { field: 'paymentDate', width: 8, format: 'YYYYMMDD' }, { field: 'reference', width: 20, align: 'left' }] },
  {
    status: 'verified', name: 'ISO 20022 pain.001.001.03 (XML)', kind: 'pain001', delimiter: ',', header: false, columns: [], preamble: [], trailer: [], vars: {},
    source: 'ISO 20022 message pain.001.001.03 (iso20022.org); Standard Chartered Straight2Bank ISO 20022 FAQ (Aug 2025) lists pain.001 v3 as accepted',
    notes: 'Standard credit transfer file, purpose SALA. Each employee\'s Branch/SWIFT is sent as the bank BIC when it is one, otherwise as a local clearing code. Ask the bank which version (v3 or v9) and which addressing it wants.',
    needs: [{ key: 'debtorName', label: 'Company name as the bank knows it' }, { key: 'debtorAccount', label: 'Account the salaries are paid from' }, { key: 'debtorBic', label: 'Your bank\'s BIC (SWIFT code)' }],
  },
  {
    status: 'confirm', name: 'FNB Zambia: Online Banking Enterprise payments CSV', kind: 'delimited', delimiter: ',', header: false, vars: {},
    source: 'FNB "Payments – CSV Import Guide" (April 2024), published in FNB Zambia\'s OBE downloads',
    notes: 'Columns A–G, lengths, account type codes and the hash total rule follow FNB\'s guide. The guide puts the action date in A2 and your account and hash total in A3/B3 but does not show row 1 or a column-heading row: compare with the template in OBE › Help before the first import. Account type is set to 1 (current); use 2 for savings. Branch code is the 6-digit branch code (FNB universal branch code in Zambia: 260006).',
    needs: [{ key: 'ownAccount', label: 'Your FNB account number the salaries are paid from' }],
    preamble: ['', '{date:YYYY/MM/DD}', '{ownAccount},{hashFnb}'], trailer: [],
    columns: [{ field: 'name', label: 'Recipient Name', width: 20 }, { field: 'accountNumber', label: 'Recipient Account', width: 20 }, { field: 'text', label: 'Recipient Account Type', format: '1' }, { field: 'branchSwift', label: 'Branch Code', width: 6 }, { field: 'amount', label: 'Amount', width: 11 }, { field: 'reference', label: 'Own Reference', width: 20 }, { field: 'reference', label: 'Recipient Reference', width: 20 }],
  },
  {
    status: 'verified', name: 'Union Bank of India: NEFT/RTGS bulk upload (text)', kind: 'delimited', delimiter: ',', header: false, vars: {},
    source: 'Union Bank of India, "NEFT/RTGS File Upload in TEXT Format" (unionbankonline.co.in internet banking demos)',
    notes: 'File header FILEHDR,<corporate id>, then one line per payment: NEFT, your IFSC, your account, employee IFSC, employee account, INR, amount, remarks, name, e-mail, mobile. No commas inside values (they are removed). The bank\'s example amount is a whole number: check once that paise (2 decimals) are accepted. 2 MB per file.',
    needs: [{ key: 'corporateId', label: 'Corporate ID' }, { key: 'payerIfsc', label: 'Your IFSC' }, { key: 'debitAccount', label: 'Account the salaries are paid from' }, { key: 'email', label: 'E-mail for the upload' }, { key: 'mobile', label: 'Mobile for the upload' }],
    preamble: ['FILEHDR,{corporateId}'], trailer: [],
    columns: [{ field: 'text', format: 'NEFT' }, { field: 'text', format: '{payerIfsc}' }, { field: 'text', format: '{debitAccount}' }, { field: 'branchSwift', width: 12 }, { field: 'accountNumber', width: 24 }, { field: 'currency', width: 3 }, { field: 'amount', width: 14 }, { field: 'reference', width: 140 }, { field: 'name', width: 40 }, { field: 'text', format: '{email}' }, { field: 'text', format: '{mobile}' }],
  },
  {
    status: 'confirm', name: 'Nigeria: NIBSS Pay payment schedule (CSV)', kind: 'delimited', delimiter: ',', header: true, vars: {}, preamble: [], trailer: [],
    source: 'NIBSS Pay FAQ (nibss-plc.com.ng/nibss-pay): schedule is CSV with beneficiary name, account number, bank, bank code, amount and narration; up to 100,000 items',
    notes: 'NIBSS lists the fields but not their order or headings: compare with the schedule template on NIBSS Pay or your bank\'s portal. Branch/SWIFT must hold the bank code (CBN 3-digit or NIP code, as the template asks); account numbers are 10-digit NUBAN.',
    columns: [{ field: 'name', label: 'Beneficiary Name' }, { field: 'accountNumber', label: 'Account Number' }, { field: 'bankName', label: 'Bank' }, { field: 'branchSwift', label: 'Bank Code' }, { field: 'amount', label: 'Amount' }, { field: 'reference', label: 'Narration' }],
  },
]

const dateAs = (iso: string, f = 'YYYY-MM-DD') => { const [y, m, d] = iso.split('-'); return f.replace('YYYY', y).replace('YY', y.slice(2)).replace('MM', m).replace('DD', d) }
const cents = (n: number) => Math.round(n * 100)
const ascii = (s: string) => s.normalize('NFKD').replace(/[^\x20-\x7E]/g, '')

// FNB OBE hash total: sum of the recipient account numbers plus your own account number, last 12 digits
export function fnbHash(rows: BankFileRow[], ownAccount: string) {
  const num = (s: string) => BigInt(s.replace(/\D/g, '') || '0')
  const total = rows.reduce((t, r) => t + num(r.accountNumber), num(ownAccount))
  return total.toString().slice(-12).padStart(12, '0')
}

function expander(f: Format, rows: BankFileRow[], paymentDate: string) {
  const totalC = rows.reduce((t, r) => t + cents(r.amount), 0)
  return (s: string) => s.replace(/\{([A-Za-z][A-Za-z0-9_]*)(?::([^}]*))?\}/g, (_m, k: string, arg?: string) => {
    if (k === 'date') return dateAs(paymentDate, arg || 'YYYY-MM-DD')
    if (k === 'count') return String(rows.length)
    if (k === 'total') return (totalC / 100).toFixed(2)
    if (k === 'totalCents') return String(totalC)
    if (k === 'hashFnb') { if (!f.vars?.ownAccount) throw new AppError('Set your own account number (ownAccount) in this layout', 400); return fnbHash(rows, f.vars.ownAccount) }
    const v = f.vars?.[k]
    if (!v) throw new AppError(`Fill in "${k}" in the bank file layout "${f.name}"`, 400)
    return v
  })
}

function value(c: Col, r: BankFileRow, paymentDate: string, expand: (s: string) => string) {
  switch (c.field) {
    case 'amount': return r.amount.toFixed(2)
    case 'amountCents': return String(cents(r.amount))
    case 'paymentDate': return dateAs(paymentDate, c.format)
    case 'text': return expand(c.format ?? '')
    default: return String((r as any)[c.field] ?? '')
  }
}
const quote = (s: string, d: string) => (s.includes(d) || /["\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
const fit = (s: string, c: Col) => {
  const w = c.width ?? s.length
  const clean = ascii(s) // banks expect plain ASCII in fixed-width files
  return clean.length >= w ? clean.slice(0, w) : c.align === 'right' ? clean.padStart(w, c.pad ?? ' ') : clean.padEnd(w, c.pad ?? ' ')
}
const cut = (s: string, c: Col) => (c.width ? s.slice(0, c.width) : s)

const x = (s: string) => ascii(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const isBic = (s: string) => /^[A-Z]{6}[A-Z2-9][A-NP-Z0-9]([A-Z0-9]{3})?$/.test(s)
const agent = (code: string) => (isBic(code) ? `<FinInstnId><BIC>${code}</BIC></FinInstnId>` : `<FinInstnId><ClrSysMmbId><MmbId>${x(code.slice(0, 35))}</MmbId></ClrSysMmbId></FinInstnId>`)

// ISO 20022 pain.001.001.03 customer credit transfer, one payment block per currency, purpose SALA
function pain001(rows: BankFileRow[], f: Format, paymentDate: string) {
  const v = f.vars ?? {}
  for (const k of ['debtorName', 'debtorAccount', 'debtorBic']) if (!v[k]) throw new AppError(`Fill in "${k}" in the bank file layout "${f.name}"`, 400)
  const stamp = new Date().toISOString().slice(0, 19)
  const msgId = `MHR-${paymentDate.replace(/-/g, '')}-${Date.now().toString(36).toUpperCase()}`.slice(0, 35)
  const byCcy = new Map<string, BankFileRow[]>()
  for (const r of rows) byCcy.set(r.currency, [...(byCcy.get(r.currency) ?? []), r])
  const sum = (rs: BankFileRow[]) => (rs.reduce((t, r) => t + cents(r.amount), 0) / 100).toFixed(2)
  const blocks = [...byCcy].map(([ccy, rs], i) => `
    <PmtInf>
      <PmtInfId>${msgId}-${i + 1}</PmtInfId><PmtMtd>TRF</PmtMtd><NbOfTxs>${rs.length}</NbOfTxs><CtrlSum>${sum(rs)}</CtrlSum>
      <PmtTpInf><CtgyPurp><Cd>SALA</Cd></CtgyPurp></PmtTpInf>
      <ReqdExctnDt>${paymentDate}</ReqdExctnDt>
      <Dbtr><Nm>${x(v.debtorName.slice(0, 140))}</Nm></Dbtr>
      <DbtrAcct><Id><Othr><Id>${x(v.debtorAccount.slice(0, 34))}</Id></Othr></Id><Ccy>${ccy}</Ccy></DbtrAcct>
      <DbtrAgt>${agent(v.debtorBic)}</DbtrAgt>${rs.map((r) => `
      <CdtTrfTxInf>
        <PmtId><EndToEndId>${x(r.reference.slice(0, 35))}</EndToEndId></PmtId>
        <Amt><InstdAmt Ccy="${r.currency}">${r.amount.toFixed(2)}</InstdAmt></Amt>
        <CdtrAgt>${agent(r.branchSwift)}</CdtrAgt>
        <Cdtr><Nm>${x(r.name.slice(0, 140))}</Nm></Cdtr>
        <CdtrAcct><Id><Othr><Id>${x(r.accountNumber.slice(0, 34))}</Id></Othr></Id></CdtrAcct>
        <Purp><Cd>SALA</Cd></Purp>
        <RmtInf><Ustrd>${x(r.reference.slice(0, 140))}</Ustrd></RmtInf>
      </CdtTrfTxInf>`).join('')}
    </PmtInf>`).join('')
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <CstmrCdtTrfInitn>
    <GrpHdr><MsgId>${msgId}</MsgId><CreDtTm>${stamp}</CreDtTm><NbOfTxs>${rows.length}</NbOfTxs><CtrlSum>${sum(rows)}</CtrlSum><InitgPty><Nm>${x(v.debtorName.slice(0, 140))}</Nm></InitgPty></GrpHdr>${blocks}
  </CstmrCdtTrfInitn>
</Document>
`
}

export const fileExt = (f: Pick<Format, 'kind'> | null) => (f?.kind === 'pain001' ? 'xml' : f?.kind === 'fixed' ? 'txt' : 'csv')

export function renderBankFile(rows: BankFileRow[], f: Format, paymentDate: string) {
  if (f.kind === 'pain001') return pain001(rows, f, paymentDate)
  const expand = expander(f, rows, paymentDate)
  const lines: string[] = (f.preamble ?? []).map(expand)
  if (f.kind === 'delimited') {
    // Upload files with their own header lines are read line by line, not as CSV: drop the delimiter from values
    // instead of quoting them
    const cell = (s: string) => (f.preamble?.length ? s.split(f.delimiter).join(' ').replace(/"/g, '') : quote(s, f.delimiter))
    if (f.header) lines.push(f.columns.map((c) => cell(c.label ?? c.field)).join(f.delimiter))
    for (const r of rows) lines.push(f.columns.map((c) => cell(cut(value(c, r, paymentDate, expand), c))).join(f.delimiter))
  } else {
    if (f.header) lines.push(f.columns.map((c) => fit(c.label ?? c.field, c)).join(''))
    for (const r of rows) lines.push(f.columns.map((c) => fit(value(c, r, paymentDate, expand), c)).join(''))
  }
  lines.push(...(f.trailer ?? []).map(expand))
  return lines.join('\r\n') + '\r\n'
}

const mustPay = (u: AccessUser) => { if (!u.roleIds.includes('payroll_admin')) throw new AppError('Payroll manages bank file formats', 403) }
export const bankFormats = {
  async list(u: AccessUser) {
    mustPay(u)
    const rows = await prisma.bankFileFormat.findMany({ where: { tenantId: u.tenantId }, orderBy: { name: 'asc' } })
    return { formats: rows, presets: PRESETS, fields: FIELDS }
  },
  async save(u: AccessUser, id: string | null, b: Format) {
    mustPay(u)
    if (b.kind === 'fixed' && b.columns.some((c) => !c.width)) throw new AppError('Give every column a width in a fixed-width file', 400)
    if (b.kind !== 'pain001' && !b.columns.length) throw new AppError('Add at least one column', 400)
    try {
      const data = { ...b, columns: b.columns, vars: b.vars }
      const row = id
        ? await (async () => { const f = await prisma.bankFileFormat.findFirst({ where: { id, tenantId: u.tenantId } }); if (!f) throw new AppError('Format not found', 404); return prisma.bankFileFormat.update({ where: { id }, data }) })()
        : await prisma.bankFileFormat.create({ data: { ...data, tenantId: u.tenantId } })
      // vars hold the company's own account details: the audit row records only which ones are set
      await prisma.auditLog.create({ data: { tenantId: u.tenantId, userId: u.userId, action: id ? 'BANK_FORMAT_UPDATED' : 'BANK_FORMAT_CREATED', entityType: 'bank_file_format', entityId: row.id, newValue: { name: b.name, kind: b.kind, columns: b.columns.length, vars: Object.keys(b.vars ?? {}) } } })
      return row
    } catch (e: any) { if (e?.code === 'P2002') throw new AppError('A format with that name exists', 409); throw e }
  },
}
export async function formatFor(tenantId: string, formatId?: string): Promise<Format | null> {
  if (!formatId) return null
  const f = await prisma.bankFileFormat.findFirst({ where: { id: formatId, tenantId, active: true } })
  if (!f) throw new AppError('Bank file format not found', 404)
  return { name: f.name, kind: f.kind as Format['kind'], delimiter: f.delimiter, header: f.header, columns: f.columns as any, vars: (f.vars ?? {}) as Record<string, string>, preamble: f.preamble, trailer: f.trailer }
}

if (require.main === module) {
  const rows: BankFileRow[] = [{ employeeCode: 'E1', name: 'Mwila Banda', bankName: 'Zanaco', accountNumber: '0123456789', branchSwift: 'ZNCOZMLU', amount: 10984.5, currency: 'ZMW', reference: 'SAL-2026-10-E1' }]
  const fixed = renderBankFile(rows, PRESETS[2], '2026-10-30').split('\r\n')[0]
  console.assert(fixed.length === 3 + 20 + 11 + 35 + 15 + 8 + 20, 'fixed width line length', fixed.length)
  console.assert(fixed.includes('000000001098450') && fixed.includes('20261030'), 'cents zero-padded and date', fixed)
  const semi = renderBankFile(rows, PRESETS[1], '2026-10-30').split('\r\n')
  console.assert(semi[1] === '30/10/2026;0123456789;ZNCOZMLU;Mwila Banda;10984.50;SAL-2026-10-E1', semi[1])

  // FNB hash: 123 + 456 + own 11111111111 = 11111111690 -> 12 digits
  console.assert(fnbHash([{ ...rows[0], accountNumber: '123' }, { ...rows[0], accountNumber: '456' }], '11111111111') === '011111111690', 'fnb hash')
  const fnbP = PRESETS.find((p) => p.name.startsWith('FNB'))!
  const fnb = renderBankFile(rows, { ...fnbP, vars: { ownAccount: '62000000001' } }, '2026-10-30').split('\r\n')
  console.assert(fnb[1] === '2026/10/30' && fnb[2] === `62000000001,${fnbHash(rows, '62000000001')}` && fnb[3] === 'Mwila Banda,0123456789,1,ZNCOZM,10984.50,SAL-2026-10-E1,SAL-2026-10-E1', 'fnb rows', fnb)

  const ubiP = PRESETS.find((p) => p.name.startsWith('Union Bank'))!
  const ubi = renderBankFile([{ ...rows[0], name: 'Banda, Mwila', branchSwift: 'ICIC0000001', currency: 'INR' }], { ...ubiP, vars: { corporateId: 'XYZLTD', payerIfsc: 'UBIN0556688', debitAccount: '566802070000001', email: 'pay@x.com', mobile: '9999999999' } }, '2026-10-30').split('\r\n')
  console.assert(ubi[0] === 'FILEHDR,XYZLTD' && ubi[1] === 'NEFT,UBIN0556688,566802070000001,ICIC0000001,0123456789,INR,10984.50,SAL-2026-10-E1,Banda  Mwila,pay@x.com,9999999999', 'ubi', ubi)
  let threw = false; try { renderBankFile(rows, { ...ubiP, vars: {} }, '2026-10-30') } catch { threw = true }
  console.assert(threw, 'missing company values stop the file')

  const xml = renderBankFile([...rows, { ...rows[0], branchSwift: '260006', amount: 0.1 }], { ...PRESETS[3], vars: { debtorName: 'Acme & Co', debtorAccount: '62000000001', debtorBic: 'FIRNZMLX' } }, '2026-10-30')
  console.assert(xml.includes('<NbOfTxs>2</NbOfTxs><CtrlSum>10984.60</CtrlSum>') && xml.includes('<BIC>ZNCOZMLU</BIC>') && xml.includes('<MmbId>260006</MmbId>') && xml.includes('Acme &amp; Co'), 'pain001')
  if (process.env.PAIN_OUT) require('fs').writeFileSync(process.env.PAIN_OUT, xml) // to validate against the XSD
  console.log('bank formats ok')
}
