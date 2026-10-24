import { prisma } from '../../infrastructure/database/prisma'
import { notify, userIdsWithRole, userIdOfEmployee } from '../../infrastructure/notifications/notify'
import { storage, storageConfigured } from '../../infrastructure/storage/storage'
import { AppError } from '../../shared/utils/AppError'
import { AccessUser, canAccessCompensation } from '../../shared/utils/access'

// Data protection (Zambia DPA 2021 and similar laws):
// - export: a copy of a person's personal data as JSON (by the person, or by HR for them; pay only for the person
//   themself or Payroll). Never includes full bank or ID numbers.
// - erasure: after someone has left, HR (never the requester) anonymises their personal details and deletes their
//   documents and profile extras. Pay, tax, leave and attendance records are kept for the legal retention period,
//   under the employee code only. The login is closed for good.

const isHR = (u: AccessUser) => u.roleIds.some((r) => ['hr_admin', 'system_admin'].includes(r))
const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null)
const audit = (u: AccessUser, action: string, entityId: string, newValue?: any) =>
  prisma.auditLog.create({ data: { tenantId: u.tenantId, userId: u.userId, action, entityType: 'employee', entityId, newValue } })

async function person(u: AccessUser, employeeId: string) {
  const e = await prisma.employee.findFirst({ where: { id: employeeId, tenantId: u.tenantId } })
  if (!e || (e.id !== u.employeeId && !isHR(u))) throw new AppError('Employee not found', 404)
  return e
}

export const privacyService = {
  async exportData(u: AccessUser, employeeId: string) {
    const e = await person(u, employeeId)
    const id = e.id
    const [user, addresses, family, emergency, education, previous, identities, documents, leave, attendance, pay] = await Promise.all([
      prisma.user.findUnique({ where: { id: e.userId }, select: { email: true, fullName: true, phone: true, lastLoginAt: true, createdAt: true, mfaEnabled: true } }),
      prisma.employeeAddress.findMany({ where: { employeeId: id } }),
      prisma.employeeFamilyMember.findMany({ where: { employeeId: id } }),
      prisma.employeeEmergencyContact.findMany({ where: { employeeId: id } }),
      prisma.employeeEducation.findMany({ where: { employeeId: id } }),
      prisma.employeePreviousEmployment.findMany({ where: { employeeId: id } }),
      prisma.employeeIdentity.findMany({ where: { employeeId: id }, select: { documentType: true, numberLast4: true, issueDate: true, expiryDate: true, issuingCountry: true } }),
      prisma.employeeDocument.findMany({ where: { employeeId: id, active: true }, select: { category: true, title: true, fileName: true, createdAt: true } }),
      prisma.leaveRequest.findMany({ where: { employeeId: id }, select: { startDate: true, endDate: true, totalDays: true, status: true, reason: true, leaveType: { select: { name: true } } }, orderBy: { startDate: 'desc' }, take: 500 }),
      prisma.attendanceRecord.findMany({ where: { employeeId: id, date: { gte: new Date(Date.now() - 730 * 86_400_000) } }, select: { date: true, checkInTime: true, checkOutTime: true, status: true }, orderBy: { date: 'desc' } }),
      canAccessCompensation(u, id).then((ok) => ok ? prisma.payslip.findMany({ where: { employeeId: id, payrollCycle: { status: { in: ['disbursed', 'locked'] } } }, select: { grossEarnings: true, totalDeductions: true, netPay: true, currency: true, payrollCycle: { select: { payPeriodStart: true, payPeriodEnd: true } } } }) : null),
    ])
    const strip = (rows: any[]) => rows.map(({ id: _i, tenantId: _t, employeeId: _e, ...r }) => r)
    await audit(u, 'PERSONAL_DATA_EXPORTED', id, { by: u.employeeId === id ? 'self' : 'hr' })
    return {
      exportedAt: new Date().toISOString(),
      about: 'Personal data MarichiHR holds about you. Bank and identity numbers show only their last 4 digits.',
      profile: {
        employeeCode: e.employeeCode, firstName: e.firstName, middleName: e.middleName, lastName: e.lastName, preferredName: e.preferredName,
        dateOfBirth: ymd(e.dateOfBirth), gender: e.gender, nationality: e.nationality, maritalStatus: e.maritalStatus, bloodGroup: e.bloodGroup, religion: e.religion,
        personalEmail: e.personalEmail, workEmail: e.workEmail, mobilePersonal: e.mobilePersonal, mobileWork: e.mobileWork,
        hireDate: ymd(e.hireDate), employmentType: e.employmentType, employmentStatus: e.employmentStatus, exitDate: ymd(e.exitDate),
        bank: e.bankName ? { bank: e.bankName, accountLast4: e.bankAccountNo ? '••••' : null, verified: e.bankVerified } : null,
        customFields: e.customFields,
      },
      login: user, addresses: strip(addresses), family: strip(family), emergencyContacts: strip(emergency), education: strip(education), previousEmployment: strip(previous), identities, documents,
      leave: leave.map((l) => ({ type: l.leaveType?.name, from: ymd(l.startDate), to: ymd(l.endDate), days: l.totalDays, status: l.status, reason: l.reason })),
      attendanceLast2Years: attendance.map((a) => ({ date: ymd(a.date), in: a.checkInTime, out: a.checkOutTime, status: a.status })),
      ...(pay && { payslips: pay.map((p) => ({ from: ymd(p.payrollCycle.payPeriodStart), to: ymd(p.payrollCycle.payPeriodEnd), gross: Number(p.grossEarnings), deductions: Number(p.totalDeductions), net: Number(p.netPay), currency: p.currency })) }),
    }
  },

  async requests(u: AccessUser, scope: 'mine' | 'all') {
    if (scope === 'all' && !isHR(u)) throw new AppError('Only HR sees all requests', 403)
    const rows = await prisma.privacyRequest.findMany({ where: { tenantId: u.tenantId, ...(scope === 'mine' && { employeeId: u.employeeId ?? '' }) }, orderBy: { createdAt: 'desc' }, take: 200 })
    const emps = await prisma.employee.findMany({ where: { tenantId: u.tenantId, id: { in: rows.map((r) => r.employeeId) } }, select: { id: true, firstName: true, lastName: true, employeeCode: true, employmentStatus: true, active: true } })
    return rows.map((r) => { const e = emps.find((x) => x.id === r.employeeId); return { ...r, employee: e ? `${e.firstName} ${e.lastName} (${e.employeeCode})` : '', hasLeft: !!e && (!e.active || ['terminated', 'exited', 'resigned'].includes(e.employmentStatus)) } })
  },

  async requestErasure(u: AccessUser, employeeId: string, reason?: string) {
    const e = await person(u, employeeId)
    if (await prisma.privacyRequest.count({ where: { tenantId: u.tenantId, employeeId: e.id, kind: 'erasure', status: 'pending' } })) throw new AppError('An erasure request is already waiting', 409)
    const r = await prisma.privacyRequest.create({ data: { tenantId: u.tenantId, employeeId: e.id, kind: 'erasure', reason: reason ?? null, requestedBy: u.userId } })
    await audit(u, 'ERASURE_REQUESTED', e.id, { requestId: r.id })
    await notify({ tenantId: u.tenantId, userIds: (await userIdsWithRole(u.tenantId, 'hr_admin')).filter((x) => x !== u.userId), type: 'privacy.erasure_requested', title: 'Request to erase personal data', body: `${e.firstName} ${e.lastName} (${e.employeeCode})${reason ? `: ${reason}` : ''}`, link: '/settings/privacy', entityType: 'privacy_request', entityId: r.id })
    return r
  },

  async decide(u: AccessUser, id: string, approve: boolean, note?: string) {
    if (!isHR(u)) throw new AppError('HR decides erasure requests', 403)
    const r = await prisma.privacyRequest.findFirst({ where: { id, tenantId: u.tenantId, status: 'pending' } })
    if (!r) throw new AppError('Request not found', 404)
    if (r.requestedBy === u.userId) throw new AppError('Someone other than the requester decides this', 403)
    if (r.employeeId === u.employeeId) throw new AppError('You cannot decide your own request', 403)
    const e = await prisma.employee.findFirst({ where: { id: r.employeeId, tenantId: u.tenantId } })
    if (!e) throw new AppError('Employee not found', 404)
    if (approve && e.active && !['terminated', 'exited', 'resigned'].includes(e.employmentStatus)) throw new AppError('Erasure is for people who have left. Finish their exit (or archive them) first.', 400)
    const done = await prisma.privacyRequest.updateMany({ where: { id, status: 'pending' }, data: { status: approve ? 'done' : 'rejected', decidedBy: u.userId, decidedAt: new Date(), note: note ?? null } })
    if (!done.count) throw new AppError('Already decided', 409)
    const requester = r.requestedBy
    if (!approve) {
      await audit(u, 'ERASURE_REJECTED', e.id, { requestId: id, note })
      await notify({ tenantId: u.tenantId, userIds: [requester], type: 'privacy.erasure_decided', title: 'Erasure request declined', body: note || 'HR declined the request.', link: '/settings/privacy', entityType: 'privacy_request', entityId: id })
      return { erased: false }
    }
    // Documents: files first (storage), then the rows
    const docs = await prisma.employeeDocument.findMany({ where: { employeeId: e.id }, select: { fileKey: true } })
    if (storageConfigured()) for (const d of docs) await storage().remove(d.fileKey).catch(() => null)
    const label = `Former employee ${e.employeeCode}`
    await prisma.$transaction([
      prisma.employeeDocument.deleteMany({ where: { employeeId: e.id } }),
      prisma.employeeAddress.deleteMany({ where: { employeeId: e.id } }),
      prisma.employeeFamilyMember.deleteMany({ where: { employeeId: e.id } }),
      prisma.employeeEmergencyContact.deleteMany({ where: { employeeId: e.id } }),
      prisma.employeeEducation.deleteMany({ where: { employeeId: e.id } }),
      prisma.employeePreviousEmployment.deleteMany({ where: { employeeId: e.id } }),
      prisma.employeeIdentity.deleteMany({ where: { employeeId: e.id } }),
      prisma.employee.update({ where: { id: e.id }, data: {
        firstName: 'Former employee', lastName: e.employeeCode, middleName: null, preferredName: null, title: null, dateOfBirth: null, gender: null, nationality: null,
        personalEmail: null, workEmail: null, mobilePersonal: null, mobileWork: null, emergencyContactName: null, emergencyContactPhone: null, emergencyContactRelation: null,
        maritalStatus: null, marriageDate: null, bloodGroup: null, religion: null, languages: undefined, customFields: undefined,
        bankName: null, bankAccountNo: null, bankIfscSwift: null, bankVerified: false, bankVerifiedBy: null, bankVerifiedAt: null, active: false,
      } }),
      prisma.user.update({ where: { id: e.userId }, data: { fullName: label, email: `erased-${e.id}@erased.invalid`, phone: null, avatarUrl: null, passwordHash: null, googleSub: null, mfaEnabled: false, mfaSecret: null, active: false } }),
      prisma.refreshToken.deleteMany({ where: { userId: e.userId } }),
    ])
    await audit(u, 'PERSONAL_DATA_ERASED', e.id, { requestId: id, documents: docs.length, kept: 'pay, tax, leave and attendance records under the employee code' })
    if (requester !== e.userId) await notify({ tenantId: u.tenantId, userIds: [requester], type: 'privacy.erasure_decided', title: `Personal data erased: ${e.employeeCode}`, body: 'Pay, tax, leave and attendance records are kept under the employee code for the legal retention period.', link: '/settings/privacy', entityType: 'privacy_request', entityId: id })
    return { erased: true, documents: docs.length }
  },
}
