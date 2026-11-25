import { notify, userIdOfEmployee } from '../../infrastructure/notifications/notify'
import { prisma } from '../../infrastructure/database/prisma'
import { hrAdminsFor } from '../../shared/utils/access'

// Notifications for attendance requests (missed-punch fixes and overtime). A request with an approval chain is announced by the chain
// itself; these cover the plain case (no chain): the direct manager is told, or HR when the person has no manager, and the person who asked
// is told how it was decided. Best effort: a failed notification never fails the request.
const KIND = { regularisation: { waiting: 'attendance.regularisation.waiting', decided: 'attendance.regularisation.decided', what: 'missed-punch fix', mine: 'attendance fix' }, overtime: { waiting: 'overtime.waiting', decided: 'overtime.decided', what: 'overtime request', mine: 'overtime request' } } as const
type Kind = keyof typeof KIND

export async function tellApprovers(tenantId: string, employeeId: string, kind: Kind, requestId: string) {
  try {
    const e = await prisma.employee.findUnique({ where: { id: employeeId }, select: { firstName: true, lastName: true, managerId: true } })
    const manager = await userIdOfEmployee(tenantId, e?.managerId)
    const to = manager ? [manager] : await hrAdminsFor(tenantId, employeeId)
    await notify({ tenantId, userIds: to, type: KIND[kind].waiting, title: `${e?.firstName} ${e?.lastName}: ${KIND[kind].what} waiting for you`, body: 'Open Approvals to review it.', link: '/approvals', entityType: kind, entityId: requestId })
  } catch { /* best effort */ }
}

export async function tellRequester(tenantId: string, employeeId: string, kind: Kind, requestId: string, approved: boolean, comments?: string) {
  try {
    const to = await userIdOfEmployee(tenantId, employeeId)
    if (!to) return
    await notify({ tenantId, userIds: [to], type: KIND[kind].decided, title: `Your ${KIND[kind].mine} was ${approved ? 'approved' : 'not approved'}`, body: comments ? `Note: ${comments}` : approved ? 'No further action is needed.' : 'Open Attendance to see the details.', link: '/attendance', entityType: kind, entityId: requestId })
  } catch { /* best effort */ }
}
