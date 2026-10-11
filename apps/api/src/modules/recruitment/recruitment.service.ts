import { prisma } from '../../infrastructure/database/prisma'
import { notify, userIdsWithRole, userIdOfEmployee } from '../../infrastructure/notifications/notify'
import { AppError } from '../../shared/utils/AppError'
import { AccessUser } from '../../shared/utils/access'
import { employeeService } from '../employees/employees.service'
import { incentiveService } from '../incentives/incentives.service'
import { assertMasters } from '../masters/masters.service'

// Recruitment. Who may do what:
//  - openings: HR creates them open; a manager requests one (pending_approval) that an HR admin other than the
//    requester approves or rejects. Everyone sees open openings (internal job board) and can refer someone.
//  - candidates: HR and the opening's hiring manager add them, move stages, schedule interviews and reject
//  - interviews: only the assigned interviewer records feedback; interviewers see the candidates they interview
//  - offers and hiring: HR only. Hiring needs an accepted offer and creates the employee record (no login yet)

const STAGES = ['applied', 'screening', 'interview', 'offer', 'hired', 'rejected', 'withdrawn'] as const
const CLOSED_STAGES = ['hired', 'rejected', 'withdrawn']
const isHR = (u: AccessUser) => u.roleIds.includes('hr_admin')
const audit = (user: AccessUser, action: string, entityType: string, entityId: string, newValue?: any) =>
  prisma.auditLog.create({ data: { tenantId: user.tenantId, userId: user.userId, action, entityType, entityId, newValue } })
const num = (v: any) => (v == null ? null : Number(v))
const day = (v: string) => new Date(`${v.slice(0, 10)}T00:00:00.000Z`)

async function findOpening(user: AccessUser, id: string) {
  const o = await prisma.jobOpening.findFirst({ where: { id, tenantId: user.tenantId } })
  if (!o) throw new AppError('Opening not found', 404)
  return o
}
const manages = (user: AccessUser, o: { hiringManagerId: string | null; requestedByUserId: string }) =>
  isHR(user) || (!!user.employeeId && o.hiringManagerId === user.employeeId) || o.requestedByUserId === user.userId

// A candidate the caller may work on (HR or the hiring manager); 404 otherwise so ids don't leak
async function findCandidate(user: AccessUser, id: string, opts: { interviewerOk?: boolean } = {}) {
  const c = await prisma.candidate.findFirst({ where: { id, tenantId: user.tenantId }, include: { opening: true } })
  if (!c) throw new AppError('Candidate not found', 404)
  if (manages(user, c.opening)) return { c, full: true }
  if (opts.interviewerOk && (await prisma.interview.findFirst({ where: { candidateId: id, interviewerUserId: user.userId } }))) return { c, full: false }
  throw new AppError('Candidate not found', 404)
}

async function people(employeeIds: (string | null)[], userIds: (string | null)[]) {
  const [emps, users] = await Promise.all([
    prisma.employee.findMany({ where: { id: { in: [...new Set(employeeIds.filter(Boolean) as string[])] } }, select: { id: true, firstName: true, lastName: true } }),
    prisma.user.findMany({ where: { id: { in: [...new Set(userIds.filter(Boolean) as string[])] } }, select: { id: true, fullName: true } }),
  ])
  const m = new Map<string, string>()
  emps.forEach((e) => m.set(`e:${e.id}`, `${e.firstName} ${e.lastName}`))
  users.forEach((u) => m.set(`u:${u.id}`, u.fullName))
  return m
}

const openingView = (o: any, names: Map<string, string>, extra: Record<string, unknown> = {}) => ({
  id: o.id, title: o.title, description: o.description, orgUnitId: o.orgUnitId, orgUnit: o.orgUnitName ?? null, jobPositionId: o.jobPositionId,
  workLocationId: o.workLocationId, employmentType: o.employmentType, openings: o.openings, salaryMin: num(o.salaryMin), salaryMax: num(o.salaryMax),
  currency: o.currency, hiringManagerId: o.hiringManagerId, hiringManager: o.hiringManagerId ? names.get(`e:${o.hiringManagerId}`) ?? null : null,
  status: o.status, closedReason: o.closedReason, requestedBy: names.get(`u:${o.requestedByUserId}`) ?? null, requestedByUserId: o.requestedByUserId,
  approvedBy: o.approvedByUserId ? names.get(`u:${o.approvedByUserId}`) ?? null : null, approvedAt: o.approvedAt, closedAt: o.closedAt, createdAt: o.createdAt,
  ...extra,
})

const candidateView = (c: any, names: Map<string, string>, full: boolean) => ({
  id: c.id, openingId: c.openingId, opening: c.opening?.title, firstName: c.firstName, lastName: c.lastName, stage: c.stage, source: c.source,
  summary: c.summary, resumeUrl: c.resumeUrl, rating: c.rating, createdAt: c.createdAt,
  ...(full ? {
    email: c.email, phone: c.phone, rejectionReason: c.rejectionReason,
    referredByEmployeeId: c.referredByEmployeeId, referredBy: c.referredByEmployeeId ? names.get(`e:${c.referredByEmployeeId}`) ?? null : null,
    offerCtcAnnual: num(c.offerCtcAnnual), offerJoiningDate: c.offerJoiningDate, offerStatus: c.offerStatus, offerNote: c.offerNote,
    hiredEmployeeId: c.hiredEmployeeId, hiredAt: c.hiredAt,
  } : {}),
})

const interviewView = (i: any, names: Map<string, string>) => ({
  id: i.id, candidateId: i.candidateId, interviewerUserId: i.interviewerUserId, interviewer: names.get(`u:${i.interviewerUserId}`) ?? null,
  scheduledAt: i.scheduledAt, mode: i.mode, status: i.status, rating: i.rating, recommendation: i.recommendation, feedback: i.feedback, completedAt: i.completedAt,
})

type OpeningBody = { title: string; description?: string; orgUnitId: string; jobPositionId?: string | null; workLocationId?: string | null; employmentType?: string; openings?: number; salaryMin?: number | null; salaryMax?: number | null; hiringManagerId?: string | null }

async function checkOpeningRefs(user: AccessUser, b: Partial<OpeningBody>) {
  const t = user.tenantId
  const [unit, pos, loc, mgr] = await Promise.all([
    b.orgUnitId ? prisma.orgUnit.findFirst({ where: { id: b.orgUnitId, tenantId: t } }) : true,
    b.jobPositionId ? prisma.jobPosition.findFirst({ where: { id: b.jobPositionId, tenantId: t } }) : true,
    b.workLocationId ? prisma.workLocation.findFirst({ where: { id: b.workLocationId, tenantId: t } }) : true,
    b.hiringManagerId ? prisma.employee.findFirst({ where: { id: b.hiringManagerId, tenantId: t, active: true } }) : true,
  ])
  if (!unit || !pos || !loc || !mgr) throw new AppError('Department, position, location or hiring manager not found', 404)
  await assertMasters(user.tenantId, { employment_type: b.employmentType })
  if (b.salaryMin != null && b.salaryMax != null && b.salaryMin > b.salaryMax) throw new AppError('The salary range is upside down', 400)
}

export const recruitmentService = {
  // HR sees every opening with pipeline counts; others see open ones (job board) plus those they manage or requested
  async openings(user: AccessUser) {
    const where: any = isHR(user)
      ? { tenantId: user.tenantId }
      : { tenantId: user.tenantId, OR: [{ status: 'open' }, { requestedByUserId: user.userId }, ...(user.employeeId ? [{ hiringManagerId: user.employeeId }] : [])] }
    const rows = await prisma.jobOpening.findMany({ where, orderBy: { createdAt: 'desc' }, take: 500 })
    const [units, counts, names] = await Promise.all([
      prisma.orgUnit.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.orgUnitId))] } }, select: { id: true, name: true } }),
      prisma.candidate.groupBy({ by: ['openingId', 'stage'], where: { tenantId: user.tenantId, openingId: { in: rows.map((r) => r.id) } }, _count: true }),
      people(rows.map((r) => r.hiringManagerId), rows.flatMap((r) => [r.requestedByUserId, r.approvedByUserId])),
    ])
    const unitName = new Map(units.map((u) => [u.id, u.name]))
    return rows.map((o) => {
      const pipeline = manages(user, o) ? Object.fromEntries(STAGES.map((s) => [s, counts.find((c) => c.openingId === o.id && c.stage === s)?._count ?? 0])) : null
      return openingView({ ...o, orgUnitName: unitName.get(o.orgUnitId) }, names, { canManage: manages(user, o), pipeline })
    })
  },

  async opening(user: AccessUser, id: string) {
    const o = await findOpening(user, id)
    const canManage = manages(user, o)
    if (!canManage && o.status !== 'open') throw new AppError('Opening not found', 404)
    const [unit, candidates] = await Promise.all([
      prisma.orgUnit.findUnique({ where: { id: o.orgUnitId }, select: { name: true } }),
      canManage ? prisma.candidate.findMany({ where: { openingId: id, tenantId: user.tenantId }, include: { interviews: true }, orderBy: { createdAt: 'desc' } }) : [],
    ])
    const names = await people([o.hiringManagerId, ...candidates.map((c) => c.referredByEmployeeId)], [o.requestedByUserId, o.approvedByUserId])
    return openingView({ ...o, orgUnitName: unit?.name }, names, {
      canManage,
      candidates: candidates.map((c) => ({ ...candidateView(c, names, true), interviews: c.interviews.length, feedbackIn: c.interviews.filter((i) => i.status === 'completed').length })),
    })
  },

  async createOpening(user: AccessUser, b: OpeningBody) {
    const hr = isHR(user)
    if (!hr && !user.roleIds.includes('manager')) throw new AppError('Only HR or managers can open a position', 403)
    const hiringManagerId = b.hiringManagerId ?? (hr ? null : user.employeeId ?? null)
    if (!hr && hiringManagerId !== user.employeeId) throw new AppError('Managers request openings for their own team', 403)
    await checkOpeningRefs(user, { ...b, hiringManagerId })
    const tenant = await prisma.tenant.findUnique({ where: { id: user.tenantId }, select: { baseCurrency: true } })
    const o = await prisma.jobOpening.create({
      data: {
        tenantId: user.tenantId, title: b.title, description: b.description ?? '', orgUnitId: b.orgUnitId, jobPositionId: b.jobPositionId ?? null,
        workLocationId: b.workLocationId ?? null, employmentType: b.employmentType ?? 'full_time', openings: b.openings ?? 1,
        salaryMin: b.salaryMin ?? null, salaryMax: b.salaryMax ?? null, currency: tenant?.baseCurrency ?? 'USD', hiringManagerId,
        status: hr ? 'open' : 'pending_approval', requestedByUserId: user.userId, ...(hr ? { approvedByUserId: user.userId, approvedAt: new Date() } : {}),
      },
    })
    await audit(user, hr ? 'OPENING_CREATED' : 'OPENING_REQUESTED', 'job_opening', o.id, { title: o.title, openings: o.openings })
    if (!hr) {
      const hrs = (await userIdsWithRole(user.tenantId, 'hr_admin')).filter((id) => id !== user.userId)
      await notify({ tenantId: user.tenantId, userIds: hrs, type: 'recruitment.opening_requested', title: 'New hiring request', body: `${o.title} · ${o.openings} position${o.openings > 1 ? 's' : ''}`, link: `/recruitment/${o.id}`, entityType: 'job_opening', entityId: o.id })
    }
    return o
  },

  async updateOpening(user: AccessUser, id: string, b: Partial<OpeningBody> & { status?: 'open' | 'on_hold' | 'closed'; closedReason?: string | null }) {
    const o = await findOpening(user, id)
    if (!isHR(user)) throw new AppError('Only HR can change an opening', 403)
    if (['pending_approval', 'rejected'].includes(o.status) && b.status) throw new AppError('Approve the request before changing its status', 400)
    if (o.status === 'closed' && b.status !== 'open' && Object.keys(b).length) throw new AppError('Reopen the opening before editing it', 400)
    await checkOpeningRefs(user, { salaryMin: num(o.salaryMin), salaryMax: num(o.salaryMax), ...b })
    const { status, closedReason, ...fields } = b
    const updated = await prisma.jobOpening.update({
      where: { id },
      data: { ...fields, ...(status ? { status, closedAt: status === 'closed' ? new Date() : null, closedReason: status === 'closed' ? closedReason ?? 'Closed' : null } : {}) },
    })
    await audit(user, 'OPENING_UPDATED', 'job_opening', id, b)
    return updated
  },

  async decideOpening(user: AccessUser, id: string, approve: boolean, note?: string) {
    const o = await findOpening(user, id)
    if (!isHR(user)) throw new AppError('Only HR approves hiring requests', 403)
    if (o.status !== 'pending_approval') throw new AppError('This request was already decided', 400)
    if (o.requestedByUserId === user.userId) throw new AppError('A hiring request must be approved by someone other than the requester', 403)
    if (!approve && !note) throw new AppError('Give a reason for rejecting', 400)
    const done = await prisma.jobOpening.updateMany({
      where: { id, status: 'pending_approval' },
      data: approve ? { status: 'open', approvedByUserId: user.userId, approvedAt: new Date() } : { status: 'rejected', closedReason: note, closedAt: new Date(), approvedByUserId: user.userId },
    })
    if (!done.count) throw new AppError('This request was just decided by someone else', 409)
    await audit(user, approve ? 'OPENING_APPROVED' : 'OPENING_REJECTED', 'job_opening', id, { note: note ?? null })
    await notify({ tenantId: user.tenantId, userIds: [o.requestedByUserId], type: 'recruitment.opening_decided', title: `Hiring request ${approve ? 'approved' : 'rejected'}`, body: note ?? o.title, link: `/recruitment/${id}`, entityType: 'job_opening', entityId: id })
    return findOpening(user, id)
  },

  // HR / hiring manager add candidates; anyone can refer someone for an open position
  async addCandidate(user: AccessUser, openingId: string, b: { firstName: string; lastName: string; email: string; phone?: string | null; source?: string; resumeUrl?: string | null; summary?: string | null }, referral: boolean) {
    const o = await findOpening(user, openingId)
    if (o.status !== 'open') throw new AppError('This opening is not taking candidates', 400)
    if (!referral && !manages(user, o)) throw new AppError('Only HR or the hiring manager can add candidates; use Refer instead', 403)
    if (referral && !user.employeeId) throw new AppError('Only employees can refer candidates', 403)
    if (!referral) await assertMasters(user.tenantId, { source_of_hire: b.source })
    const email = b.email.trim().toLowerCase()
    if (await prisma.candidate.findFirst({ where: { openingId, tenantId: user.tenantId, email: { equals: email, mode: 'insensitive' } } })) {
      throw new AppError('This person is already a candidate for this opening', 409)
    }
    const c = await prisma.candidate.create({
      data: {
        tenantId: user.tenantId, openingId, firstName: b.firstName, lastName: b.lastName, email, phone: b.phone ?? null,
        source: referral ? 'referral' : b.source ?? 'direct', resumeUrl: b.resumeUrl ?? null, summary: b.summary ?? null,
        referredByEmployeeId: referral ? user.employeeId : null, createdByUserId: user.userId,
      },
    })
    await audit(user, referral ? 'CANDIDATE_REFERRED' : 'CANDIDATE_ADDED', 'candidate', c.id, { openingId, name: `${c.firstName} ${c.lastName}` })
    if (referral) {
      const to = new Set(await userIdsWithRole(user.tenantId, 'hr_admin'))
      const hm = await userIdOfEmployee(user.tenantId, o.hiringManagerId)
      if (hm) to.add(hm)
      to.delete(user.userId)
      await notify({ tenantId: user.tenantId, userIds: [...to], type: 'recruitment.referral', title: `New referral for ${o.title}`, body: `${c.firstName} ${c.lastName}`, link: `/recruitment/${o.id}`, entityType: 'candidate', entityId: c.id })
    }
    return candidateView(c, new Map(), true)
  },

  // Candidates I referred, with their stage (no contact details or offer terms of others' work)
  async myReferrals(user: AccessUser) {
    if (!user.employeeId) return []
    const rows = await prisma.candidate.findMany({ where: { tenantId: user.tenantId, referredByEmployeeId: user.employeeId }, include: { opening: true }, orderBy: { createdAt: 'desc' } })
    return rows.map((c) => ({ id: c.id, name: `${c.firstName} ${c.lastName}`, opening: c.opening.title, stage: c.stage, createdAt: c.createdAt }))
  },

  async candidate(user: AccessUser, id: string) {
    const { c, full } = await findCandidate(user, id, { interviewerOk: true })
    const interviews = await prisma.interview.findMany({ where: { candidateId: id, ...(full ? {} : { interviewerUserId: user.userId }) }, orderBy: { scheduledAt: 'asc' } })
    const names = await people([c.referredByEmployeeId], interviews.map((i) => i.interviewerUserId))
    return { ...candidateView(c, names, full), canManage: full, interviews: interviews.map((i) => interviewView(i, names)) }
  },

  async updateCandidate(user: AccessUser, id: string, b: { stage?: string; rating?: number | null; rejectionReason?: string; summary?: string | null; resumeUrl?: string | null; phone?: string | null }) {
    const { c } = await findCandidate(user, id)
    // Hired is final; only HR can bring back a rejected or withdrawn candidate
    if (c.stage === 'hired' || (CLOSED_STAGES.includes(c.stage) && b.stage && !isHR(user))) throw new AppError(`This candidate is ${c.stage}`, 400)
    if (b.stage === 'offer' || b.stage === 'hired') throw new AppError(b.stage === 'offer' ? 'Use Make offer' : 'Use Hire', 400)
    if (b.stage === 'rejected' && !b.rejectionReason) throw new AppError('Give a reason for rejecting', 400)
    const data: any = { ...b }
    if (b.stage && b.stage !== 'rejected') data.rejectionReason = null
    if (b.stage === 'rejected' || b.stage === 'withdrawn') {
      if (c.offerStatus === 'made') data.offerStatus = 'declined'
      await prisma.interview.updateMany({ where: { candidateId: id, status: 'scheduled' }, data: { status: 'cancelled' } })
    }
    const updated = await prisma.candidate.update({ where: { id }, data, include: { opening: true } })
    if (b.stage && b.stage !== c.stage) await audit(user, 'CANDIDATE_STAGE_CHANGED', 'candidate', id, { from: c.stage, to: b.stage, reason: b.rejectionReason ?? null })
    return candidateView(updated, new Map(), true)
  },

  async schedule(user: AccessUser, candidateId: string, b: { interviewerUserId: string; scheduledAt: string; mode?: string }) {
    const { c } = await findCandidate(user, candidateId)
    if (CLOSED_STAGES.includes(c.stage)) throw new AppError(`This candidate is ${c.stage}`, 400)
    const interviewer = await prisma.user.findFirst({ where: { id: b.interviewerUserId, tenantId: user.tenantId, active: true } })
    if (!interviewer) throw new AppError('Interviewer not found', 404)
    const i = await prisma.interview.create({ data: { candidateId, interviewerUserId: interviewer.id, scheduledAt: new Date(b.scheduledAt), mode: b.mode ?? 'video', createdByUserId: user.userId } })
    if (['applied', 'screening'].includes(c.stage)) await prisma.candidate.update({ where: { id: candidateId }, data: { stage: 'interview' } })
    await audit(user, 'INTERVIEW_SCHEDULED', 'candidate', candidateId, { interviewId: i.id, interviewer: interviewer.fullName, scheduledAt: b.scheduledAt })
    if (interviewer.id !== user.userId) {
      await notify({ tenantId: user.tenantId, userIds: [interviewer.id], type: 'recruitment.interview', title: `Interview: ${c.firstName} ${c.lastName}`, body: `${c.opening.title} · ${new Date(b.scheduledAt).toUTCString().slice(0, 22)} UTC`, link: `/recruitment/candidates/${candidateId}`, entityType: 'interview', entityId: i.id })
    }
    return interviewView(i, new Map([[`u:${interviewer.id}`, interviewer.fullName]]))
  },

  async myInterviews(user: AccessUser) {
    const rows = await prisma.interview.findMany({ where: { interviewerUserId: user.userId, candidate: { tenantId: user.tenantId } }, include: { candidate: { include: { opening: true } } }, orderBy: { scheduledAt: 'asc' }, take: 200 })
    return rows.map((i) => ({ ...interviewView(i, new Map()), candidate: `${i.candidate.firstName} ${i.candidate.lastName}`, opening: i.candidate.opening.title }))
  },

  async feedback(user: AccessUser, id: string, b: { rating: number; recommendation: string; feedback: string }) {
    const i = await prisma.interview.findFirst({ where: { id, candidate: { tenantId: user.tenantId } } })
    if (!i || i.interviewerUserId !== user.userId) throw new AppError('Interview not found', 404)
    if (i.status === 'cancelled') throw new AppError('This interview was cancelled', 400)
    const updated = await prisma.interview.update({ where: { id }, data: { ...b, status: 'completed', completedAt: i.completedAt ?? new Date() } })
    await audit(user, 'INTERVIEW_FEEDBACK', 'candidate', i.candidateId, { interviewId: id, rating: b.rating, recommendation: b.recommendation })
    const c = await prisma.candidate.findUnique({ where: { id: i.candidateId }, include: { opening: true } })
    const hm = await userIdOfEmployee(user.tenantId, c?.opening.hiringManagerId)
    const to = [i.createdByUserId, hm].filter((x): x is string => !!x && x !== user.userId)
    if (c && to.length) await notify({ tenantId: user.tenantId, userIds: [...new Set(to)], type: 'recruitment.feedback', title: `Feedback in: ${c.firstName} ${c.lastName}`, body: `${b.recommendation.replace(/_/g, ' ')} · ${b.rating}/5`, link: `/recruitment/candidates/${c.id}`, entityType: 'interview', entityId: id })
    return interviewView(updated, new Map())
  },

  async cancelInterview(user: AccessUser, id: string) {
    const i = await prisma.interview.findFirst({ where: { id, candidate: { tenantId: user.tenantId } } })
    if (!i) throw new AppError('Interview not found', 404)
    await findCandidate(user, i.candidateId)
    if (i.status !== 'scheduled') throw new AppError(`This interview is ${i.status}`, 400)
    await prisma.interview.update({ where: { id }, data: { status: 'cancelled' } })
    return { cancelled: true }
  },

  async offer(user: AccessUser, id: string, b: { ctcAnnual: number; joiningDate: string; note?: string }) {
    if (!isHR(user)) throw new AppError('Only HR makes offers', 403)
    const { c } = await findCandidate(user, id)
    if (CLOSED_STAGES.includes(c.stage)) throw new AppError(`This candidate is ${c.stage}`, 400)
    if (c.opening.status !== 'open') throw new AppError('The opening is not open', 400)
    const updated = await prisma.candidate.update({ where: { id }, data: { stage: 'offer', offerStatus: 'made', offerCtcAnnual: b.ctcAnnual, offerJoiningDate: day(b.joiningDate), offerNote: b.note ?? null }, include: { opening: true } })
    await audit(user, 'OFFER_MADE', 'candidate', id, { ctcAnnual: b.ctcAnnual, joiningDate: b.joiningDate })
    return candidateView(updated, new Map(), true)
  },

  async offerResponse(user: AccessUser, id: string, accepted: boolean) {
    if (!isHR(user)) throw new AppError('Only HR records offer responses', 403)
    const { c } = await findCandidate(user, id)
    if (c.offerStatus !== 'made') throw new AppError('There is no open offer', 400)
    const updated = await prisma.candidate.update({ where: { id }, data: { offerStatus: accepted ? 'accepted' : 'declined', ...(accepted ? {} : { stage: 'withdrawn' }) }, include: { opening: true } })
    await audit(user, accepted ? 'OFFER_ACCEPTED' : 'OFFER_DECLINED', 'candidate', id)
    return candidateView(updated, new Map(), true)
  },

  // Accepted offer -> employee record (no login; HR grants that on the profile). Fills the opening when the last seat is taken.
  async hire(user: AccessUser, id: string, b: { workEmail: string; orgUnitId?: string; managerId?: string | null; hireDate?: string; jobPositionId?: string | null; referralBonus?: number }) {
    if (!isHR(user)) throw new AppError('Only HR can hire', 403)
    const { c } = await findCandidate(user, id)
    if (c.stage !== 'offer' || c.offerStatus !== 'accepted') throw new AppError('The candidate must accept an offer first', 400)
    if (b.referralBonus && !c.referredByEmployeeId) throw new AppError('This candidate was not referred', 400)
    const hireDate = b.hireDate ?? c.offerJoiningDate?.toISOString().slice(0, 10)
    if (!hireDate) throw new AppError('Give a joining date', 400)
    // Claim the candidate first so two clicks cannot create two employees
    const claimed = await prisma.candidate.updateMany({ where: { id, stage: 'offer', hiredEmployeeId: null }, data: { stage: 'hired', hiredAt: new Date() } })
    if (!claimed.count) throw new AppError('This candidate was just hired', 409)
    let employee: { id: string; employeeCode: string }
    try {
      const managerId = b.managerId === undefined ? c.opening.hiringManagerId ?? undefined : b.managerId ?? undefined
      const res = await employeeService.create(user.tenantId, {
        firstName: c.firstName, lastName: c.lastName, workEmail: b.workEmail.trim().toLowerCase(), personalEmail: c.email, mobilePersonal: c.phone ?? undefined,
        orgUnitId: b.orgUnitId ?? c.opening.orgUnitId, jobPositionId: (b.jobPositionId ?? c.opening.jobPositionId) ?? undefined, managerId,
        workLocationId: c.opening.workLocationId ?? undefined, hireDate, employmentType: c.opening.employmentType as any,
      }, user.userId)
      employee = res.employee as any
    } catch (err) {
      await prisma.candidate.update({ where: { id }, data: { stage: 'offer', hiredAt: null } })
      throw err
    }
    await prisma.candidate.update({ where: { id }, data: { hiredEmployeeId: employee.id } })
    await audit(user, 'CANDIDATE_HIRED', 'candidate', id, { employeeId: employee.id, employeeCode: employee.employeeCode })
    const hired = await prisma.candidate.count({ where: { openingId: c.openingId, stage: 'hired' } })
    if (hired >= c.opening.openings) await prisma.jobOpening.update({ where: { id: c.openingId }, data: { status: 'closed', closedReason: 'Filled', closedAt: new Date() } })
    let referral: unknown = null
    if (c.referredByEmployeeId) {
      const referrer = await userIdOfEmployee(user.tenantId, c.referredByEmployeeId)
      if (referrer) await notify({ tenantId: user.tenantId, userIds: [referrer], type: 'recruitment.referral_hired', title: `${c.firstName} ${c.lastName} joined`, body: `Your referral for ${c.opening.title} was hired`, link: '/recruitment', entityType: 'candidate', entityId: id })
      if (b.referralBonus) {
        const type = (await incentiveService.types(user)).find((t) => t.code === 'REFERRAL' && t.active)
        if (type) referral = await incentiveService.nominate(user, { employeeId: c.referredByEmployeeId, typeId: type.id, amount: b.referralBonus, reason: `Referred ${c.firstName} ${c.lastName} (${c.opening.title})` })
      }
    }
    return { employee, openingFilled: hired >= c.opening.openings, referralIncentive: referral }
  },
}
