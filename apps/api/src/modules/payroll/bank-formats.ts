import { z } from 'zod'
import { prisma } from '../../infrastructure/database/prisma'
import { AppError } from '../../shared/utils/AppError'
import { AccessUser } from '../../shared/utils/access'
import { BankFileRow } from './payroll.export'

// Bank salary-file layouts a company configures to match its bank: delimited (CSV, semicolon, pipe…) or fixed-width,
// columns in order, each one a field of the payment. Built-in starting points cover the common shapes; the bank's
// own spec is entered as a new format.
export const FIELDS = ['employeeCode', 'name', 'bankName', 'accountNumber', 'branchSwift', 'amount', 'amountCents', 'currency', 'reference', 'paymentDate', 'text'] as const
const Column = z.object({
  field: z.enum(FIELDS),
  label: z.string().trim().max(40).optional(),
  width: z.number().int().min(1).max(200).optional(), // fixed-width: characters
  align: z.enum(['left', 'right']).optional(),
  pad: z.string().length(1).optional(), // fixed-width: fill character (' ' or '0')
  format: z.string().trim().max(20).optional(), // paymentDate: YYYYMMDD | DD/MM/YYYY | YYYY-MM-DD; text: the constant value
}).strict()
export const FormatBody = z.object({
  name: z.string().trim().min(2).max(80),
  kind: z.enum(['delimited', 'fixed']),
  delimiter: z.string().min(1).max(3).default(','),
  header: z.boolean().default(true),
  columns: z.array(Column).min(1).max(30),
  active: z.boolean().optional(),
}).strict()
type Format = z.infer<typeof FormatBody>

export const PRESETS: Format[] = [
  { name: 'Generic CSV', kind: 'delimited', delimiter: ',', header: true, columns: [{ field: 'employeeCode', label: 'Employee Code' }, { field: 'name', label: 'Beneficiary Name' }, { field: 'bankName', label: 'Bank Name' }, { field: 'accountNumber', label: 'Account Number' }, { field: 'branchSwift', label: 'Branch/SWIFT' }, { field: 'amount', label: 'Amount' }, { field: 'currency', label: 'Currency' }, { field: 'reference', label: 'Payment Reference' }] },
  { name: 'Semicolon, date first', kind: 'delimited', delimiter: ';', header: true, columns: [{ field: 'paymentDate', label: 'Date', format: 'DD/MM/YYYY' }, { field: 'accountNumber', label: 'Account' }, { field: 'branchSwift', label: 'Branch' }, { field: 'name', label: 'Name' }, { field: 'amount', label: 'Amount' }, { field: 'reference', label: 'Narrative' }] },
  { name: 'Fixed width (cents, no header)', kind: 'fixed', delimiter: ',', header: false, columns: [{ field: 'text', format: 'SAL', width: 3 }, { field: 'accountNumber', width: 20, align: 'left' }, { field: 'branchSwift', width: 11, align: 'left' }, { field: 'name', width: 35, align: 'left' }, { field: 'amountCents', width: 15, align: 'right', pad: '0' }, { field: 'paymentDate', width: 8, format: 'YYYYMMDD' }, { field: 'reference', width: 20, align: 'left' }] },
]

const dateAs = (iso: string, f = 'YYYY-MM-DD') => { const [y, m, d] = iso.split('-'); return f.replace('YYYY', y).replace('MM', m).replace('DD', d) }
function value(c: z.infer<typeof Column>, r: BankFileRow, paymentDate: string) {
  switch (c.field) {
    case 'amount': return r.amount.toFixed(2)
    case 'amountCents': return String(Math.round(r.amount * 100))
    case 'paymentDate': return dateAs(paymentDate, c.format)
    case 'text': return c.format ?? ''
    default: return String((r as any)[c.field] ?? '')
  }
}
const quote = (s: string, d: string) => (s.includes(d) || /["\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
const fit = (s: string, c: z.infer<typeof Column>) => {
  const w = c.width ?? s.length
  const clean = s.normalize('NFKD').replace(/[^\x20-\x7E]/g, '') // banks expect plain ASCII in fixed-width files
  return clean.length >= w ? clean.slice(0, w) : c.align === 'right' ? clean.padStart(w, c.pad ?? ' ') : clean.padEnd(w, c.pad ?? ' ')
}

export function renderBankFile(rows: BankFileRow[], f: Format, paymentDate: string) {
  const lines: string[] = []
  if (f.kind === 'delimited') {
    if (f.header) lines.push(f.columns.map((c) => quote(c.label ?? c.field, f.delimiter)).join(f.delimiter))
    for (const r of rows) lines.push(f.columns.map((c) => quote(value(c, r, paymentDate), f.delimiter)).join(f.delimiter))
  } else {
    if (f.header) lines.push(f.columns.map((c) => fit(c.label ?? c.field, c)).join(''))
    for (const r of rows) lines.push(f.columns.map((c) => fit(value(c, r, paymentDate), c)).join(''))
  }
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
    try {
      const row = id
        ? await (async () => { const f = await prisma.bankFileFormat.findFirst({ where: { id, tenantId: u.tenantId } }); if (!f) throw new AppError('Format not found', 404); return prisma.bankFileFormat.update({ where: { id }, data: { ...b, columns: b.columns } }) })()
        : await prisma.bankFileFormat.create({ data: { ...b, columns: b.columns, tenantId: u.tenantId } })
      await prisma.auditLog.create({ data: { tenantId: u.tenantId, userId: u.userId, action: id ? 'BANK_FORMAT_UPDATED' : 'BANK_FORMAT_CREATED', entityType: 'bank_file_format', entityId: row.id, newValue: { name: b.name, kind: b.kind, columns: b.columns.length } } })
      return row
    } catch (e: any) { if (e?.code === 'P2002') throw new AppError('A format with that name exists', 409); throw e }
  },
}
export async function formatFor(tenantId: string, formatId?: string): Promise<Format | null> {
  if (!formatId) return null
  const f = await prisma.bankFileFormat.findFirst({ where: { id: formatId, tenantId, active: true } })
  if (!f) throw new AppError('Bank file format not found', 404)
  return { name: f.name, kind: f.kind as Format['kind'], delimiter: f.delimiter, header: f.header, columns: f.columns as any }
}

if (require.main === module) {
  const rows: BankFileRow[] = [{ employeeCode: 'E1', name: 'Mwila Banda', bankName: 'Zanaco', accountNumber: '0123456789', branchSwift: 'ZNCOZMLU', amount: 10984.5, currency: 'ZMW', reference: 'SAL-2026-10-E1' }]
  const fixed = renderBankFile(rows, PRESETS[2], '2026-10-30').split('\r\n')[0]
  console.assert(fixed.length === 3 + 20 + 11 + 35 + 15 + 8 + 20, 'fixed width line length', fixed.length)
  console.assert(fixed.includes('000000001098450') && fixed.includes('20261030'), 'cents zero-padded and date', fixed)
  const semi = renderBankFile(rows, PRESETS[1], '2026-10-30').split('\r\n')
  console.assert(semi[1] === '30/10/2026;0123456789;ZNCOZMLU;Mwila Banda;10984.50;SAL-2026-10-E1', semi[1])
  console.log('bank formats ok')
}
