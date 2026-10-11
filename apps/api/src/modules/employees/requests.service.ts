import { prisma } from '../../infrastructure/database/prisma'
import { notify, userIdOfEmployee } from '../../infrastructure/notifications/notify'
import { AppError } from '../../shared/utils/AppError'
import { AccessUser } from '../../shared/utils/access'

// Self-service onboarding and data requests. HR asks people for sections of their record; each person fills the
// section in and submits it; HR accepts it or sends it back with a note. While a section is open (pending or sent
// back), the person may edit it even if the company's form normally keeps it for HR.

export const REQUEST_SECTIONS = ['personal', 'contact', 'addresses', 'emergencyContacts', 'family', 'education', 'previousEmployment', 'identities', 'documents'] as const
export type RequestSection = (typeof REQUEST_SECTIONS)[number]
export const SECTION_LABELS: Record<RequestSection, string> = {
  personal: 'Personal details', contact: 'Contact details', addresses: 'Addresses', emergencyContacts: 'Emergency contacts', family: 'Family & nominees',
  education: 'Education', previousEmployment: 'Previous employment', identities: 'Identity documents', documents: 'Documents',
}
const isHR = (u: AccessUser) => u.roleIds.some((r) => ['hr_admin', 'system_admin'].includes(r))
const audit = (u: AccessUser, action: string, entityId: string, newValue: any) => prisma.auditLog.create({ data: { tenantId: u.tenantId, userId: u.userId, action, entityType: 'profile_request', entityId, newValue } })

// Sections the person may currently edit because HR asked for them
export async function openRequestSections(tenantId: string, employeeId: string): Promise<Set<string>> {
  const rows = await prisma.profileRequestSection.findMany({ where: { status: { in: ['pending', 'rejected'] }, request: { tenantId, employeeId, status: 'open' } }, select: { section: true } })
  return new Set(rows.map((r) => r.section))
}

const view = (r: any, names: Map<string, string>) => ({
  id: r.id, employeeId: r.employeeId, employee: r.employee ? `${r.employee.firstName} ${r.employee.lastName}` : null, employeeCode: r.employee?.employeeCode ?? null,
  kind: r.kind, note: r.note, dueDate: r.dueDate ? r.dueDate.toISOString().slice(0, 10) : null, status: r.status, requestedBy: names.get(r.requestedBy) ?? null,
  createdAt: r.createdAt, completedAt: r.completedAt,
  sections: (r.sections ?? []).sort((a: any, b: any) => REQUEST_SECTIONS.indexOf(a.section) - REQUEST_SECTIONS.indexOf(b.section)).map((s: any) => ({ section: s.section, label: SECTION_LABELS[s.section as RequestSection], status: s.status, reviewNote: s.reviewNote, submittedAt: s.submittedAt, reviewedAt: s.reviewedAt })),
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
  return r
}

export const requestService = {
  async create(u: AccessUser, body: { employeeIds: string[]; sections: RequestSection[]; kind: 'onboarding' | 'update'; note?: string; dueDate?: string }) {
    if (!isHR(u)) throw new AppError('Only HR sends requests', 403)
    const people = await prisma.employee.findMany({ where: { id: { in: body.employeeIds }, tenantId: u.tenantId, active: true }, select: { id: true, firstName: true } })
    if (people.length !== new Set(body.employeeIds).size) throw new AppError('Some people were not found or have left', 404)
    if (body.kind === 'onboarding') {
      const open = await prisma.profileRequest.findFirst({ where: { tenantId: u.tenantId, employeeId: { in: body.employeeIds }, kind: 'onboarding', status: 'open' }, include: { employee: { select: { employeeCode: true } } } })
      if (open) throw new AppError(`${open.employee.employeeCode} already has onboarding in progress`, 409)
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
    return { created: created.length, ids: created }
  },

  async list(u: AccessUser, filter: { status?: string; mine?: boolean; employeeId?: string }) {
    const where: any = { tenantId: u.tenantId, ...(filter.status ? { status: filter.status } : {}), ...(filter.employeeId ? { employeeId: filter.employeeId } : {}) }
    if (filter.mine || !isHR(u)) where.employeeId = u.employeeId ?? '-'
    const rows = await prisma.profileRequest.findMany({ where, include, orderBy: { createdAt: 'desc' }, take: 300 })
    const names = await requesterNames(rows)
    return rows.map((r) => view(r, names))
  },

  async get(u: AccessUser, id: string) {
    const r = await find(u, id)
    return view(r, await requesterNames([r]))
  },

  async submit(u: AccessUser, id: string, section: string) {
    const r = await find(u, id)
    if (r.employeeId !== u.employeeId) throw new AppError('Only the person can submit their own details', 403)
    if (r.status !== 'open') throw new AppError(`This request is ${r.status}`, 400)
    const s = r.sections.find((x) => x.section === section)
    if (!s) throw new AppError('That section is not part of this request', 404)
    if (!['pending', 'rejected'].includes(s.status)) throw new AppError(`This section is already ${s.status}`, 400)
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
