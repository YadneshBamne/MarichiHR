import { z } from 'zod'
import { prisma } from '../../infrastructure/database/prisma'
import { notify, userIdsWithRole } from '../../infrastructure/notifications/notify'
import { eventBus } from '../../infrastructure/events/eventBus'
import { AppError } from '../../shared/utils/AppError'
import { AccessUser } from '../../shared/utils/access'
import { businessToday } from '../../shared/utils/businessDate'
import { EMPLOYEE_FIELDS, OPS, RECIPIENTS, TRIGGER, TRIGGERS } from './automation.catalog'

// Automation rules: "when <trigger> and <conditions>, then <actions>". Run by the domain-events worker after the
// built-in handlers; one automation_runs row per rule and event keeps retries from repeating an action.

const Condition = z.object({ field: z.string().max(80), op: z.enum(OPS), value: z.string().max(200).default('') }).strict()
const NotifyAction = z.object({ type: z.literal('notify'), to: z.array(z.enum(RECIPIENTS)).min(1).max(5), title: z.string().trim().min(2).max(120), body: z.string().trim().max(500).default('') }).strict()
const TaskAction = z.object({ type: z.literal('task'), assignTo: z.enum(['employee', 'manager']).or(z.string().uuid()), title: z.string().trim().min(2).max(120), note: z.string().max(500).optional(), dueInDays: z.number().int().min(0).max(365).default(3) }).strict()
export const RuleBody = z.object({
  name: z.string().trim().min(2).max(80),
  trigger: z.string().refine((t) => !!TRIGGER[t], 'Unknown trigger'),
  conditions: z.array(Condition).max(10).default([]),
  actions: z.array(z.discriminatedUnion('type', [NotifyAction, TaskAction])).min(1).max(5),
  active: z.boolean().default(true),
}).strict()
export type RuleInput = z.infer<typeof RuleBody>

const ADMINS = ['hr_admin', 'system_admin']
const assertAdmin = (u: AccessUser) => { if (!u.roleIds.some((r) => ADMINS.includes(r))) throw new AppError('Only HR or system admins manage automation', 403) }
const ymd = (d: unknown) => (d instanceof Date ? d.toISOString() : String(d ?? '')).slice(0, 10)

// The fields a rule on this trigger may use
export const fieldsOf = (trigger: string) => [...TRIGGER[trigger].fields, ...(TRIGGER[trigger].person ? EMPLOYEE_FIELDS : [])]

function checkRule(r: RuleInput) {
  const allowed = new Map(fieldsOf(r.trigger).map((f) => [f.key, f]))
  for (const c of r.conditions) {
    const f = allowed.get(c.field)
    if (!f) throw new AppError(`"${c.field}" is not available for this trigger`, 400)
    if (['gt', 'gte', 'lt', 'lte'].includes(c.op) && f.type === 'text') throw new AppError(`"${f.label}" is text; use equals, in or contains`, 400)
    if (['gt', 'gte', 'lt', 'lte'].includes(c.op) && f.type === 'number' && !Number.isFinite(Number(c.value))) throw new AppError(`"${f.label}" needs a number`, 400)
  }
  if (!TRIGGER[r.trigger].person && r.actions.some((a) => (a.type === 'notify' && a.to.some((t) => t === 'employee' || t === 'manager')) || (a.type === 'task' && (a.assignTo === 'employee' || a.assignTo === 'manager')))) {
    throw new AppError('This trigger is not about one person, so it cannot notify or assign "the employee" or "their manager"', 400)
  }
}

// ─── Evaluation (pure) ────────────────────────────────────────
export type Ctx = Record<string, unknown>
export function matches(conditions: z.infer<typeof Condition>[], ctx: Ctx, types: Map<string, string>): boolean {
  return conditions.every((c) => {
    const raw = ctx[c.field]
    const v = raw == null ? '' : String(raw)
    const want = c.value.trim()
    const n = (x: string) => (types.get(c.field) === 'date' ? Date.parse(x.slice(0, 10)) : Number(x))
    switch (c.op) {
      case 'set': return v !== ''
      case 'not_set': return v === ''
      case 'eq': return v.toLowerCase() === want.toLowerCase()
      case 'neq': return v.toLowerCase() !== want.toLowerCase()
      case 'in': return want.split(',').map((s) => s.trim().toLowerCase()).includes(v.toLowerCase())
      case 'contains': return v.toLowerCase().includes(want.toLowerCase())
      default: {
        if (v === '' || Number.isNaN(n(v)) || Number.isNaN(n(want))) return false
        const [a, b] = [n(v), n(want)]
        return c.op === 'gt' ? a > b : c.op === 'gte' ? a >= b : c.op === 'lt' ? a < b : a <= b
      }
    }
  })
}
// {{field}} placeholders; unknown fields become empty. Plain text, never evaluated.
export const fill = (template: string, ctx: Ctx) => template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => { const v = ctx[k]; return v == null ? '' : v instanceof Date ? ymd(v) : String(v) })

// Event payload + the person it is about
async function contextFor(e: { tenantId: string; eventType: string; payload: any }): Promise<{ ctx: Ctx; emp: { id: string; userId: string; managerId: string | null } | null }> {
  const ctx: Ctx = {}
  for (const [k, v] of Object.entries(e.payload ?? {})) ctx[k] = Array.isArray(v) ? v.join(', ') : v
  if (!TRIGGER[e.eventType]?.person || !e.payload?.employeeId) return { ctx, emp: null }
  const emp = await prisma.employee.findFirst({
    where: { id: e.payload.employeeId, tenantId: e.tenantId },
    select: { id: true, userId: true, managerId: true, employeeCode: true, firstName: true, lastName: true, employmentType: true, taxJurisdiction: true, hireDate: true, orgUnit: { select: { name: true } }, workLocation: { select: { name: true } }, manager: { select: { firstName: true, lastName: true } } },
  })
  if (!emp) return { ctx, emp: null }
  const type = emp.employmentType ? (await prisma.masterValue.findFirst({ where: { tenantId: e.tenantId, list: 'employment_type', code: emp.employmentType }, select: { label: true } }))?.label ?? emp.employmentType : null
  Object.assign(ctx, {
    'employee.name': `${emp.firstName} ${emp.lastName}`.trim(), 'employee.employeeCode': emp.employeeCode, 'employee.department': emp.orgUnit?.name ?? null,
    'employee.workLocation': emp.workLocation?.name ?? null, 'employee.employmentType': type, 'employee.taxCountry': emp.taxJurisdiction,
    'employee.manager': emp.manager ? `${emp.manager.firstName} ${emp.manager.lastName}` : null, 'employee.hireDate': ymd(emp.hireDate),
  })
  return { ctx, emp: { id: emp.id, userId: emp.userId, managerId: emp.managerId } }
}

// ─── Running rules for an event (called by dispatchEvent) ─────
export async function runAutomations(e: { id: string; tenantId: string; eventType: string; payload: any }) {
  if (!TRIGGER[e.eventType]) return
  const rules = await prisma.automationRule.findMany({ where: { tenantId: e.tenantId, trigger: e.eventType, active: true } })
  if (!rules.length) return
  const done = new Set((await prisma.automationRun.findMany({ where: { eventId: e.id, ruleId: { in: rules.map((r) => r.id) }, status: { in: ['done', 'skipped'] } }, select: { ruleId: true } })).map((r) => r.ruleId))
  const { ctx, emp } = await contextFor(e)
  const types = new Map(fieldsOf(e.eventType).map((f) => [f.key, f.type]))
  const link = TRIGGER[e.eventType].link?.(e.payload)
  for (const rule of rules) {
    if (done.has(rule.id)) continue
    let status = 'done', detail: string | null = null
    try {
      if (!matches(rule.conditions as any, ctx, types)) { status = 'skipped'; detail = 'Conditions not met' }
      else {
        const out: string[] = []
        for (const a of rule.actions as any[]) {
          if (a.type === 'notify') {
            const managerUser = emp?.managerId ? (await prisma.employee.findFirst({ where: { id: emp.managerId, tenantId: e.tenantId }, select: { userId: true } }))?.userId : null
            const userIds = (await Promise.all(a.to.map(async (t: string) => (t === 'employee' ? [emp?.userId] : t === 'manager' ? [managerUser] : userIdsWithRole(e.tenantId, t))))).flat().filter(Boolean) as string[]
            const sent = await notify({ tenantId: e.tenantId, userIds, type: `automation:${rule.id}`, title: fill(a.title, ctx), body: fill(a.body ?? '', ctx), link, eventId: e.id })
            out.push(`notified ${sent.length}`)
          } else if (a.type === 'task') {
            const assignee = a.assignTo === 'employee' ? emp?.id : a.assignTo === 'manager' ? emp?.managerId : (await prisma.employee.findFirst({ where: { id: a.assignTo, tenantId: e.tenantId, active: true }, select: { id: true } }))?.id
            if (!assignee) { out.push('task skipped: nobody to assign'); continue }
            const type = await prisma.activityType.findFirst({ where: { tenantId: e.tenantId }, orderBy: { name: 'asc' }, select: { id: true } })
            if (!type) { out.push('task skipped: no activity types'); continue }
            const today = await businessToday(e.tenantId)
            await prisma.activity.create({ data: { tenantId: e.tenantId, activityTypeId: type.id, entityType: 'employee', entityId: emp?.id ?? assignee, title: fill(a.title, ctx), note: a.note ? fill(a.note, ctx) : null, assignedToId: assignee, createdBy: rule.createdBy, dueDate: new Date(today.getTime() + a.dueInDays * 86_400_000) } })
            out.push('task created')
          }
        }
        detail = out.join('; ')
      }
    } catch (err: any) {
      status = 'failed'; detail = String(err?.message ?? err).slice(0, 300)
    }
    await prisma.automationRun.upsert({ where: { ruleId_eventId: { ruleId: rule.id, eventId: e.id } }, create: { tenantId: e.tenantId, ruleId: rule.id, eventId: e.id, status, detail }, update: { status, detail } })
    if (status === 'done') await prisma.automationRule.update({ where: { id: rule.id }, data: { runCount: { increment: 1 }, lastRunAt: new Date() } })
  }
}

// ─── Daily people dates: birthdays, work anniversaries, probation ending ─
// Published only when a rule or webhook listens, once per person per day (the key is checked before publishing).
export async function publishPeopleDates(tenantId: string) {
  const types = ['employee.birthday', 'employee.work_anniversary', 'employee.probation.ending']
  const [rules, hooks] = await Promise.all([
    prisma.automationRule.findMany({ where: { tenantId, active: true, trigger: { in: types } }, select: { trigger: true } }),
    prisma.webhook.findMany({ where: { tenantId, active: true, events: { hasSome: types } }, select: { events: true } }),
  ])
  const wanted = new Set([...rules.map((r) => r.trigger), ...hooks.flatMap((h) => h.events)])
  if (![...wanted].some((t) => types.includes(t))) return 0
  const today = await businessToday(tenantId)
  const t = ymd(today)
  const md = t.slice(5)
  const leap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
  const sameDay = (d: Date) => { const x = ymd(d).slice(5); return x === md || (x === '02-29' && md === '02-28' && !leap(today.getUTCFullYear())) }
  const in7 = ymd(new Date(today.getTime() + 7 * 86_400_000))
  const people = await prisma.employee.findMany({ where: { tenantId, active: true, employmentStatus: { not: 'terminated' } }, select: { id: true, dateOfBirth: true, hireDate: true, probationEndDate: true } })
  const out: [string, Record<string, unknown>][] = []
  for (const p of people) {
    if (wanted.has('employee.birthday') && p.dateOfBirth && sameDay(p.dateOfBirth)) out.push(['employee.birthday', { employeeId: p.id, date: t }])
    const years = today.getUTCFullYear() - p.hireDate.getUTCFullYear()
    if (wanted.has('employee.work_anniversary') && years >= 1 && sameDay(p.hireDate)) out.push(['employee.work_anniversary', { employeeId: p.id, years, date: t }])
    const pe = p.probationEndDate && ymd(p.probationEndDate)
    if (wanted.has('employee.probation.ending') && (pe === t || pe === in7)) out.push(['employee.probation.ending', { employeeId: p.id, probationEndDate: pe, daysRemaining: pe === t ? 0 : 7, date: t }])
  }
  let published = 0
  for (const [type, payload] of out) {
    const key = `${type}:${payload.employeeId}:${t}`
    const exists = await prisma.domainEvent.findFirst({ where: { tenantId, eventType: type, payload: { path: ['key'], equals: key } }, select: { id: true } })
    if (exists) continue
    await eventBus.publish(tenantId, type, { ...payload, key })
    published++
  }
  return published
}

// ─── Admin API ────────────────────────────────────────────────
export const automationService = {
  catalog(user: AccessUser) {
    assertAdmin(user)
    return { triggers: TRIGGERS.map((t) => ({ key: t.key, label: t.label, group: t.group, person: t.person, fields: fieldsOf(t.key) })), ops: OPS, recipients: RECIPIENTS }
  },
  async list(user: AccessUser) {
    assertAdmin(user)
    return prisma.automationRule.findMany({ where: { tenantId: user.tenantId }, orderBy: [{ active: 'desc' }, { name: 'asc' }] })
  },
  async save(user: AccessUser, body: RuleInput, id?: string) {
    assertAdmin(user)
    checkRule(body)
    for (const a of body.actions) if (a.type === 'task' && !['employee', 'manager'].includes(a.assignTo) && !(await prisma.employee.findFirst({ where: { id: a.assignTo, tenantId: user.tenantId, active: true }, select: { id: true } }))) throw new AppError('The person to assign the task to was not found', 404)
    const data = { name: body.name, trigger: body.trigger, conditions: body.conditions, actions: body.actions, active: body.active }
    if (id) {
      const res = await prisma.automationRule.updateMany({ where: { id, tenantId: user.tenantId }, data })
      if (!res.count) throw new AppError('Rule not found', 404)
      await prisma.auditLog.create({ data: { tenantId: user.tenantId, userId: user.userId, action: 'AUTOMATION_RULE_UPDATED', entityType: 'automation_rule', entityId: id, newValue: data as any } })
      return prisma.automationRule.findFirst({ where: { id, tenantId: user.tenantId } })
    }
    const rule = await prisma.automationRule.create({ data: { ...data, tenantId: user.tenantId, createdBy: user.userId } })
    await prisma.auditLog.create({ data: { tenantId: user.tenantId, userId: user.userId, action: 'AUTOMATION_RULE_CREATED', entityType: 'automation_rule', entityId: rule.id, newValue: data as any } })
    return rule
  },
  async runs(user: AccessUser, ruleId?: string) {
    assertAdmin(user)
    const runs = await prisma.automationRun.findMany({ where: { tenantId: user.tenantId, ...(ruleId && { ruleId }) }, orderBy: { createdAt: 'desc' }, take: 100 })
    const events = new Map((await prisma.domainEvent.findMany({ where: { id: { in: runs.map((r) => r.eventId) }, tenantId: user.tenantId }, select: { id: true, eventType: true, createdAt: true } })).map((e) => [e.id, e]))
    return runs.map((r) => ({ ...r, eventType: events.get(r.eventId)?.eventType ?? null }))
  },
  // Dry run against a recent real event of this trigger: would the conditions match, and what would the message say?
  async test(user: AccessUser, body: RuleInput) {
    assertAdmin(user)
    checkRule(body)
    const e = await prisma.domainEvent.findFirst({ where: { tenantId: user.tenantId, eventType: body.trigger }, orderBy: { createdAt: 'desc' } })
    if (!e) return { event: null, message: 'No event of this kind has happened yet in your company, so there is nothing to test against.' }
    const { ctx } = await contextFor(e)
    const ok = matches(body.conditions, ctx, new Map(fieldsOf(body.trigger).map((f) => [f.key, f.type])))
    return { event: { id: e.id, at: e.createdAt }, matches: ok, context: ctx, preview: body.actions.map((a) => (a.type === 'notify' ? { type: a.type, to: a.to, title: fill(a.title, ctx), body: fill(a.body, ctx) } : { type: a.type, title: fill(a.title, ctx) })) }
  },
}
