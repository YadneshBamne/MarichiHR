import { prisma } from '../../infrastructure/database/prisma'
import { notify, userIdOfEmployee } from '../../infrastructure/notifications/notify'
import { AppError } from '../../shared/utils/AppError'
import { AccessUser, hrScope, inHrScope } from '../../shared/utils/access'

// Self-service onboarding and data requests. HR asks people for sections of their record; each person fills the
// section in and submits it; HR accepts it or sends it back with a note. While a section is open (pending or sent
// back), the person may edit it even if the company's form normally keeps it for HR.

export const REQUEST_SECTIONS = ['personal', 'contact', 'addresses', 'emergencyContacts', 'family', 'education', 'previousEmployment', 'identities', 'documents'] as const
export type RequestSection = (typeof REQUEST_SECTIONS)[number]
export const SECTION_LABELS: Record<RequestSection, string> = {
  personal: 'Personal details', contact: 'Contact details', addresses: 'Addresses', emergencyContacts: 'Emergency contacts', family: 'Family & nominees',
  education: 'Education', previousEmployment: 'Previous employment', identities: 'Identity documents', documents: 'Documents',
}
const todayYmd = () => new Date().toISOString().slice(0, 10)
const PERSONAL_KEYS = ['dateOfBirth', 'gender', 'nationality', 'maritalStatus', 'bloodGroup', 'middleName', 'preferredName', 'title', 'languages']
const CONTACT_KEYS = ['personalEmail', 'mobilePersonal', 'mobileWork']

// Which requested sections already hold something: a person cannot submit an empty section (and the screen tells them why)
export async function filledSections(tenantId: string, employeeId: string): Promise<Set<string>> {
  const [emp, addresses, family, emergency, education, previous, identities, documents] = await Promise.all([
    prisma.employee.findFirst({ where: { id: employeeId, tenantId } }),
    prisma.employeeAddress.count({ where: { employeeId } }),
    prisma.employeeFamilyMember.count({ where: { employeeId } }),
    prisma.employeeEmergencyContact.count({ where: { employeeId } }),
    prisma.employeeEducation.count({ where: { employeeId } }),
    prisma.employeePreviousEmployment.count({ where: { employeeId } }),
    prisma.employeeIdentity.count({ where: { employeeId } }),
    prisma.employeeDocument.count({ where: { tenantId, employeeId, active: true } }),
  ])
  const has = (keys: string[]) => keys.some((k) => { const v = (emp as any)?.[k]; return v != null && v !== '' && !(Array.isArray(v) && !v.length) })
  const out = new Set<string>()
  if (has(PERSONAL_KEYS)) out.add('personal')
  if (has(CONTACT_KEYS)) out.add('contact')
  if (addresses) out.add('addresses')
  if (family) out.add('family')
  if (emergency || (emp as any)?.emergencyContactName) out.add('emergencyContacts')
  if (education) out.add('education')
  if (previous) out.add('previousEmployment')
  if (identities) out.add('identities')
  if (documents) out.add('documents')
  return out
}

const isHR = (u: AccessUser) => u.roleIds.some((r) => ['hr_admin', 'system_admin'].includes(r))
const audit = (u: AccessUser, action: string, entityId: string, newValue: any) => prisma.auditLog.create({ data: { tenantId: u.tenantId, userId: u.userId, action, entityType: 'profile_request', entityId, newValue } })

// Sections the person may currently edit because HR asked for them
export async function openRequestSections(tenantId: string, employeeId: string): Promise<Set<string>> {
  const rows = await prisma.profileRequestSection.findMany({ where: { status: { in: ['pending', 'rejected'] }, request: { tenantId, employeeId, status: 'open' } }, select: { section: true } })
  return new Set(rows.map((r) => r.section))
}

const view = (r: any, names: Map<string, string>, filled?: Set<string>) => ({
  id: r.id, employeeId: r.employeeId, employee: r.employee ? `${r.employee.firstName} ${r.employee.lastName}` : null, employeeCode: r.employee?.employeeCode ?? null,
  kind: r.kind, note: r.note, dueDate: r.dueDate ? r.dueDate.toISOString().slice(0, 10) : null, status: r.status,
  overdue: r.status === 'open' && !!r.dueDate && r.dueDate.toISOString().slice(0, 10) < todayYmd(), requestedBy: names.get(r.requestedBy) ?? null,
  createdAt: r.createdAt, completedAt: r.completedAt,
  sections: (r.sections ?? []).sort((a: any, b: any) => REQUEST_SECTIONS.indexOf(a.section) - REQUEST_SECTIONS.indexOf(b.section)).map((s: any) => ({ section: s.section, label: SECTION_LABELS[s.section as RequestSection], status: s.status, ...(filled && { filled: filled.has(s.section) }), reviewNote: s.reviewNote, submittedAt: s.submittedAt, reviewedAt: s.reviewedAt })),
  progress: { done: (r.sections ?? []).filter((s: any) => s.status === 'accepted').length, total: (r.sections ?? []).length },
})
async function requesterNames(rows: { requestedBy: string }[]) {
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.requestedBy))] } }, select: { id: true, fullName: true } })
  return new Map(users.map((u) => [u.id, u.fullName]))
}
const include = { sections: true, employee: { select: { firstName: true, lastName: true, employeeCode: true } } }

async function find(u: AccessUser, id: string) {
  const r = await prisma.profileRequest.findFirst({ where: { id, tenantId: u.tenantId }, include })
  if (!r || !(isHR(u) || r.employeeId === u.employeeId)) throw new AppError('Request not found', 404)
  if (isHR(u) && r.employeeId !== u.employeeId && !(await inHrScope(u, r.employeeId))) throw new AppError('Request not found', 404)
  return r
}

export const requestService = {
  async create(u: AccessUser, body: { employeeIds: string[]; sections: RequestSection[]; kind: 'onboarding' | 'update'; note?: string; dueDate?: string }) {
    if (!isHR(u)) throw new AppError('Only HR sends requests', 403)
    if (body.dueDate && body.dueDate < todayYmd()) throw new AppError('The due date is in the past. Choose today or a later day.', 400)
    const people = await prisma.employee.findMany({ where: { id: { in: body.employeeIds }, tenantId: u.tenantId, active: true }, select: { id: true, firstName: true, lastName: true, orgUnitId: true, user: { select: { passwordHash: true, googleSub: true } } } })
    if (people.length !== new Set(body.employeeIds).size) throw new AppError('Some people were not found or have left', 404)
    const scope = await hrScope(u)
    if (scope && people.some((p: any) => !scope.has(p.orgUnitId) && p.id !== u.employeeId)) throw new AppError('Some people were not found or have left', 404)
    if (body.kind === 'onboarding') {
      const open = await prisma.profileRequest.findFirst({ where: { tenantId: u.tenantId, employeeId: { in: body.employeeIds }, kind: 'onboarding', status: 'open' }, include: { employee: { select: { employeeCode: true } } } })
      if (open) throw new AppError(`${open.employee.employeeCode} already has onboarding in progress`, 409)
    }
    // the same section cannot be asked twice while it is still waiting (pending, submitted or sent back)
    const openNow = await prisma.profileRequest.findMany({ where: { tenantId: u.tenantId, employeeId: { in: body.employeeIds }, status: 'open' }, include: { sections: true, employee: { select: { employeeCode: true } } } })
    for (const o of openNow) {
      const clash = o.sections.filter((x: any) => ['pending', 'submitted', 'rejected'].includes(x.status) && body.sections.includes(x.section))
      if (clash.length) throw new AppError(`${o.employee.employeeCode} already has an open request for ${clash.map((x: any) => SECTION_LABELS[x.section as RequestSection]).join(', ')}`, 409)
    }
    const created = []
    for (const p of people) {
      const r = await prisma.profileRequest.create({
        data: { tenantId: u.tenantId, employeeId: p.id, kind: body.kind, note: body.note ?? null, dueDate: body.dueDate ? new Date(`${body.dueDate}T00:00:00.000Z`) : null, requestedBy: u.userId, sections: { create: [...new Set(body.sections)].map((section) => ({ section })) } },
      })
      created.push(r.id)
      await audit(u, body.kind === 'onboarding' ? 'ONBOARDING_STARTED' : 'DATA_REQUESTED', r.id, { employeeId: p.id, sections: body.sections })
      const user = await userIdOfEmployee(u.tenantId, p.id)
      if (user) await notify({ tenantId: u.tenantId, userIds: [user], type: 'profile.request', title: body.kind === 'onboarding' ? 'Welcome! Complete your joining details' : 'HR asked you to update your details', body: `${body.sections.map((s) => SECTION_LABELS[s]).join(', ')}${body.dueDate ? ` · by ${body.dueDate}` : ''}`, link: '/my-requests', entityType: 'profile_request', entityId: r.id })
    }
    // people who cannot sign in yet cannot fill anything in: HR is told, and can give them a login from the screen
    const noLogin = people.filter((p: any) => !p.user || (!p.user.passwordHash && !p.user.googleSub)).map((p: any) => ({ id: p.id, name: `${p.firstName} ${p.lastName}`.trim() }))
    return { created: created.length, ids: created, noLogin }
  },

  async list(u: AccessUser, filter: { status?: string; mine?: boolean; employeeId?: string; q?: string }) {
    const where: any = { tenantId: u.tenantId, ...(filter.status ? { status: filter.status } : {}), ...(filter.employeeId ? { employeeId: filter.employeeId } : {}) }
    if (filter.mine || !isHR(u)) where.employeeId = u.employeeId ?? '-'
    let rows = await prisma.profileRequest.findMany({ where, include, orderBy: { createdAt: 'desc' }, take: filter.q ? 1000 : 300 })
    // a Business Partner sees only people in their departments
    const scope = isHR(u) && !(filter.mine || !isHR(u)) ? await hrScope(u) : null
    if (scope && rows.length) {
      const orgs = await prisma.employee.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.employeeId))] }, tenantId: u.tenantId }, select: { id: true, orgUnitId: true } })
      const ok = new Set(orgs.filter((o: any) => scope.has(o.orgUnitId)).map((o: any) => o.id))
      rows = rows.filter((r) => ok.has(r.employeeId) || r.employeeId === u.employeeId)
    }
    const q = filter.q?.trim().toLowerCase()
    if (q) rows = rows.filter((r: any) => `${r.employee?.firstName ?? ''} ${r.employee?.lastName ?? ''} ${r.employee?.employeeCode ?? ''}`.toLowerCase().includes(q)).slice(0, 300)
    const names = await requesterNames(rows)
    const mine = filter.mine || !isHR(u)
    const filled = mine && u.employeeId ? await filledSections(u.tenantId, u.employeeId) : undefined
    return rows.map((r) => view(r, names, filled))
  },

  async get(u: AccessUser, id: string) {
    const r = await find(u, id)
    return view(r, await requesterNames([r]), r.employeeId === u.employeeId ? await filledSections(u.tenantId, r.employeeId) : undefined)
  },

  async submit(u: AccessUser, id: string, section: string) {
    const r = await find(u, id)
    if (r.employeeId !== u.employeeId) throw new AppError('Only the person can submit their own details', 403)
    if (r.status !== 'open') throw new AppError(`This request is ${r.status}`, 400)
    const s = r.sections.find((x) => x.section === section)
    if (!s) throw new AppError('That section is not part of this request', 404)
    if (!['pending', 'rejected'].includes(s.status)) throw new AppError(`This section is already ${s.status}`, 400)
    if (!(await filledSections(u.tenantId, r.employeeId)).has(section)) throw new AppError(`Fill in "${SECTION_LABELS[section as RequestSection]}" on your profile first, then submit it`, 400)
    await prisma.profileRequestSection.update({ where: { id: s.id }, data: { status: 'submitted', submittedAt: new Date() } })
    await audit(u, 'REQUEST_SECTION_SUBMITTED', id, { section })
    await notify({ tenantId: u.tenantId, userIds: [r.requestedBy], type: 'profile.submitted', title: `${r.employee.firstName} ${r.employee.lastName} submitted ${SECTION_LABELS[section as RequestSection].toLowerCase()}`, body: 'Review and accept it, or send it back with a note', link: `/employees/${r.employeeId}`, entityType: 'profile_request', entityId: id })
    return this.get(u, id)
  },

  async review(u: AccessUser, id: string, section: string, accept: boolean, note?: string) {
    if (!isHR(u)) throw new AppError('Only HR reviews submitted details', 403)
    const r = await find(u, id)
    if (r.employeeId === u.employeeId) throw new AppError('Someone else must review your own details', 403)
    const s = r.sections.find((x) => x.section === section)
    if (!s) throw new AppError('That section is not part of this request', 404)
    if (s.status !== 'submitted') throw new AppError('Only submitted sections can be reviewed', 400)
    if (!accept && !note) throw new AppError('Say what needs fixing', 400)
    await prisma.profileRequestSection.update({ where: { id: s.id }, data: { status: accept ? 'accepted' : 'rejected', reviewNote: note ?? null, reviewedBy: u.userId, reviewedAt: new Date() } })
    await audit(u, accept ? 'REQUEST_SECTION_ACCEPTED' : 'REQUEST_SECTION_RETURNED', id, { section, note: note ?? null })
    const user = await userIdOfEmployee(u.tenantId, r.employeeId)
    const remaining = r.sections.filter((x) => x.id !== s.id && x.status !== 'accepted').length
    if (accept && !remaining) {
      await prisma.profileRequest.update({ where: { id }, data: { status: 'completed', completedAt: new Date() } })
      if (user) await notify({ tenantId: u.tenantId, userIds: [user], type: 'profile.completed', title: r.kind === 'onboarding' ? 'Your joining details are complete' : 'Your details are up to date', body: 'HR accepted everything. Thank you!', link: '/my-requests', entityType: 'profile_request', entityId: id })
    } else if (!accept && user) {
      await notify({ tenantId: u.tenantId, userIds: [user], type: 'profile.returned', title: `Please fix: ${SECTION_LABELS[section as RequestSection]}`, body: note!, link: '/my-requests', entityType: 'profile_request', entityId: id })
    }
    return this.get(u, id)
  },

  async cancel(u: AccessUser, id: string) {
    if (!isHR(u)) throw new AppError('Only HR cancels requests', 403)
    const r = await find(u, id)
    if (r.status !== 'open') throw new AppError(`This request is ${r.status}`, 400)
    await prisma.profileRequest.update({ where: { id }, data: { status: 'cancelled' } })
    await audit(u, 'DATA_REQUEST_CANCELLED', id, {})
    return { cancelled: true }
  },
}

// Daily job: a person is reminded the day before a request is due, and once a week while it is overdue (the event id makes a rerun a no-op)
export async function sendRequestReminders(tenantId: string) {
  const today = todayYmd()
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
  const week = Math.floor(Date.now() / (7 * 86400000))
  const open = await prisma.profileRequest.findMany({ where: { tenantId, status: 'open', dueDate: { not: null } }, include: { sections: true } })
  let sent = 0
  for (const r of open) {
    const due = r.dueDate!.toISOString().slice(0, 10)
    const left = r.sections.filter((x: any) => x.status === 'pending' || x.status === 'rejected')
    if (!left.length || (due !== tomorrow && due >= today)) continue
    const user = await userIdOfEmployee(tenantId, r.employeeId)
    if (!user) continue
    const overdue = due < today
    await notify({ tenantId, userIds: [user], type: 'profile.reminder', title: overdue ? 'Your details are overdue' : 'Your details are due tomorrow', body: `${left.map((x: any) => SECTION_LABELS[x.section as RequestSection]).join(', ')} · due ${due}`, link: '/my-requests', entityType: 'profile_request', entityId: r.id, eventId: `${r.id}:${overdue ? 'overdue:' + week : 'due:' + due}` })
    sent++
  }
  return sent
}
