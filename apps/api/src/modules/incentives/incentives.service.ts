import { prisma } from '../../infrastructure/database/prisma'
import { notify, userIdsWithRole, userIdOfEmployee } from '../../infrastructure/notifications/notify'
import { AppError } from '../../shared/utils/AppError'
import { AccessUser, getReportingSubtreeIds } from '../../shared/utils/access'

// Incentives paid through payroll. Who may do what:
//  - nominate: HR admins (anyone but themselves) and managers (people in their reporting line)
//  - approve / reject: HR admins, never their own nomination
//  - post approved awards into a draft/review payroll run: HR or payroll admins; each becomes a payroll input,
//    which payroll then approves like any input (by someone other than the person who posted it)

const DEFAULT_TYPES = [
  { code: 'SPOT', name: 'Spot award', description: 'Thank-you for outstanding work, given on the spot', input: 'MANUAL_BONUS' },
  { code: 'REFERRAL', name: 'Referral bonus', description: 'For referring someone who joined', input: 'REFERRAL' },
  { code: 'PERFORMANCE', name: 'Performance bonus', description: 'For results against goals', input: 'MANUAL_BONUS' },
  { code: 'FESTIVAL', name: 'Festival bonus', description: 'Seasonal or festival payout', input: 'MANUAL_BONUS' },
]

const isHR = (u: AccessUser) => u.roleIds.includes('hr_admin')
const canPost = (u: AccessUser) => u.roleIds.some((r) => ['hr_admin', 'payroll_admin'].includes(r))
const audit = (user: AccessUser, action: string, entityId: string, newValue?: any) =>
  prisma.auditLog.create({ data: { tenantId: user.tenantId, userId: user.userId, action, entityType: 'incentive', entityId, newValue } })

async function find(user: AccessUser, id: string) {
  const i = await prisma.incentive.findFirst({ where: { id, tenantId: user.tenantId }, include: { type: true } })
  if (!i) throw new AppError('Incentive not found', 404)
  return i
}

const view = (i: any, people: Map<string, string>) => ({
  id: i.id, employeeId: i.employeeId, employee: people.get(`e:${i.employeeId}`) ?? null, type: i.type?.name, typeId: i.typeId,
  amount: Number(i.amount), currency: i.currency, reason: i.reason, status: i.status,
  nominatedBy: people.get(`u:${i.nominatedByUserId}`) ?? null, nominatedByUserId: i.nominatedByUserId,
  decidedBy: i.decidedByUserId ? people.get(`u:${i.decidedByUserId}`) ?? null : null, decidedAt: i.decidedAt, decisionNote: i.decisionNote,
  payrollCycleId: i.payrollCycleId, postedAt: i.postedAt, createdAt: i.createdAt,
})

async function names(rows: { employeeId: string; nominatedByUserId: string; decidedByUserId: string | null }[]) {
  const [emps, users] = await Promise.all([
    prisma.employee.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.employeeId))] } }, select: { id: true, firstName: true, lastName: true, employeeCode: true } }),
    prisma.user.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => [r.nominatedByUserId, r.decidedByUserId].filter(Boolean) as string[]))] } }, select: { id: true, fullName: true } }),
  ])
  return new Map<string, string>([
    ...emps.map((e) => [`e:${e.id}`, `${e.firstName} ${e.lastName} (${e.employeeCode})`] as [string, string]),
    ...users.map((u) => [`u:${u.id}`, u.fullName] as [string, string]),
  ])
}

export const incentiveService = {
  // The company's incentive types; the defaults are created the first time anyone looks
  async types(user: AccessUser) {
    let rows = await prisma.incentiveType.findMany({ where: { tenantId: user.tenantId }, orderBy: { name: 'asc' } })
    if (!rows.length) {
      const inputs = await prisma.payrollInputType.findMany({ where: { tenantId: user.tenantId, category: 'earnings' }, select: { id: true, code: true } })
      const inputOf = (code: string) => inputs.find((i) => i.code === code)?.id ?? inputs[0]?.id ?? null
      await prisma.incentiveType.createMany({ data: DEFAULT_TYPES.map((t) => ({ tenantId: user.tenantId, code: t.code, name: t.name, description: t.description, payrollInputTypeId: inputOf(t.input) })), skipDuplicates: true })
      rows = await prisma.incentiveType.findMany({ where: { tenantId: user.tenantId }, orderBy: { name: 'asc' } })
    }
    return rows.map((t) => ({ id: t.id, code: t.code, name: t.name, description: t.description, defaultAmount: t.defaultAmount == null ? null : Number(t.defaultAmount), maxAmount: t.maxAmount == null ? null : Number(t.maxAmount), payrollInputTypeId: t.payrollInputTypeId, active: t.active }))
  },

  async saveType(user: AccessUser, id: string | null, body: { name?: string; code?: string; description?: string | null; defaultAmount?: number | null; maxAmount?: number | null; payrollInputTypeId?: string | null; active?: boolean }) {
    if (body.payrollInputTypeId && !(await prisma.payrollInputType.findFirst({ where: { id: body.payrollInputTypeId, tenantId: user.tenantId, category: 'earnings' } }))) {
      throw new AppError('Pick a payroll earning to pay this as', 400)
    }
    if (body.defaultAmount != null && body.maxAmount != null && body.defaultAmount > body.maxAmount) throw new AppError('The default amount is above the cap', 400)
    if (id) {
      const t = await prisma.incentiveType.findFirst({ where: { id, tenantId: user.tenantId } })
      if (!t) throw new AppError('Incentive type not found', 404)
      const { code: _c, ...rest } = body
      const updated = await prisma.incentiveType.update({ where: { id }, data: rest })
      await audit(user, 'INCENTIVE_TYPE_UPDATED', id, rest)
      return updated
    }
    try {
      const created = await prisma.incentiveType.create({ data: { tenantId: user.tenantId, name: body.name!, code: body.code!, description: body.description ?? null, defaultAmount: body.defaultAmount ?? null, maxAmount: body.maxAmount ?? null, payrollInputTypeId: body.payrollInputTypeId ?? null } })
      await audit(user, 'INCENTIVE_TYPE_CREATED', created.id, { name: created.name, code: created.code })
      return created
    } catch (err: any) {
      if (err?.code === 'P2002') throw new AppError('That code is already used', 409)
      throw err
    }
  },

  // HR and payroll see everything; managers what they nominated plus their team's; employees their own awards
  async list(user: AccessUser, filter: { status?: string }) {
    const status = filter.status ? { status: filter.status } : {}
    let where: any = { tenantId: user.tenantId, ...status }
    if (!canPost(user) && !user.roleIds.includes('compliance_officer')) {
      const team = user.roleIds.includes('manager') && user.employeeId ? await getReportingSubtreeIds(user.employeeId, user.tenantId) : []
      where = {
        tenantId: user.tenantId, ...status,
        OR: [
          { nominatedByUserId: user.userId },
          ...(team.length ? [{ employeeId: { in: team } }] : []),
          ...(user.employeeId ? [{ employeeId: user.employeeId, status: { in: ['approved', 'posted'] } }] : []),
        ],
      }
    }
    const rows = await prisma.incentive.findMany({ where, include: { type: true }, orderBy: { createdAt: 'desc' }, take: 500 })
    const people = await names(rows)
    return rows.map((r) => view(r, people))
  },

  async nominate(user: AccessUser, body: { employeeId: string; typeId: string; amount: number; reason: string }) {
    const [emp, type, tenant] = await Promise.all([
      prisma.employee.findFirst({ where: { id: body.employeeId, tenantId: user.tenantId, active: true } }),
      prisma.incentiveType.findFirst({ where: { id: body.typeId, tenantId: user.tenantId, active: true } }),
      prisma.tenant.findUnique({ where: { id: user.tenantId }, select: { baseCurrency: true } }),
    ])
    if (!emp || !type) throw new AppError('Employee or incentive type not found', 404)
    if (emp.id === user.employeeId) throw new AppError('You cannot nominate yourself', 403)
    if (!isHR(user)) {
      const team = user.roleIds.includes('manager') && user.employeeId ? await getReportingSubtreeIds(user.employeeId, user.tenantId) : []
      if (!team.includes(emp.id)) throw new AppError('You can only nominate people in your team', 403)
    }
    if (type.maxAmount != null && body.amount > Number(type.maxAmount)) throw new AppError(`${type.name} is capped at ${Number(type.maxAmount)}`, 400)
    const i = await prisma.incentive.create({ data: { tenantId: user.tenantId, employeeId: emp.id, typeId: type.id, amount: body.amount, currency: tenant?.baseCurrency ?? 'USD', reason: body.reason, nominatedByUserId: user.userId } })
    await audit(user, 'INCENTIVE_NOMINATED', i.id, { employeeId: emp.id, type: type.name, amount: body.amount })
    const hrs = (await userIdsWithRole(user.tenantId, 'hr_admin')).filter((id) => id !== user.userId)
    await notify({ tenantId: user.tenantId, userIds: hrs, type: 'incentive.nominated', title: `${type.name} nomination`, body: `${emp.firstName} ${emp.lastName} · ${body.amount} ${i.currency}`, link: '/incentives', entityType: 'incentive', entityId: i.id })
    return i
  },

  async decide(user: AccessUser, id: string, approve: boolean, note?: string) {
    const i = await find(user, id)
    if (i.status !== 'nominated') throw new AppError(`This incentive is already ${i.status}`, 400)
    if (i.nominatedByUserId === user.userId) throw new AppError('A nomination must be approved by someone other than the person who made it', 403)
    if (i.employeeId === user.employeeId) throw new AppError('You cannot decide on your own incentive', 403)
    if (!approve && !note) throw new AppError('Give a reason for rejecting', 400)
    const done = await prisma.incentive.updateMany({ where: { id, status: 'nominated' }, data: { status: approve ? 'approved' : 'rejected', decidedByUserId: user.userId, decidedAt: new Date(), decisionNote: note ?? null } })
    if (!done.count) throw new AppError('This incentive was just decided by someone else', 409)
    await audit(user, approve ? 'INCENTIVE_APPROVED' : 'INCENTIVE_REJECTED', id, { note: note ?? null })
    const employeeUser = await userIdOfEmployee(user.tenantId, i.employeeId)
    await notify({ tenantId: user.tenantId, userIds: [i.nominatedByUserId], type: 'incentive.decided', title: `${i.type.name} ${approve ? 'approved' : 'rejected'}`, body: note ?? `${Number(i.amount)} ${i.currency}`, link: '/incentives', entityType: 'incentive', entityId: id })
    if (approve && employeeUser) await notify({ tenantId: user.tenantId, userIds: [employeeUser], type: 'incentive.awarded', title: `You received a ${i.type.name.toLowerCase()}`, body: `${Number(i.amount)} ${i.currency} · ${i.reason}`, link: '/incentives', entityType: 'incentive', entityId: id })
    return find(user, id)
  },

  async cancel(user: AccessUser, id: string) {
    const i = await find(user, id)
    if (i.nominatedByUserId !== user.userId && !isHR(user)) throw new AppError('Only the nominator or HR can cancel this', 403)
    if (i.status !== 'nominated') throw new AppError(`This incentive is already ${i.status}`, 400)
    await prisma.incentive.update({ where: { id }, data: { status: 'cancelled' } })
    await audit(user, 'INCENTIVE_CANCELLED', id)
    return { cancelled: true }
  },

  // Approved awards -> payroll inputs in a draft/review run (one input per award)
  async post(user: AccessUser, cycleId: string, ids: string[]) {
    if (!canPost(user)) throw new AppError('Only HR or payroll admins can post incentives to payroll', 403)
    const cycle = await prisma.payrollCycle.findFirst({ where: { id: cycleId, tenantId: user.tenantId } })
    if (!cycle) throw new AppError('Payroll run not found', 404)
    if (!['draft', 'review'].includes(cycle.status)) throw new AppError(`That payroll run is ${cycle.status}; pick one that is still open`, 400)
    const rows = await prisma.incentive.findMany({ where: { id: { in: ids }, tenantId: user.tenantId, status: 'approved' }, include: { type: true } })
    if (rows.length !== new Set(ids).size) throw new AppError('Only approved incentives that have not been posted can be posted', 400)
    const fallback = await prisma.payrollInputType.findFirst({ where: { tenantId: user.tenantId, category: 'earnings', active: true }, orderBy: { createdAt: 'asc' } })
    const posted = []
    for (const i of rows) {
      const inputTypeId = i.type.payrollInputTypeId ?? fallback?.id
      if (!inputTypeId) throw new AppError('Set up a payroll earning type first', 400)
      const claimed = await prisma.incentive.updateMany({ where: { id: i.id, status: 'approved' }, data: { status: 'posted', payrollCycleId: cycle.id, postedAt: new Date() } })
      if (!claimed.count) continue
      const input = await prisma.payrollInput.create({ data: { payrollCycleId: cycle.id, employeeId: i.employeeId, inputTypeId, amount: i.amount, description: `${i.type.name}: ${i.reason}`.slice(0, 250), addedBy: user.userId } })
      await prisma.incentive.update({ where: { id: i.id }, data: { payrollInputId: input.id } })
      await prisma.auditLog.create({ data: { tenantId: user.tenantId, userId: user.userId, action: 'PAYROLL_INPUT_ADDED', entityType: 'payroll_input', entityId: input.id, newValue: { incentiveId: i.id, employeeId: i.employeeId, amount: Number(i.amount) } } })
      await audit(user, 'INCENTIVE_POSTED', i.id, { payrollCycleId: cycle.id, payrollInputId: input.id })
      posted.push(i.id)
    }
    return { posted: posted.length }
  },
}
