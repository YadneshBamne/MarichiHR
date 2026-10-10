import { prisma } from '../../infrastructure/database/prisma'
import { AppError } from '../../shared/utils/AppError'
import { AccessUser, getReportingSubtreeIds } from '../../shared/utils/access'
import { getTenantTimezone, localTimeString, monthRange, businessToday } from '../../shared/utils/businessDate'
import { holidayMap, holidaysBetween } from '../../shared/utils/holidays'

// Ready-made reports. Each returns summary tiles, one chart (bars), and a table; the router also turns the table
// into CSV. Scope: HR/system admins and compliance see the company; managers see their reporting line for
// attendance and leave; payroll admins see payroll and expenses.

export type Col = { key: string; label: string; type?: 'text' | 'number' | 'money' | 'hours' | 'date' | 'percent' }
export type Report = { title: string; subtitle: string; columns: Col[]; rows: Record<string, unknown>[]; summary: { label: string; value: number | string; type?: Col['type'] }[]; chart: { label: string; bars: { label: string; value: number }[]; type?: Col['type'] }; currency?: string }
export type Filters = { from?: string; to?: string; month?: string; cycleId?: string; departmentId?: string; groupBy?: string }

const COMPANY = ['hr_admin', 'system_admin', 'compliance_officer']
const DAY = 86_400_000
const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null)
const date = (s: string) => new Date(`${s}T00:00:00Z`)
const has = (u: AccessUser, roles: string[]) => u.roleIds.some((r) => roles.includes(r))
const round = (n: number, p = 2) => Math.round(n * 10 ** p) / 10 ** p
const name = (e: { firstName: string; lastName: string }) => `${e.firstName} ${e.lastName === '-' ? '' : e.lastName}`.trim()
const tally = <T,>(items: T[], key: (t: T) => string, val: (t: T) => number = () => 1) => {
  const m = new Map<string, number>()
  for (const t of items) m.set(key(t), (m.get(key(t)) ?? 0) + val(t))
  return [...m].map(([label, value]) => ({ label, value: round(value) })).sort((a, b) => b.value - a.value)
}

// Which employees the viewer may report on for people-level reports (null = whole company)
async function peopleScope(user: AccessUser): Promise<string[] | null> {
  if (has(user, COMPANY)) return null
  if (user.roleIds.includes('manager') && user.employeeId) return getReportingSubtreeIds(user.employeeId, user.tenantId)
  throw new AppError('Not allowed to view this report', 403)
}
const assertRoles = (user: AccessUser, roles: string[]) => { if (!has(user, roles)) throw new AppError('Not allowed to view this report', 403) }

function period(f: Filters, defaultDays = 365) {
  const to = f.to ? date(f.to) : new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()))
  const from = f.from ? date(f.from) : new Date(to.getTime() - defaultDays * DAY)
  if (from > to) throw new AppError('The start date is after the end date', 400)
  return { from, to }
}

export const REPORTS: Record<string, { title: string; description: string; roles: string[]; run: (u: AccessUser, f: Filters) => Promise<Report> }> = {
  headcount: {
    title: 'Headcount', description: 'People on the books by department, office or type, with joiners and leavers', roles: COMPANY,
    async run(user, f) {
      assertRoles(user, COMPANY)
      const { from, to } = period(f)
      const emps = await prisma.employee.findMany({
        where: { tenantId: user.tenantId, ...(f.departmentId && { orgUnitId: f.departmentId }) },
        select: { hireDate: true, exitDate: true, active: true, employmentStatus: true, employmentType: true, orgUnit: { select: { name: true } }, workLocation: { select: { name: true } } },
      })
      const onBooks = (e: (typeof emps)[number], at: Date) => e.hireDate <= at && (!e.exitDate || e.exitDate >= at) && e.employmentStatus !== 'terminated' && (e.active || !!e.exitDate)
      const groupOf = (e: (typeof emps)[number]) => f.groupBy === 'location' ? e.workLocation?.name ?? 'No office' : f.groupBy === 'type' ? e.employmentType.replace('_', ' ') : e.orgUnit?.name ?? 'Unassigned'
      const groups = new Map<string, { group: string; headcount: number; joiners: number; leavers: number }>()
      for (const e of emps) {
        const g = groupOf(e)
        const row = groups.get(g) ?? { group: g, headcount: 0, joiners: 0, leavers: 0 }
        if (onBooks(e, to)) row.headcount++
        if (e.hireDate >= from && e.hireDate <= to) row.joiners++
        if (e.exitDate && e.exitDate >= from && e.exitDate <= to) row.leavers++
        groups.set(g, row)
      }
      const rows = [...groups.values()].filter((r) => r.headcount || r.joiners || r.leavers).sort((a, b) => b.headcount - a.headcount)
      const active = emps.filter((e) => onBooks(e, to))
      const tenure = active.length ? active.reduce((s, e) => s + (to.getTime() - e.hireDate.getTime()) / (365.25 * DAY), 0) / active.length : 0
      const groupLabel = f.groupBy === 'location' ? 'Office' : f.groupBy === 'type' ? 'Employment type' : 'Department'
      return {
        title: 'Headcount', subtitle: `On ${ymd(to)}; joiners and leavers ${ymd(from)} – ${ymd(to)}`,
        columns: [{ key: 'group', label: groupLabel }, { key: 'headcount', label: 'Headcount', type: 'number' }, { key: 'joiners', label: 'Joiners', type: 'number' }, { key: 'leavers', label: 'Leavers', type: 'number' }],
        rows,
        summary: [{ label: 'Headcount', value: active.length, type: 'number' }, { label: 'Joiners', value: rows.reduce((s, r) => s + r.joiners, 0), type: 'number' }, { label: 'Leavers', value: rows.reduce((s, r) => s + r.leavers, 0), type: 'number' }, { label: 'Average tenure (years)', value: round(tenure, 1), type: 'number' }],
        chart: { label: `Headcount by ${groupLabel.toLowerCase()}`, bars: rows.map((r) => ({ label: r.group, value: r.headcount })) },
      }
    },
  },

  attendance: {
    title: 'Attendance', description: 'Days present, half days, absences, leave, hours worked and late arrivals for a month', roles: [...COMPANY, 'manager'],
    async run(user, f) {
      const scope = await peopleScope(user)
      const [y, m] = (f.month ?? new Date().toISOString().slice(0, 7)).split('-').map(Number)
      if (!y || !m || m < 1 || m > 12) throw new AppError('Use month=YYYY-MM', 400)
      const { start, end } = monthRange(y, m)
      const today = await businessToday(user.tenantId)
      const lastDay = end < today ? end : new Date(today.getTime() - DAY)
      const [emps, recs, tz, defaultShift, holidayRows] = await Promise.all([
        prisma.employee.findMany({
          where: { tenantId: user.tenantId, active: true, hireDate: { lte: end }, ...(scope && { id: { in: scope } }), ...(f.departmentId && { orgUnitId: f.departmentId }) },
          select: { id: true, firstName: true, lastName: true, employeeCode: true, hireDate: true, workLocationId: true, taxJurisdiction: true, workLocation: { select: { countryCode: true } }, orgUnit: { select: { name: true } }, employeeShifts: { where: { effectiveFrom: { lte: end }, OR: [{ effectiveUntil: null }, { effectiveUntil: { gte: start } }] }, include: { shiftTemplate: true }, take: 1, orderBy: { effectiveFrom: 'desc' } } },
          orderBy: [{ firstName: 'asc' }],
        }),
        prisma.attendanceRecord.findMany({ where: { employee: { tenantId: user.tenantId }, date: { gte: start, lte: end } }, select: { employeeId: true, status: true, workedHours: true, checkInTime: true } }),
        getTenantTimezone(user.tenantId),
        prisma.shiftTemplate.findFirst({ where: { tenantId: user.tenantId, active: true }, orderBy: { createdAt: 'asc' } }),
        holidaysBetween(user.tenantId, start, end),
      ])
      const byEmp = new Map<string, typeof recs>()
      for (const r of recs) byEmp.set(r.employeeId, [...(byEmp.get(r.employeeId) ?? []), r])
      const rows = emps.map((e) => {
        const shift = e.employeeShifts[0]?.shiftTemplate ?? defaultShift
        const [sh, sm] = (shift?.startTime ?? '09:00').split(':').map(Number)
        const lateAfter = sh * 60 + sm + (shift?.graceLateMinutes ?? 15)
        const holidays = holidayMap(holidayRows, { countryCode: e.workLocation?.countryCode ?? e.taxJurisdiction ?? null, workLocationId: e.workLocationId })
        let working = 0
        for (let d = new Date(Math.max(start.getTime(), e.hireDate.getTime())); d <= lastDay; d = new Date(d.getTime() + DAY)) if (![0, 6].includes(d.getUTCDay()) && !holidays.has(ymd(d)!)) working++
        const list = byEmp.get(e.id) ?? []
        const count = (s: string) => list.filter((r) => r.status === s).length
        const late = list.filter((r) => r.checkInTime && (() => { const [h, mm] = localTimeString(r.checkInTime!, tz).split(':').map(Number); return h * 60 + mm > lateAfter })()).length
        const present = count('present'), half = count('half_day')
        return {
          employee: name(e), code: e.employeeCode, department: e.orgUnit?.name ?? '',
          workingDays: working, present, halfDays: half, absent: count('absent'), onLeave: count('on_leave'),
          hours: round(list.reduce((s, r) => s + (r.workedHours ?? 0), 0), 6), late,
          attendance: working ? round(((present + half * 0.5) / working) * 100, 1) : 0,
        }
      })
      const sum = (k: keyof (typeof rows)[number]) => rows.reduce((s, r) => s + Number(r[k]), 0)
      const totalWorking = sum('workingDays')
      return {
        title: 'Attendance', subtitle: `${new Date(start).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })}${scope ? ' · your team' : ''}`,
        columns: [{ key: 'employee', label: 'Employee' }, { key: 'code', label: 'Code' }, { key: 'department', label: 'Department' }, { key: 'workingDays', label: 'Working days', type: 'number' }, { key: 'present', label: 'Present', type: 'number' }, { key: 'halfDays', label: 'Half days', type: 'number' }, { key: 'absent', label: 'Absent', type: 'number' }, { key: 'onLeave', label: 'On leave', type: 'number' }, { key: 'late', label: 'Late arrivals', type: 'number' }, { key: 'hours', label: 'Hours worked', type: 'hours' }, { key: 'attendance', label: 'Attendance', type: 'percent' }],
        rows,
        summary: [{ label: 'Attendance', value: totalWorking ? round(((sum('present') + sum('halfDays') * 0.5) / totalWorking) * 100, 1) : 0, type: 'percent' }, { label: 'Absent days', value: sum('absent'), type: 'number' }, { label: 'Late arrivals', value: sum('late'), type: 'number' }, { label: 'Hours worked', value: round(sum('hours'), 6), type: 'hours' }],
        chart: { label: 'Days by status', bars: [{ label: 'Present', value: sum('present') }, { label: 'Half day', value: sum('halfDays') }, { label: 'On leave', value: sum('onLeave') }, { label: 'Absent', value: sum('absent') }] },
      }
    },
  },

  leave: {
    title: 'Leave', description: 'Balances by person and leave type, and days taken in a period', roles: [...COMPANY, 'manager'],
    async run(user, f) {
      const scope = await peopleScope(user)
      const { from, to } = period(f, 365)
      const empWhere = { tenantId: user.tenantId, active: true, ...(scope && { id: { in: scope } }), ...(f.departmentId && { orgUnitId: f.departmentId }) }
      const [balances, taken, pending] = await Promise.all([
        prisma.leaveBalance.findMany({ where: { employee: empWhere, leaveType: { active: true } }, include: { employee: { select: { firstName: true, lastName: true, employeeCode: true, orgUnit: { select: { name: true } } } }, leaveType: { select: { name: true } } } }),
        prisma.leaveRequest.findMany({ where: { status: 'approved', employee: empWhere, startDate: { lte: to }, endDate: { gte: from } }, select: { totalDays: true, leaveType: { select: { name: true } } } }),
        prisma.leaveRequest.count({ where: { status: 'pending', employee: empWhere } }),
      ])
      const rows = balances.filter((b) => b.balanceDays || b.usedDays || b.pendingDays).map((b) => ({
        employee: name(b.employee), code: b.employee.employeeCode, department: b.employee.orgUnit?.name ?? '', leaveType: b.leaveType.name,
        allocated: b.balanceDays, used: b.usedDays, pending: b.pendingDays, available: round(b.balanceDays - b.usedDays - b.pendingDays),
      })).sort((a, b) => a.employee.localeCompare(b.employee) || a.leaveType.localeCompare(b.leaveType))
      return {
        title: 'Leave', subtitle: `Balances today; days taken ${ymd(from)} – ${ymd(to)}${scope ? ' · your team' : ''}`,
        columns: [{ key: 'employee', label: 'Employee' }, { key: 'code', label: 'Code' }, { key: 'department', label: 'Department' }, { key: 'leaveType', label: 'Leave type' }, { key: 'allocated', label: 'Allocated', type: 'number' }, { key: 'used', label: 'Used', type: 'number' }, { key: 'pending', label: 'Pending', type: 'number' }, { key: 'available', label: 'Available', type: 'number' }],
        rows,
        summary: [{ label: 'Days taken in period', value: round(taken.reduce((s, t) => s + t.totalDays, 0)), type: 'number' }, { label: 'Requests waiting', value: pending, type: 'number' }, { label: 'Days still available', value: round(rows.reduce((s, r) => s + r.available, 0)), type: 'number' }],
        chart: { label: 'Days taken by leave type', bars: tally(taken, (t) => t.leaveType.name, (t) => t.totalDays) },
      }
    },
  },

  payroll: {
    title: 'Payroll', description: 'Gross, deductions and net pay per person for a payroll cycle', roles: [...COMPANY, 'payroll_admin'],
    async run(user, f) {
      assertRoles(user, [...COMPANY, 'payroll_admin'])
      const cycle = f.cycleId
        ? await prisma.payrollCycle.findFirst({ where: { id: f.cycleId, tenantId: user.tenantId } })
        : await prisma.payrollCycle.findFirst({ where: { tenantId: user.tenantId, status: { notIn: ['draft'] } }, orderBy: { payPeriodStart: 'desc' } })
      if (!cycle) return { title: 'Payroll', subtitle: 'No payroll has been run yet', columns: [], rows: [], summary: [], chart: { label: '', bars: [] } }
      const slips = await prisma.payslip.findMany({
        where: { payrollCycleId: cycle.id, ...(f.departmentId && { employee: { orgUnitId: f.departmentId } }) },
        include: { employee: { select: { firstName: true, lastName: true, employeeCode: true, orgUnit: { select: { name: true } } } } },
      })
      const rows = slips.map((s) => ({ employee: name(s.employee), code: s.employee.employeeCode, department: s.employee.orgUnit?.name ?? '', paidDays: s.paidDays, lwpDays: s.lwpDays, gross: Number(s.grossEarnings), deductions: Number(s.totalDeductions), net: Number(s.netPay) }))
        .sort((a, b) => a.employee.localeCompare(b.employee))
      const total = (k: 'gross' | 'deductions' | 'net') => round(rows.reduce((s, r) => s + r[k], 0))
      return {
        title: 'Payroll', subtitle: `${ymd(cycle.payPeriodStart)} – ${ymd(cycle.payPeriodEnd)} · ${cycle.status}`, currency: slips[0]?.currency,
        columns: [{ key: 'employee', label: 'Employee' }, { key: 'code', label: 'Code' }, { key: 'department', label: 'Department' }, { key: 'paidDays', label: 'Paid days', type: 'number' }, { key: 'lwpDays', label: 'Unpaid days', type: 'number' }, { key: 'gross', label: 'Gross', type: 'money' }, { key: 'deductions', label: 'Deductions', type: 'money' }, { key: 'net', label: 'Net pay', type: 'money' }],
        rows,
        summary: [{ label: 'Employees paid', value: rows.length, type: 'number' }, { label: 'Gross', value: total('gross'), type: 'money' }, { label: 'Deductions', value: total('deductions'), type: 'money' }, { label: 'Net pay', value: total('net'), type: 'money' }],
        chart: { label: 'Net pay by department', type: 'money', bars: tally(rows, (r) => r.department || 'Unassigned', (r) => r.net) },
      }
    },
  },

  expenses: {
    title: 'Expenses', description: 'Claims in a period by category, person and status', roles: [...COMPANY, 'payroll_admin'],
    async run(user, f) {
      assertRoles(user, [...COMPANY, 'payroll_admin'])
      const { from, to } = period(f, 90)
      const claims = await prisma.reimbursementClaim.findMany({
        where: { tenantId: user.tenantId, expenseDate: { gte: from, lte: to }, ...(f.departmentId && { employee: { orgUnitId: f.departmentId } }) },
        include: { employee: { select: { firstName: true, lastName: true, employeeCode: true } }, category: { select: { name: true } } },
        orderBy: { expenseDate: 'desc' },
      })
      const rows = claims.map((c) => ({ date: ymd(c.expenseDate), employee: name(c.employee), code: c.employee.employeeCode, category: c.category.name, description: c.description, amount: Number(c.homeAmount), status: c.status.replace(/_/g, ' ') }))
      const sumIf = (st: string[]) => round(claims.filter((c) => st.includes(c.status)).reduce((s, c) => s + Number(c.homeAmount), 0))
      return {
        title: 'Expenses', subtitle: `${ymd(from)} – ${ymd(to)}`, currency: claims[0]?.homeCurrency,
        columns: [{ key: 'date', label: 'Date', type: 'date' }, { key: 'employee', label: 'Employee' }, { key: 'code', label: 'Code' }, { key: 'category', label: 'Category' }, { key: 'description', label: 'Description' }, { key: 'amount', label: 'Amount', type: 'money' }, { key: 'status', label: 'Status' }],
        rows,
        summary: [{ label: 'Claims', value: rows.length, type: 'number' }, { label: 'Paid', value: sumIf(['paid']), type: 'money' }, { label: 'Approved, not paid', value: sumIf(['manager_approved', 'finance_approved']), type: 'money' }, { label: 'Waiting', value: sumIf(['submitted']), type: 'money' }],
        chart: { label: 'Amount by category (excluding rejected and withdrawn)', type: 'money', bars: tally(claims.filter((c) => !['rejected', 'withdrawn'].includes(c.status)), (c) => c.category.name, (c) => Number(c.homeAmount)) },
      }
    },
  },

  attrition: {
    title: 'Attrition', description: 'Who left, why, and the attrition rate over a period', roles: COMPANY,
    async run(user, f) {
      assertRoles(user, COMPANY)
      const { from, to } = period(f, 365)
      const [exits, emps] = await Promise.all([
        prisma.employeeExit.findMany({
          where: { tenantId: user.tenantId, status: { not: 'cancelled' }, lastWorkingDate: { gte: from, lte: to }, ...(f.departmentId && { employee: { orgUnitId: f.departmentId } }) },
          include: { employee: { select: { firstName: true, lastName: true, employeeCode: true, hireDate: true, orgUnit: { select: { name: true } } } } },
          orderBy: { lastWorkingDate: 'desc' },
        }),
        prisma.employee.findMany({ where: { tenantId: user.tenantId }, select: { hireDate: true, exitDate: true, employmentStatus: true, active: true } }),
      ])
      const headAt = (d: Date) => emps.filter((e) => e.hireDate <= d && (!e.exitDate || e.exitDate >= d) && (e.active || !!e.exitDate)).length
      const avgHead = (headAt(from) + headAt(to)) / 2
      const rows = exits.map((x) => ({ employee: name(x.employee), code: x.employee.employeeCode, department: x.employee.orgUnit?.name ?? '', exitType: x.exitType.replace(/_/g, ' '), reason: x.reason, lastWorkingDay: ymd(x.lastWorkingDate), tenureYears: round((x.lastWorkingDate.getTime() - x.employee.hireDate.getTime()) / (365.25 * DAY), 1) }))
      return {
        title: 'Attrition', subtitle: `${ymd(from)} – ${ymd(to)}`,
        columns: [{ key: 'employee', label: 'Employee' }, { key: 'code', label: 'Code' }, { key: 'department', label: 'Department' }, { key: 'exitType', label: 'Type' }, { key: 'reason', label: 'Reason' }, { key: 'lastWorkingDay', label: 'Last day', type: 'date' }, { key: 'tenureYears', label: 'Tenure (years)', type: 'number' }],
        rows,
        summary: [{ label: 'Leavers', value: rows.length, type: 'number' }, { label: 'Attrition rate', value: avgHead ? round((rows.length / avgHead) * 100, 1) : 0, type: 'percent' }, { label: 'Average tenure of leavers (years)', value: rows.length ? round(rows.reduce((s, r) => s + r.tenureYears, 0) / rows.length, 1) : 0, type: 'number' }],
        chart: { label: 'Leavers by type', bars: tally(rows, (r) => r.exitType) },
      }
    },
  },
}

export const reportCatalog = (user: AccessUser) =>
  Object.entries(REPORTS).filter(([, r]) => has(user, r.roles)).map(([key, r]) => ({ key, title: r.title, description: r.description }))
