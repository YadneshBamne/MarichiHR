import { z } from 'zod'
import { prisma } from '../../infrastructure/database/prisma'
import { AppError } from '../../shared/utils/AppError'
import { AccessUser } from '../../shared/utils/access'
import { ensureDefaults } from '../masters/masters.service'
import type { Col, Report } from './reports.service'

// Report builder: HR picks employee columns (standard, master-backed, custom fields and, for salary roles, current
// pay), filters and an optional grouping, saves it by name and runs it like any ready-made report (table, chart, CSV).

const BUILDERS = ['hr_admin', 'system_admin', 'compliance_officer']
const SALARY = ['hr_admin', 'payroll_admin']
const has = (u: AccessUser, roles: string[]) => u.roleIds.some((r) => roles.includes(r))
const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null)
const years = (from: Date, to = new Date()) => Math.round(((to.getTime() - from.getTime()) / (365.25 * 86_400_000)) * 10) / 10

type Emp = Awaited<ReturnType<typeof loadEmployees>>[number]
type Ctx = { label: (list: string, code: string | null) => string | null }
type Field = { label: string; type?: Col['type']; group: string; salary?: boolean; groupable?: boolean; get: (e: Emp, c: Ctx) => unknown }

const STANDARD: Record<string, Field> = {
  employee_id: { label: 'Employee ID', group: 'Basics', get: (e) => e.employeeCode },
  name: { label: 'Name', group: 'Basics', get: (e) => `${e.firstName} ${e.lastName}`.trim() },
  work_email: { label: 'Work email', group: 'Basics', get: (e) => e.workEmail },
  department: { label: 'Department', group: 'Job', groupable: true, get: (e) => e.orgUnit?.name },
  job_title: { label: 'Job title', group: 'Job', groupable: true, get: (e) => e.jobPosition?.title },
  manager: { label: 'Manager', group: 'Job', groupable: true, get: (e) => (e.manager ? `${e.manager.firstName} ${e.manager.lastName}` : null) },
  work_location: { label: 'Office', group: 'Job', groupable: true, get: (e) => e.workLocation?.name },
  employment_type: { label: 'Employment type', group: 'Job', groupable: true, get: (e, c) => c.label('employment_type', e.employmentType) },
  employee_category: { label: 'Category', group: 'Job', groupable: true, get: (e, c) => c.label('employee_category', e.employeeCategory) },
  cost_centre: { label: 'Cost centre', group: 'Job', groupable: true, get: (e, c) => c.label('cost_centre', e.costCentre) },
  status: { label: 'Status', group: 'Job', groupable: true, get: (e) => (e.active ? e.employmentStatus : 'exited') },
  hire_date: { label: 'Joined', type: 'date', group: 'Dates', get: (e) => ymd(e.hireDate) },
  probation_end: { label: 'Probation ends', type: 'date', group: 'Dates', get: (e) => ymd(e.probationEndDate) },
  confirmation_date: { label: 'Confirmed on', type: 'date', group: 'Dates', get: (e) => ymd(e.confirmationDate) },
  exit_date: { label: 'Exit date', type: 'date', group: 'Dates', get: (e) => ymd(e.exitDate) },
  exit_reason: { label: 'Exit reason', group: 'Dates', groupable: true, get: (e, c) => c.label('exit_reason', e.exitReason) },
  tenure_years: { label: 'Tenure (years)', type: 'number', group: 'Dates', get: (e) => years(e.hireDate, e.exitDate ?? undefined) },
  date_of_birth: { label: 'Date of birth', type: 'date', group: 'Personal', get: (e) => ymd(e.dateOfBirth) },
  age: { label: 'Age', type: 'number', group: 'Personal', get: (e) => (e.dateOfBirth ? Math.floor(years(e.dateOfBirth)) : null) },
  gender: { label: 'Gender', group: 'Personal', groupable: true, get: (e, c) => c.label('gender', e.gender) },
  nationality: { label: 'Nationality', group: 'Personal', groupable: true, get: (e, c) => c.label('nationality', e.nationality) },
  marital_status: { label: 'Marital status', group: 'Personal', groupable: true, get: (e, c) => c.label('marital_status', e.maritalStatus) },
  blood_group: { label: 'Blood group', group: 'Personal', groupable: true, get: (e, c) => c.label('blood_group', e.bloodGroup) },
  personal_email: { label: 'Personal email', group: 'Personal', get: (e) => e.personalEmail },
  mobile: { label: 'Mobile', group: 'Personal', get: (e) => e.mobilePersonal },
  tax_country: { label: 'Tax country', group: 'Personal', groupable: true, get: (e) => e.taxJurisdiction },
  current_wage: { label: 'Monthly wage', type: 'money', group: 'Pay', salary: true, get: (e) => (e.contracts[0] ? Number(e.contracts[0].wageMonthly) : null) },
  ctc_annual: { label: 'Annual CTC', type: 'money', group: 'Pay', salary: true, get: (e) => (e.contracts[0] ? Number(e.contracts[0].ctcAnnual) : null) },
  currency: { label: 'Currency', group: 'Pay', salary: true, groupable: true, get: (e) => e.contracts[0]?.currency },
  salary_structure: { label: 'Salary structure', group: 'Pay', salary: true, groupable: true, get: (e) => e.contracts[0]?.salaryStructure?.name },
}

// Every field this viewer may use, custom fields included (keyed custom:<key>)
async function fieldsFor(user: AccessUser): Promise<Record<string, Field>> {
  const custom = await prisma.customFieldDefinition.findMany({ where: { tenantId: user.tenantId, active: true }, orderBy: { sortOrder: 'asc' } })
  const out: Record<string, Field> = Object.fromEntries(Object.entries(STANDARD).filter(([, f]) => !f.salary || has(user, SALARY)))
  for (const d of custom) {
    out[`custom:${d.key}`] = {
      label: d.label, group: 'Custom fields', groupable: d.type === 'list' || d.type === 'yes_no',
      type: d.type === 'number' ? 'number' : d.type === 'date' ? 'date' : undefined,
      get: (e, c) => {
        const v = (e.customFields as Record<string, unknown> | null)?.[d.key]
        if (v == null || v === '') return null
        if (d.type === 'yes_no') return v ? 'Yes' : 'No'
        if (d.type === 'list') return d.masterList ? c.label(d.masterList, String(v)) : ((d.options as { code: string; label: string }[] | null)?.find((o) => o.code === v)?.label ?? String(v))
        return v
      },
    }
  }
  return out
}

export const BuilderDefinition = z.object({
  name: z.string().trim().min(2).max(80),
  columns: z.array(z.string().max(80)).min(1).max(40),
  groupBy: z.string().max(80).nullable().optional(),
  filters: z.object({
    status: z.enum(['active', 'exited', 'all']).default('active'),
    departmentIds: z.array(z.string().uuid()).max(100).optional(),
    locationIds: z.array(z.string().uuid()).max(100).optional(),
    employmentTypes: z.array(z.string().max(60)).max(30).optional(),
    hiredFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    hiredTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }).strict().default({ status: 'active' }),
}).strict()
export type Definition = z.infer<typeof BuilderDefinition>

function loadEmployees(tenantId: string, f: Definition['filters'], withPay: boolean) {
  return prisma.employee.findMany({
    where: {
      tenantId,
      ...(f.status === 'active' && { active: true }), ...(f.status === 'exited' && { active: false, exitDate: { not: null } }),
      ...(f.departmentIds?.length && { orgUnitId: { in: f.departmentIds } }), ...(f.locationIds?.length && { workLocationId: { in: f.locationIds } }),
      ...(f.employmentTypes?.length && { employmentType: { in: f.employmentTypes } }),
      ...((f.hiredFrom || f.hiredTo) && { hireDate: { ...(f.hiredFrom && { gte: new Date(`${f.hiredFrom}T00:00:00Z`) }), ...(f.hiredTo && { lte: new Date(`${f.hiredTo}T00:00:00Z`) }) } }),
    },
    include: {
      orgUnit: { select: { name: true } }, jobPosition: { select: { title: true } }, workLocation: { select: { name: true } },
      manager: { select: { firstName: true, lastName: true } },
      contracts: withPay
        ? { where: { active: true, status: 'running' }, orderBy: { effectiveFrom: 'desc' }, take: 1, select: { wageMonthly: true, ctcAnnual: true, currency: true, salaryStructure: { select: { name: true } } } }
        : { where: { id: '' }, select: { wageMonthly: true, ctcAnnual: true, currency: true, salaryStructure: { select: { name: true } } } },
    },
    orderBy: { employeeCode: 'asc' },
    take: 5000, // ponytail: one page of 5000 people; stream the CSV when a company outgrows it
  })
}

const assertBuilder = (user: AccessUser) => { if (!has(user, [...BUILDERS, ...SALARY])) throw new AppError('Not allowed to build reports', 403) }

async function validateDef(user: AccessUser, def: Definition) {
  const fields = await fieldsFor(user)
  const unknown = def.columns.filter((c) => !fields[c])
  if (unknown.length) throw new AppError(`Unknown or not allowed column${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`, 400)
  if (def.groupBy && !fields[def.groupBy]?.groupable) throw new AppError(`Cannot group by ${def.groupBy}`, 400)
  return fields
}

export const reportBuilder = {
  async fields(user: AccessUser) {
    assertBuilder(user)
    return Object.entries(await fieldsFor(user)).map(([key, f]) => ({ key, label: f.label, group: f.group, type: f.type ?? 'text', groupable: !!f.groupable }))
  },

  async run(user: AccessUser, def: Definition): Promise<Report> {
    assertBuilder(user)
    const fields = await validateDef(user, def)
    await ensureDefaults(user.tenantId)
    const [emps, masters] = await Promise.all([
      loadEmployees(user.tenantId, def.filters, def.columns.concat(def.groupBy ?? []).some((c) => fields[c].salary)),
      prisma.masterValue.findMany({ where: { tenantId: user.tenantId }, select: { list: true, code: true, label: true } }),
    ])
    const labels = new Map(masters.map((m) => [`${m.list}|${m.code}`, m.label]))
    const ctx: Ctx = { label: (list, code) => (code ? labels.get(`${list}|${code}`) ?? code : null) }
    const columns: Col[] = def.columns.map((key) => ({ key, label: fields[key].label, type: fields[key].type }))
    const rows = emps.map((e) => Object.fromEntries(def.columns.map((k) => [k, fields[k].get(e, ctx) ?? null])))
    const g = def.groupBy ? fields[def.groupBy] : fields.department ?? STANDARD.department
    const counts = new Map<string, number>()
    for (const e of emps) { const k = String(g.get(e, ctx) ?? 'Not set'); counts.set(k, (counts.get(k) ?? 0) + 1) }
    const bars = [...counts].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value)
    const wage = columns.find((c) => c.key === 'current_wage') && rows.some((r) => r.current_wage != null)
    return {
      title: def.name,
      subtitle: `${def.filters.status === 'all' ? 'Everyone' : def.filters.status === 'exited' ? 'People who left' : 'Current employees'}${emps.length === 5000 ? ' · first 5000 people' : ''}`,
      columns: def.groupBy ? [{ key: 'group', label: g.label }, { key: 'count', label: 'People', type: 'number' }] : columns,
      rows: def.groupBy ? bars.map((b) => ({ group: b.label, count: b.value })) : rows,
      summary: [
        { label: 'People', value: emps.length, type: 'number' },
        { label: def.groupBy ? `${g.label} groups` : 'Columns', value: def.groupBy ? bars.length : columns.length, type: 'number' },
        ...(wage ? [{ label: 'Total monthly wage', value: Math.round(rows.reduce((s, r) => s + Number(r.current_wage ?? 0), 0) * 100) / 100, type: 'money' as const }] : []),
      ],
      chart: { label: `People by ${g.label.toLowerCase()}`, bars: bars.slice(0, 20) },
    }
  },

  async list(user: AccessUser) {
    assertBuilder(user)
    return prisma.savedReport.findMany({ where: { tenantId: user.tenantId, active: true }, orderBy: { name: 'asc' } })
  },

  async get(user: AccessUser, id: string) {
    assertBuilder(user)
    const r = await prisma.savedReport.findFirst({ where: { id, tenantId: user.tenantId, active: true } })
    if (!r) throw new AppError('Report not found', 404)
    return r
  },

  async save(user: AccessUser, def: Definition, id?: string) {
    assertBuilder(user)
    await validateDef(user, def)
    const data = { name: def.name, columns: def.columns, groupBy: def.groupBy ?? null, filters: def.filters }
    if (id) {
      await reportBuilder.get(user, id)
      return prisma.savedReport.update({ where: { id }, data })
    }
    return prisma.savedReport.create({ data: { ...data, tenantId: user.tenantId, createdBy: user.userId } })
  },

  async archive(user: AccessUser, id: string) {
    await reportBuilder.get(user, id)
    await prisma.savedReport.update({ where: { id }, data: { active: false } })
    return { archived: true }
  },

  // A saved report is run with the viewer's own permissions: salary columns drop out for someone without salary access
  async runSaved(user: AccessUser, id: string) {
    const r = await reportBuilder.get(user, id)
    const allowed = await fieldsFor(user)
    const columns = r.columns.filter((c) => allowed[c])
    if (!columns.length) throw new AppError('None of this report’s columns are available to you', 403)
    return reportBuilder.run(user, { name: r.name, columns, groupBy: r.groupBy && allowed[r.groupBy] ? r.groupBy : null, filters: BuilderDefinition.shape.filters.parse(r.filters) })
  },
}
