import type Anthropic from '@anthropic-ai/sdk'
import { Employee, Payslip, PayrollCycle, HelpdeskTicket, HelpdeskCategory, TsWeek, TsProject, ConfirmationCase, OrgUnit } from '../../infrastructure/mongo/mongo'

// What the assistant can do. Every tool runs as the signed-in person: it only reads what that person could open themselves in the
// app, always filtered by their company, and tools for HR or managers are not even offered to everyone else.
// Writes are never executed here: `propose_helpdesk_ticket` returns a proposal the person confirms in the app.
export type Ctx = { tenantId: string; userId: string; employeeId?: string; roleIds: string[]; features: string[] }
export type Proposal = { type: 'helpdesk_ticket'; categoryId: string; categoryName: string; subject: string; description: string; priority: string }
type Run = (ctx: Ctx, input: any, out: { proposals: Proposal[] }) => Promise<unknown>
type Tool = { def: Anthropic.Tool; run: Run; when: (ctx: Ctx) => boolean }

const STAFF = ['hr_admin', 'system_admin']
const isStaff = (c: Ctx) => c.roleIds.some((r) => STAFF.includes(r))
const day = (d: any) => (d ? new Date(d).toISOString().slice(0, 10) : null)
const nm = (e: any) => (e ? `${e.firstName} ${e.lastName}` : null)
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object' as const, properties, required, additionalProperties: false })

const TOOLS: Tool[] = [
  {
    when: () => true,
    def: { name: 'get_my_profile', description: 'The signed-in person\'s own employee record: name, code, job title, department, manager, hire date, probation and confirmation dates.', input_schema: obj({}) },
    run: async (c) => {
      if (!c.employeeId) return { error: 'This login has no employee record.' }
      const e: any = await Employee.findOne({ _id: c.employeeId, tenantId: c.tenantId }).lean()
      if (!e) return { error: 'Employee record not found.' }
      const [m, u]: any[] = await Promise.all([e.managerId ? Employee.findOne({ _id: e.managerId, tenantId: c.tenantId }).select('firstName lastName').lean() : null, OrgUnit.findOne({ _id: e.orgUnitId, tenantId: c.tenantId }).select('name').lean()])
      return { name: nm(e), code: e.employeeCode, department: u?.name ?? null, manager: nm(m), employmentType: e.employmentType, hireDate: day(e.hireDate), probationEndDate: day(e.probationEndDate), confirmationDate: day(e.confirmationDate), status: e.employmentStatus }
    },
  },
  {
    when: (c) => c.features.includes('payroll'),
    def: { name: 'get_my_payslips', description: 'The signed-in person\'s own released payslips, newest first, with gross, deductions, net pay and the earning and deduction lines. Never anyone else\'s.', input_schema: obj({ limit: { type: 'integer', minimum: 1, maximum: 6, description: 'How many recent payslips (default 3)' } }) },
    run: async (c, i) => {
      if (!c.employeeId) return { error: 'This login has no employee record.' }
      const slips: any[] = await Payslip.find({ tenantId: c.tenantId, employeeId: c.employeeId, withheld: { $ne: true } }).lean()
      const cycles: any[] = await PayrollCycle.find({ tenantId: c.tenantId, _id: { $in: slips.map((s) => s.payrollCycleId) }, payslipsReleasedAt: { $ne: null } }).select('payPeriodStart payPeriodEnd').lean()
      const cm = new Map(cycles.map((x) => [x._id, x]))
      return slips.filter((s) => cm.has(s.payrollCycleId)).sort((a, b) => +new Date(cm.get(b.payrollCycleId).payPeriodStart) - +new Date(cm.get(a.payrollCycleId).payPeriodStart)).slice(0, Math.min(i?.limit ?? 3, 6))
        .map((s) => ({ month: day(cm.get(s.payrollCycleId).payPeriodStart)?.slice(0, 7), currency: s.currency, gross: s.grossEarnings, deductions: s.totalDeductions, net: s.netPay, paidDays: s.paidDays, lines: (s.lines ?? []).map((l: any) => ({ name: l.name ?? l.code, category: l.category, amount: l.amount })) }))
    },
  },
  {
    when: (c) => c.features.includes('helpdesk'),
    def: { name: 'get_my_helpdesk_tickets', description: 'The signed-in person\'s own helpdesk tickets with status and the latest public reply.', input_schema: obj({}) },
    run: async (c) => (await HelpdeskTicket.find({ tenantId: c.tenantId, requesterUserId: c.userId }).sort({ createdAt: -1 }).limit(10).lean() as any[]).map((t) => ({ number: t.number, subject: t.subject, category: t.categoryName, status: t.status, priority: t.priority, raised: day(t.createdAt), lastReply: [...(t.comments ?? [])].reverse().find((x: any) => !x.internal)?.body?.slice(0, 300) ?? null })),
  },
  {
    when: (c) => c.features.includes('helpdesk'),
    def: { name: 'propose_helpdesk_ticket', description: 'Prepare a helpdesk ticket to HR for the person to confirm. Nothing is sent until they press Send in the app, so use this whenever they want to ask HR something or report a problem, then tell them to review and confirm it.', input_schema: obj({ categoryName: { type: 'string', description: 'Best matching category name, e.g. Payroll and payslips, Leave, Attendance, Documents and letters, Policies, IT and assets, Other' }, subject: { type: 'string', maxLength: 140 }, description: { type: 'string', maxLength: 2000 }, priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] } }, ['categoryName', 'subject', 'description']) },
    run: async (c, i, out) => {
      const cats: any[] = await HelpdeskCategory.find({ tenantId: c.tenantId, active: { $ne: false } }).lean()
      const cat = cats.find((x) => x.name.toLowerCase() === String(i.categoryName).toLowerCase()) ?? cats.find((x) => x.name === 'Other') ?? cats[0]
      if (!cat) return { error: 'No helpdesk categories are set up yet. Ask the person to open the Helpdesk page once.' }
      out.proposals.push({ type: 'helpdesk_ticket', categoryId: cat._id, categoryName: cat.name, subject: String(i.subject).slice(0, 140), description: String(i.description).slice(0, 2000), priority: ['low', 'normal', 'high', 'urgent'].includes(i.priority) ? i.priority : 'normal' })
      return { prepared: true, note: 'Shown to the person with a Send button. It has NOT been sent.' }
    },
  },
  {
    when: (c) => c.features.includes('timesheets') && !!c.employeeId,
    def: { name: 'get_my_timesheet_week', description: 'The signed-in person\'s own timesheet for a week (Monday date, default this week): status and hours by project.', input_schema: obj({ weekStart: { type: 'string', description: 'A Monday, YYYY-MM-DD' } }) },
    run: async (c, i) => {
      const d = new Date(); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
      const start = /^\d{4}-\d{2}-\d{2}$/.test(i?.weekStart ?? '') ? i.weekStart : day(d)
      const w: any = await TsWeek.findOne({ tenantId: c.tenantId, employeeId: c.employeeId, weekStart: start }).lean()
      const projects: any[] = await TsProject.find({ tenantId: c.tenantId }).select('code name').lean()
      const pn = new Map(projects.map((p) => [p._id, p.code]))
      const byProject: Record<string, number> = {}
      for (const e of w?.entries ?? []) byProject[pn.get(e.projectId) ?? '?'] = (byProject[pn.get(e.projectId) ?? '?'] ?? 0) + e.hours
      return { weekStart: start, status: w?.status ?? 'not started', hoursByProject: byProject, total: Object.values(byProject).reduce((a, b) => a + b, 0), managerNote: w?.status === 'rejected' ? w.note : null }
    },
  },
  {
    when: (c) => !!c.employeeId && c.roleIds.includes('manager'),
    def: { name: 'get_my_team', description: 'The signed-in manager\'s direct reports: name, code, probation end date.', input_schema: obj({}) },
    run: async (c) => (await Employee.find({ tenantId: c.tenantId, managerId: c.employeeId, active: true }).select('firstName lastName employeeCode probationEndDate confirmationDate').limit(50).lean() as any[]).map((e) => ({ name: nm(e), code: e.employeeCode, probationEndDate: day(e.probationEndDate), confirmed: !!e.confirmationDate })),
  },
  {
    when: isStaff,
    def: { name: 'helpdesk_overview', description: 'HR only: counts of the company\'s helpdesk tickets by status, how many are overdue, and the oldest open ones.', input_schema: obj({}) },
    run: async (c) => {
      const rows: any[] = await HelpdeskTicket.find({ tenantId: c.tenantId, status: { $nin: ['closed'] } }).select('-comments').sort({ createdAt: 1 }).limit(300).lean()
      const by: Record<string, number> = {}
      for (const r of rows) by[r.status] = (by[r.status] ?? 0) + 1
      const now = Date.now()
      const open = rows.filter((r) => !['resolved', 'closed'].includes(r.status))
      return { byStatus: by, overdue: open.filter((r) => r.dueAt && +new Date(r.dueAt) < now).length, oldestOpen: open.slice(0, 5).map((r) => ({ number: r.number, subject: r.subject, status: r.status, raised: day(r.createdAt) })) }
    },
  },
  {
    when: (c) => isStaff(c) && c.features.includes('confirmation'),
    def: { name: 'people_due_for_confirmation', description: 'HR only: people whose probation ends within 90 days (or has passed) and are not confirmed, and open confirmation reviews.', input_schema: obj({}) },
    run: async (c) => {
      const soon = new Date(Date.now() + 90 * 86400000)
      const [due, open]: any[] = await Promise.all([Employee.find({ tenantId: c.tenantId, active: true, confirmationDate: null, probationEndDate: { $ne: null, $lte: soon } }).sort({ probationEndDate: 1 }).limit(30).select('firstName lastName employeeCode probationEndDate').lean(), ConfirmationCase.countDocuments({ tenantId: c.tenantId, status: { $ne: 'closed' } })])
      return { openReviews: open, due: due.map((e: any) => ({ name: nm(e), code: e.employeeCode, probationEnds: day(e.probationEndDate) })) }
    },
  },
  {
    when: isStaff,
    def: { name: 'find_employee', description: 'HR only: look up colleagues by name or employee code; returns name, code, department and manager only (never pay or bank details).', input_schema: obj({ query: { type: 'string', minLength: 2, maxLength: 60 } }, ['query']) },
    run: async (c, i) => {
      const q = String(i.query).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const rows: any[] = await Employee.find({ tenantId: c.tenantId, active: true, $or: [{ firstName: new RegExp(q, 'i') }, { lastName: new RegExp(q, 'i') }, { employeeCode: new RegExp(`^${q}`, 'i') }] }).limit(10).select('firstName lastName employeeCode orgUnitId managerId').lean()
      const units = new Map((await OrgUnit.find({ tenantId: c.tenantId, _id: { $in: rows.map((r) => r.orgUnitId) } }).select('name').lean() as any[]).map((u) => [u._id, u.name]))
      const mgrs = new Map((await Employee.find({ tenantId: c.tenantId, _id: { $in: rows.map((r) => r.managerId).filter(Boolean) } }).select('firstName lastName').lean() as any[]).map((m) => [m._id, nm(m)]))
      return rows.map((r) => ({ name: nm(r), code: r.employeeCode, department: units.get(r.orgUnitId) ?? null, manager: mgrs.get(r.managerId) ?? null }))
    },
  },
]

export const toolsFor = (ctx: Ctx) => TOOLS.filter((t) => t.when(ctx))
export async function runTool(ctx: Ctx, name: string, input: unknown, out: { proposals: Proposal[] }) {
  const t = toolsFor(ctx).find((x) => x.def.name === name) // a tool the person was not offered cannot be called
  if (!t) return { error: `No such tool: ${name}` }
  const text = JSON.stringify(await t.run(ctx, input ?? {}, out))
  return text.length > 6000 ? text.slice(0, 6000) + '…(truncated)' : text
}
