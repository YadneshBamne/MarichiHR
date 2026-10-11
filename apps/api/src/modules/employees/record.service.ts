import crypto from 'crypto'
import { prisma } from '../../infrastructure/database/prisma'
import { AppError } from '../../shared/utils/AppError'
import { AccessUser, canAccessProfile, isReportingChainOf } from '../../shared/utils/access'
import { encryptField, decryptField, last4, lookupHash } from '../../shared/utils/crypto'
import { assertMasters } from '../masters/masters.service'
import { assertRefsInTenant } from './employees.service'
import { RECORD_FIELDS, fieldByKey, FieldMode, DATE_FIELDS } from './record.catalog'
import { openRequestSections } from './requests.service'

// The full employee record (greytHR-style). Who sees and edits what:
//  - HR admins: everything; system admins too
//  - the person: everything about themselves; edits only what the company allows employees to edit
//  - managers in the reporting line: the non-sensitive parts (no addresses, family, identities, previous jobs,
//    date of birth, marital status, religion, personal contact details)
// Job placement (department, position, manager, location, employment type, category) changes through position
// history, with an effective date, so "who was the boss on that date" can always be answered.

type Actor = AccessUser
const isHR = (u: Actor) => u.roleIds.some((r) => ['hr_admin', 'system_admin'].includes(r))
const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null)
const day = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00.000Z`)
const audit = (a: Actor, action: string, employeeId: string, newValue?: any, oldValue?: any) =>
  prisma.auditLog.create({ data: { tenantId: a.tenantId, userId: a.userId, action, entityType: 'employee', entityId: employeeId, newValue, oldValue } })

// ─── Form settings (form builder) ─────────────────────────────────────────────

export async function fieldSettings(tenantId: string) {
  const [overrides, custom] = await Promise.all([
    prisma.employeeFieldSetting.findMany({ where: { tenantId } }),
    prisma.customFieldDefinition.findMany({ where: { tenantId }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
  ])
  const byField = new Map(overrides.map((o) => [o.field, o]))
  return {
    fields: RECORD_FIELDS.map((x) => {
      const o = byField.get(x.key)
      return { key: x.key, label: x.label, section: x.section, kind: x.kind, master: x.master ?? null, locked: !!x.locked, sensitive: !!x.sensitive,
        mode: (x.locked ? x.mode : (o?.mode as FieldMode) ?? x.mode), employeeCanEdit: o ? o.employeeCanEdit : x.employeeCanEdit }
    }),
    customFields: custom.map((c) => ({ id: c.id, key: c.key, label: c.label, section: c.section, type: c.type, masterList: c.masterList, options: c.options, active: c.active, sortOrder: c.sortOrder })),
  }
}

export async function saveFieldSettings(a: Actor, items: { field: string; mode: FieldMode; employeeCanEdit: boolean }[]) {
  for (const it of items) {
    const def = fieldByKey.get(it.field)
    if (!def) throw new AppError(`Unknown field ${it.field}`, 400)
    if (def.locked && (it.mode !== 'mandatory')) throw new AppError(`${def.label} is always required`, 400)
  }
  await prisma.$transaction(items.map((it) => prisma.employeeFieldSetting.upsert({
    where: { tenantId_field: { tenantId: a.tenantId, field: it.field } },
    create: { tenantId: a.tenantId, field: it.field, mode: it.mode, employeeCanEdit: it.employeeCanEdit },
    update: { mode: it.mode, employeeCanEdit: it.employeeCanEdit },
  })))
  await prisma.auditLog.create({ data: { tenantId: a.tenantId, userId: a.userId, action: 'EMPLOYEE_FORM_UPDATED', entityType: 'tenant', entityId: a.tenantId, newValue: { fields: items } as any } })
  return fieldSettings(a.tenantId)
}

// Fields the company marks Required must be filled when someone is added (Add person, bulk import, recruitment hire)
const CREATE_FIELDS = ['dateOfBirth', 'gender', 'nationality', 'personalEmail', 'mobilePersonal', 'mobileWork', 'taxJurisdiction']
export async function assertCreateMandatory(tenantId: string, data: Record<string, unknown>) {
  const required = await prisma.employeeFieldSetting.findMany({ where: { tenantId, mode: 'mandatory', field: { in: CREATE_FIELDS } }, select: { field: true } })
  const missing = required.map((r) => r.field).filter((f) => data[f] == null || data[f] === '')
  if (missing.length) throw new AppError(`Required by your company's employee form: ${missing.map((f) => fieldByKey.get(f)!.label).join(', ')}`, 400)
}

// ─── Custom fields ────────────────────────────────────────────────────────────

type CustomIn = { key?: string; label: string; section?: string; type: 'text' | 'number' | 'date' | 'yes_no' | 'list'; masterList?: string | null; options?: { code: string; label: string }[] | null; active?: boolean }
export async function saveCustomField(a: Actor, id: string | null, body: CustomIn) {
  if (body.type === 'list' && !body.masterList && !body.options?.length) throw new AppError('A list field needs a master list or its own options', 400)
  if (id) {
    const row = await prisma.customFieldDefinition.findFirst({ where: { id, tenantId: a.tenantId } })
    if (!row) throw new AppError('Field not found', 404)
    const updated = await prisma.customFieldDefinition.update({ where: { id }, data: { label: body.label, section: body.section ?? row.section, active: body.active ?? row.active, options: (body.options ?? undefined) as any } })
    await audit(a, 'CUSTOM_FIELD_UPDATED', a.tenantId, { key: row.key, label: body.label, active: updated.active })
    return updated
  }
  const key = body.key ?? body.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40)
  const flat = (k: string) => k.replace(/_/g, '').toLowerCase()
  if (!key || RECORD_FIELDS.some((x) => flat(x.key) === flat(key))) throw new AppError('Choose a different name; this one is taken by a standard field', 409)
  try {
    const row = await prisma.customFieldDefinition.create({ data: { tenantId: a.tenantId, key, label: body.label, section: body.section ?? 'custom', type: body.type, masterList: body.masterList ?? null, options: (body.options ?? undefined) as any } })
    await audit(a, 'CUSTOM_FIELD_ADDED', a.tenantId, { key, label: body.label, type: body.type })
    return row
  } catch (err: any) {
    if (err?.code === 'P2002') throw new AppError('A custom field with this name already exists', 409)
    throw err
  }
}

async function checkCustomValues(tenantId: string, values: Record<string, unknown>) {
  const defs = await prisma.customFieldDefinition.findMany({ where: { tenantId, active: true } })
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(values)) {
    const d = defs.find((x) => x.key === k)
    if (!d) throw new AppError(`Unknown custom field ${k}`, 400)
    if (v === null || v === '') { out[k] = null; continue }
    if (d.type === 'number' && typeof v !== 'number') throw new AppError(`${d.label} must be a number`, 400)
    if (d.type === 'yes_no' && typeof v !== 'boolean') throw new AppError(`${d.label} must be yes or no`, 400)
    if (d.type === 'date' && !(typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v))) throw new AppError(`${d.label} must be a date`, 400)
    if (d.type === 'text' && (typeof v !== 'string' || v.length > 500)) throw new AppError(`${d.label} must be text up to 500 characters`, 400)
    if (d.type === 'list') {
      if (typeof v !== 'string') throw new AppError(`${d.label} must be one of its options`, 400)
      if (d.masterList) await assertMasters(tenantId, { [d.masterList]: v })
      else if (!((d.options as any[]) ?? []).some((o) => o.code === v)) throw new AppError(`${d.label} must be one of its options`, 400)
    }
    out[k] = v
  }
  return out
}

// ─── Reading ──────────────────────────────────────────────────────────────────

async function access(a: Actor, employeeId: string) {
  const emp = await prisma.employee.findFirst({ where: { id: employeeId, tenantId: a.tenantId } })
  if (!emp || !(await canAccessProfile(a, employeeId))) throw new AppError('Employee not found', 404)
  const self = !!a.employeeId && a.employeeId === employeeId
  return { emp, self, hr: isHR(a), full: self || isHR(a) }
}

const maskedIdentity = (i: any) => ({ id: i.id, documentType: i.documentType, numberMasked: `•••• ${i.numberLast4}`, issueDate: ymd(i.issueDate), expiryDate: ymd(i.expiryDate), issuingCountry: i.issuingCountry, details: i.details, verified: i.verified, verifiedAt: i.verifiedAt })

export async function getRecord(a: Actor, employeeId: string) {
  const { emp, self, hr, full } = await access(a, employeeId)
  const settings = await fieldSettings(a.tenantId)
  const [addresses, family, contacts, education, previous, identities, history] = await Promise.all([
    full ? prisma.employeeAddress.findMany({ where: { employeeId } }) : [],
    full ? prisma.employeeFamilyMember.findMany({ where: { employeeId }, orderBy: { createdAt: 'asc' } }) : [],
    prisma.employeeEmergencyContact.findMany({ where: { employeeId }, orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] }),
    prisma.employeeEducation.findMany({ where: { employeeId }, orderBy: [{ endYear: 'desc' }, { createdAt: 'asc' }] }),
    full ? prisma.employeePreviousEmployment.findMany({ where: { employeeId }, orderBy: { fromDate: 'desc' } }) : [],
    full ? prisma.employeeIdentity.findMany({ where: { employeeId }, orderBy: { createdAt: 'asc' } }) : [],
    prisma.employeePositionHistory.findMany({ where: { employeeId }, orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }] }),
  ])
  // Names for the ids in position history
  const ids = (k: 'orgUnitId' | 'jobPositionId' | 'managerId' | 'workLocationId') => [...new Set(history.map((h) => h[k]).filter(Boolean) as string[])]
  const [units, positions, managers, locations] = await Promise.all([
    prisma.orgUnit.findMany({ where: { id: { in: ids('orgUnitId') } }, select: { id: true, name: true } }),
    prisma.jobPosition.findMany({ where: { id: { in: ids('jobPositionId') } }, select: { id: true, title: true } }),
    prisma.employee.findMany({ where: { id: { in: ids('managerId') } }, select: { id: true, firstName: true, lastName: true } }),
    prisma.workLocation.findMany({ where: { id: { in: ids('workLocationId') } }, select: { id: true, name: true } }),
  ])
  const nm = <T extends { id: string }>(list: T[], id: string | null, f: (x: T) => string) => (id ? (list.find((x) => x.id === id) ? f(list.find((x) => x.id === id)!) : null) : null)

  const values: Record<string, unknown> = {}
  for (const fd of settings.fields) {
    if (fd.kind === 'section') continue
    if (fd.sensitive && !full) continue
    const v = (emp as any)[fd.key]
    values[fd.key] = v instanceof Date ? ymd(v) : v ?? null
  }
  // HR edits everything; the person edits what the form allows, plus whatever HR has asked them for right now (never locked fields)
  const open = self && !hr ? await openRequestSections(a.tenantId, employeeId) : new Set<string>()
  const canEdit = (key: string) => {
    const fd = settings.fields.find((x) => x.key === key)
    return hr || (self && !!fd && fd.mode !== 'hidden' && (fd.employeeCanEdit || (!fd.locked && (open.has(key) || open.has(fd.section)))))
  }
  const sections = { addresses: addresses.length, family: family.length, emergencyContacts: contacts.length, education: education.length, previousEmployment: previous.length, identities: identities.length } as Record<string, number>
  // What the company requires that is still empty
  const missing = settings.fields.filter((x) => x.mode === 'mandatory' && (x.kind === 'section' ? (full || !x.sensitive) && !sections[x.key] : (full || !x.sensitive) && (values[x.key] == null || values[x.key] === '' || (Array.isArray(values[x.key]) && !(values[x.key] as unknown[]).length)))).map((x) => x.label)

  return {
    employeeId, values, customFields: (emp.customFields as Record<string, unknown>) ?? {},
    addresses: addresses.map((x) => ({ ...x, updatedAt: undefined })),
    family: family.map((x) => ({ ...x, dateOfBirth: ymd(x.dateOfBirth), nomineeShare: x.nomineeShare == null ? null : Number(x.nomineeShare) })),
    emergencyContacts: contacts,
    education,
    previousEmployment: previous.map((x) => ({ ...x, fromDate: ymd(x.fromDate), toDate: ymd(x.toDate), lastSalary: x.lastSalary == null ? null : Number(x.lastSalary) })),
    identities: identities.map(maskedIdentity),
    positionHistory: history.map((h) => ({
      id: h.id, effectiveFrom: ymd(h.effectiveFrom), applied: !!h.appliedAt, reason: h.reason, employmentType: h.employmentType, employeeCategory: h.employeeCategory,
      department: nm(units, h.orgUnitId, (u) => u.name), position: nm(positions, h.jobPositionId, (p) => p.title),
      manager: nm(managers, h.managerId, (m) => `${m.firstName} ${m.lastName}`), managerId: h.managerId, location: nm(locations, h.workLocationId, (l) => l.name),
    })),
    settings,
    can: { seeSensitive: full, editAny: hr, edit: Object.fromEntries(settings.fields.map((x) => [x.key, canEdit(x.key)])), verify: hr && !self, reveal: hr },
    missing,
  }
}

// ─── Personal / contact / job fields ──────────────────────────────────────────

const POSITION_KEYS = ['employmentType', 'employeeCategory'] // these go through position history
export async function updateFields(a: Actor, employeeId: string, body: Record<string, unknown>, custom?: Record<string, unknown>) {
  const { emp, hr, self } = await access(a, employeeId)
  const settings = await fieldSettings(a.tenantId)
  let open: Set<string> | undefined
  const data: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(body)) {
    const fd = settings.fields.find((x) => x.key === k)
    if (!fd || fd.kind === 'section') throw new AppError(`${k} is not a field of the record`, 400)
    if (POSITION_KEYS.includes(k)) throw new AppError(`${fd.label} changes with an effective date: use Change position`, 400)
    if (!hr && !(self && (fd.employeeCanEdit || (!fd.locked && (open ??= await openRequestSections(a.tenantId, employeeId)).has(fd.section))))) throw new AppError(`You cannot change ${fd.label}`, 403)
    if ((v === null || v === '' || (Array.isArray(v) && !v.length)) && fd.mode === 'mandatory') throw new AppError(`${fd.label} is required`, 400)
    if (fd.key === 'workEmail' && v !== emp.workEmail) throw new AppError('Change the work email from Login & access', 400)
    data[k] = DATE_FIELDS.has(k) && typeof v === 'string' ? day(v) : v === '' ? null : v
  }
  // Master-backed values must be active list values (unchanged ones are left alone)
  const checks: Record<string, string> = {}
  for (const fd of settings.fields) {
    if (!(fd.key in data) || !fd.master) continue
    const v = data[fd.key]
    if (fd.kind === 'masters') { for (const code of (v as string[] | null) ?? []) await assertMasters(a.tenantId, { [fd.master]: code }) }
    else if (v != null && v !== (emp as any)[fd.key]) checks[fd.master] = v as string
  }
  await assertMasters(a.tenantId, checks)
  if (custom && Object.keys(custom).length) {
    if (!hr) throw new AppError('Only HR can change custom fields', 403)
    data.customFields = { ...((emp.customFields as object) ?? {}), ...(await checkCustomValues(a.tenantId, custom)) }
  }
  if (!Object.keys(data).length) return getRecord(a, employeeId)
  await prisma.employee.update({ where: { id: employeeId }, data })
  const changed = Object.keys(data).filter((k) => JSON.stringify((emp as any)[k] instanceof Date ? ymd((emp as any)[k]) : (emp as any)[k]) !== JSON.stringify(data[k] instanceof Date ? ymd(data[k] as Date) : data[k]))
  await audit(a, 'EMPLOYEE_RECORD_UPDATED', employeeId, { fields: changed })
  return getRecord(a, employeeId)
}

// ─── List sections ────────────────────────────────────────────────────────────

type Section = 'addresses' | 'family' | 'emergencyContacts' | 'education' | 'previousEmployment'
const MODEL: Record<Section, string> = { addresses: 'employeeAddress', family: 'employeeFamilyMember', emergencyContacts: 'employeeEmergencyContact', education: 'employeeEducation', previousEmployment: 'employeePreviousEmployment' }
const SECTION_MASTERS: Record<Section, Record<string, string>> = {
  addresses: {}, family: { relationship: 'relationship', gender: 'gender', bloodGroup: 'blood_group', nationality: 'nationality' },
  emergencyContacts: { relationship: 'relationship' }, education: { qualification: 'qualification' }, previousEmployment: {},
}
const SECTION_DATES: Record<Section, string[]> = { addresses: [], family: ['dateOfBirth'], emergencyContacts: [], education: [], previousEmployment: ['fromDate', 'toDate'] }

async function canEditSection(a: Actor, employeeId: string, section: string) {
  const { hr, self } = await access(a, employeeId)
  if (hr) return
  const s = (await fieldSettings(a.tenantId)).fields.find((x) => x.key === section)
  if (!(self && s && s.mode !== 'hidden' && (s.employeeCanEdit || (await openRequestSections(a.tenantId, employeeId)).has(section)))) throw new AppError('You cannot change this part of the record', 403)
}

function prep(section: Section, body: Record<string, any>) {
  const data: Record<string, any> = { ...body }
  for (const k of SECTION_DATES[section]) if (k in data) data[k] = data[k] ? day(data[k]) : null
  if (section === 'previousEmployment' && data.fromDate && data.toDate && data.fromDate > data.toDate) throw new AppError('The end date is before the start date', 400)
  if (section === 'education' && data.startYear && data.endYear && data.startYear > data.endYear) throw new AppError('The end year is before the start year', 400)
  return data
}

async function checkSectionMasters(tenantId: string, section: Section, data: Record<string, any>) {
  const checks: Record<string, string> = {}
  for (const [field, list] of Object.entries(SECTION_MASTERS[section])) if (data[field]) checks[list] = data[field]
  await assertMasters(tenantId, checks)
}

async function nomineeTotal(employeeId: string, excludeId: string | null, add: number | null | undefined) {
  if (add == null) return
  const rows = await prisma.employeeFamilyMember.findMany({ where: { employeeId, ...(excludeId ? { id: { not: excludeId } } : {}) }, select: { nomineeShare: true } })
  const total = rows.reduce((s, r) => s + Number(r.nomineeShare ?? 0), 0) + add
  if (total > 100.0001) throw new AppError(`Nominee shares would add up to ${Math.round(total * 100) / 100}%; the total cannot pass 100%`, 400)
}

export async function addEntry(a: Actor, employeeId: string, section: Section, body: Record<string, any>) {
  await canEditSection(a, employeeId, section)
  const data = prep(section, body)
  await checkSectionMasters(a.tenantId, section, data)
  if (section === 'family') await nomineeTotal(employeeId, null, data.nomineeShare)
  let row: any
  if (section === 'addresses') {
    row = await prisma.employeeAddress.upsert({ where: { employeeId_kind: { employeeId, kind: data.kind } }, create: { employeeId, ...data } as any, update: data })
  } else {
    row = await (prisma as any)[MODEL[section]].create({ data: { employeeId, ...data } })
  }
  await audit(a, 'EMPLOYEE_RECORD_ADDED', employeeId, { section, id: row.id })
  return row
}

export async function updateEntry(a: Actor, employeeId: string, section: Section, id: string, body: Record<string, any>) {
  await canEditSection(a, employeeId, section)
  const model = (prisma as any)[MODEL[section]]
  const row = await model.findFirst({ where: { id, employeeId } })
  if (!row) throw new AppError('Entry not found', 404)
  const data = prep(section, body)
  await checkSectionMasters(a.tenantId, section, data)
  if (section === 'family' && 'nomineeShare' in data) await nomineeTotal(employeeId, id, data.nomineeShare)
  const updated = await model.update({ where: { id }, data })
  await audit(a, 'EMPLOYEE_RECORD_UPDATED', employeeId, { section, id, fields: Object.keys(data) })
  return updated
}

export async function removeEntry(a: Actor, employeeId: string, section: Section, id: string) {
  await canEditSection(a, employeeId, section)
  const model = (prisma as any)[MODEL[section]]
  const row = await model.findFirst({ where: { id, employeeId } })
  if (!row) throw new AppError('Entry not found', 404)
  await model.delete({ where: { id } })
  await audit(a, 'EMPLOYEE_RECORD_REMOVED', employeeId, { section, id })
  return { removed: true }
}

// ─── Identities ───────────────────────────────────────────────────────────────

type IdentityIn = { documentType: string; number?: string; issueDate?: string | null; expiryDate?: string | null; issuingCountry?: string | null; details?: string | null }
const idHash = (tenantId: string, type: string, number: string) => lookupHash(`${tenantId}:${type}`, number)

export async function saveIdentity(a: Actor, employeeId: string, body: IdentityIn, id: string | null) {
  await canEditSection(a, employeeId, 'identities')
  await assertMasters(a.tenantId, { identity_document: id ? undefined : body.documentType, nationality: undefined })
  if (body.issueDate && body.expiryDate && body.issueDate > body.expiryDate) throw new AppError('The expiry date is before the issue date', 400)
  const existing = id ? await prisma.employeeIdentity.findFirst({ where: { id, employeeId } }) : null
  if (id && !existing) throw new AppError('Identity not found', 404)
  const type = existing?.documentType ?? body.documentType
  const data: Record<string, any> = {
    issueDate: body.issueDate !== undefined ? (body.issueDate ? day(body.issueDate) : null) : undefined,
    expiryDate: body.expiryDate !== undefined ? (body.expiryDate ? day(body.expiryDate) : null) : undefined,
    issuingCountry: body.issuingCountry, details: body.details,
  }
  if (body.number) {
    const number = body.number.trim()
    const hash = idHash(a.tenantId, type, number)
    const clash = await prisma.employeeIdentity.findFirst({ where: { tenantId: a.tenantId, documentType: type, numberHash: hash, employeeId: { not: employeeId } }, include: { employee: { select: { employeeCode: true } } } })
    if (clash) throw new AppError(`This number already belongs to ${clash.employee.employeeCode}`, 409)
    Object.assign(data, { numberEnc: encryptField(number), numberHash: hash, numberLast4: last4(number.replace(/\s/g, '')), verified: false, verifiedBy: null, verifiedAt: null })
  } else if (!existing) throw new AppError('Enter the document number', 400)
  // Changing dates or details also needs a fresh check
  if (existing && !body.number && (data.issueDate !== undefined || data.expiryDate !== undefined || data.details !== undefined)) Object.assign(data, { verified: false, verifiedBy: null, verifiedAt: null })
  let row
  try {
    row = existing
      ? await prisma.employeeIdentity.update({ where: { id: existing.id }, data })
      : await prisma.employeeIdentity.create({ data: { employeeId, tenantId: a.tenantId, documentType: type, ...data } as any })
  } catch (err: any) {
    if (err?.code === 'P2002') throw new AppError('This person already has this document type; edit it instead', 409)
    throw err
  }
  await audit(a, existing ? 'IDENTITY_UPDATED' : 'IDENTITY_ADDED', employeeId, { documentType: type, last4: row.numberLast4 })
  return maskedIdentity(row)
}

export async function verifyIdentity(a: Actor, employeeId: string, id: string) {
  if (!isHR(a)) throw new AppError('Only HR verifies documents', 403)
  if (a.employeeId === employeeId) throw new AppError('Someone else must verify your own documents', 403)
  await access(a, employeeId)
  const row = await prisma.employeeIdentity.findFirst({ where: { id, employeeId } })
  if (!row) throw new AppError('Identity not found', 404)
  const updated = await prisma.employeeIdentity.update({ where: { id }, data: { verified: true, verifiedBy: a.userId, verifiedAt: new Date() } })
  await audit(a, 'IDENTITY_VERIFIED', employeeId, { documentType: row.documentType })
  return maskedIdentity(updated)
}

// The full number, for HR only, every look audit-logged
export async function revealIdentity(a: Actor, employeeId: string, id: string) {
  if (!isHR(a)) throw new AppError('Only HR can see full document numbers', 403)
  await access(a, employeeId)
  const row = await prisma.employeeIdentity.findFirst({ where: { id, employeeId } })
  if (!row) throw new AppError('Identity not found', 404)
  await audit(a, 'IDENTITY_REVEALED', employeeId, { documentType: row.documentType })
  return { number: decryptField(row.numberEnc) }
}

export async function removeIdentity(a: Actor, employeeId: string, id: string) {
  await canEditSection(a, employeeId, 'identities')
  const row = await prisma.employeeIdentity.findFirst({ where: { id, employeeId } })
  if (!row) throw new AppError('Identity not found', 404)
  if (row.verified && !isHR(a)) throw new AppError('A verified document can only be removed by HR', 403)
  await prisma.employeeIdentity.delete({ where: { id } })
  await audit(a, 'IDENTITY_REMOVED', employeeId, { documentType: row.documentType })
  return { removed: true }
}

// ─── Position history ─────────────────────────────────────────────────────────

type PositionIn = { effectiveFrom: string; orgUnitId?: string; jobPositionId?: string | null; managerId?: string | null; workLocationId?: string | null; employmentType?: string; employeeCategory?: string | null; reason: string }
const PLACEMENT = ['orgUnitId', 'jobPositionId', 'managerId', 'workLocationId', 'employmentType', 'employeeCategory'] as const

export async function changePosition(a: Actor, employeeId: string, body: PositionIn) {
  if (!isHR(a)) throw new AppError('Only HR changes positions', 403)
  const { emp } = await access(a, employeeId)
  if (!PLACEMENT.some((k) => body[k] !== undefined)) throw new AppError('Change at least one of department, position, manager, location, employment type or category', 400)
  if (body.managerId === employeeId) throw new AppError('Someone cannot be their own manager', 400)
  if (body.managerId && (await isReportingChainOf(employeeId, body.managerId))) throw new AppError('That person reports to this employee; it would make a loop', 400)
  await assertRefsInTenant(a.tenantId, { orgUnitId: body.orgUnitId, jobPositionId: body.jobPositionId ?? undefined, managerId: body.managerId ?? undefined, workLocationId: body.workLocationId ?? undefined })
  await assertMasters(a.tenantId, { employment_type: body.employmentType, employee_category: body.employeeCategory ?? undefined })
  if (body.effectiveFrom < ymd(emp.hireDate)!) throw new AppError('The change cannot start before the joining date', 400)
  const today = new Date().toISOString().slice(0, 10)
  const due = body.effectiveFrom <= today
  const row = await prisma.employeePositionHistory.create({
    data: {
      employeeId, effectiveFrom: day(body.effectiveFrom), reason: body.reason, createdBy: a.userId, appliedAt: due ? new Date() : null,
      // null = "set to none" is stored as '' because a null column means "unchanged" in history rows
      ...Object.fromEntries(PLACEMENT.filter((k) => body[k] !== undefined).map((k) => [k, body[k] === null ? '' : body[k]])),
    },
  })
  if (due) await applyPosition(employeeId, row)
  await audit(a, 'POSITION_CHANGED', employeeId, { effectiveFrom: body.effectiveFrom, reason: body.reason, scheduled: !due, changes: Object.fromEntries(PLACEMENT.filter((k) => body[k] !== undefined).map((k) => [k, body[k]])) })
  return { id: row.id, applied: due }
}

async function applyPosition(employeeId: string, row: { orgUnitId: string | null; jobPositionId: string | null; managerId: string | null; workLocationId: string | null; employmentType: string | null; employeeCategory: string | null }) {
  const data: Record<string, unknown> = {}
  // Null in a history row means "unchanged" except for the optional links set on purpose to none (stored as '')
  for (const k of PLACEMENT) if (row[k] !== null) data[k] = row[k] === '' ? null : row[k]
  if (data.orgUnitId === null || data.employmentType === null) { delete data.orgUnitId; delete data.employmentType }
  if (Object.keys(data).length) await prisma.employee.update({ where: { id: employeeId }, data })
}

// Daily job: future-dated changes whose day has come (idempotent: each row is claimed once)
export async function applyDuePositionChanges(tenantId: string) {
  const today = day(new Date().toISOString())
  const due = await prisma.employeePositionHistory.findMany({ where: { appliedAt: null, effectiveFrom: { lte: today }, employee: { tenantId } }, orderBy: { effectiveFrom: 'asc' } })
  let applied = 0
  for (const row of due) {
    const claim = await prisma.employeePositionHistory.updateMany({ where: { id: row.id, appliedAt: null }, data: { appliedAt: new Date() } })
    if (!claim.count) continue
    await applyPosition(row.employeeId, row)
    applied++
  }
  return applied
}

// Who someone reported to on a given day (latest applied-or-due change on or before it that set a manager)
export async function managerOn(tenantId: string, employeeId: string, date: string) {
  const row = await prisma.employeePositionHistory.findFirst({ where: { employeeId, employee: { tenantId }, effectiveFrom: { lte: day(date) }, NOT: { managerId: null } }, orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }] })
  if (!row?.managerId) return null
  return prisma.employee.findFirst({ where: { id: row.managerId, tenantId }, select: { id: true, firstName: true, lastName: true, employeeCode: true } })
}

// Recorded automatically when a person is created or their placement is edited outside Change position
export function historyRow(employeeId: string, createdBy: string, e: { orgUnitId?: string | null; jobPositionId?: string | null; managerId?: string | null; workLocationId?: string | null; employmentType?: string | null; employeeCategory?: string | null }, effectiveFrom: string, reason: string) {
  return { id: crypto.randomUUID(), employeeId, effectiveFrom, orgUnitId: e.orgUnitId ?? null, jobPositionId: e.jobPositionId ?? null, managerId: e.managerId ?? null, workLocationId: e.workLocationId ?? null, employmentType: e.employmentType ?? null, employeeCategory: e.employeeCategory ?? null, reason, appliedAt: new Date().toISOString(), createdBy, createdAt: new Date().toISOString() }
}

// ─── Rehire and duplicate check (add-person wizard) ───────────────────────────

export async function rehireCheck(a: Actor, body: { firstName: string; lastName: string; dateOfBirth?: string; identities?: { documentType: string; number: string }[] }) {
  if (!isHR(a)) throw new AppError('Only HR adds people', 403)
  const byName = await prisma.employee.findMany({
    where: { tenantId: a.tenantId, firstName: { equals: body.firstName.trim(), mode: 'insensitive' }, lastName: { equals: body.lastName.trim(), mode: 'insensitive' }, ...(body.dateOfBirth ? { dateOfBirth: day(body.dateOfBirth) } : {}) },
    select: { id: true, employeeCode: true, firstName: true, lastName: true, active: true, employmentStatus: true, exitDate: true, dateOfBirth: true },
    take: 10,
  })
  const hashes = (body.identities ?? []).filter((i) => i.number?.trim()).map((i) => ({ documentType: i.documentType, numberHash: idHash(a.tenantId, i.documentType, i.number) }))
  const byId = hashes.length ? await prisma.employeeIdentity.findMany({ where: { tenantId: a.tenantId, OR: hashes }, select: { documentType: true, employee: { select: { id: true, employeeCode: true, firstName: true, lastName: true, active: true, employmentStatus: true, exitDate: true } } } }) : []
  const out = new Map<string, any>()
  for (const e of byName) out.set(e.id, { ...e, dateOfBirth: ymd(e.dateOfBirth), exitDate: ymd(e.exitDate), match: body.dateOfBirth ? 'name and date of birth' : 'name' })
  for (const r of byId) out.set(r.employee.id, { ...r.employee, exitDate: ymd(r.employee.exitDate), match: `${r.documentType.replace(/_/g, ' ')} number` })
  return [...out.values()].map((e) => ({ id: e.id, employeeCode: e.employeeCode, name: `${e.firstName} ${e.lastName}`, status: e.active ? e.employmentStatus : 'left', exitDate: e.exitDate, match: e.match }))
}
