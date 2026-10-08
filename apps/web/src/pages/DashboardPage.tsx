import { useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import api from '../lib/api'
import { useAuth } from '../contexts/AuthContext'
import { useReveal, useCountUp, gsap, reduced } from '../lib/motion'
import { primaryRole } from '../components/AppShell'
import { TimeTracker, TasksCard, CardHead } from '../components/dashboard/Widgets'
import Icon, { type IconName } from '../components/ui/Icon'
import { fmtHours } from '../lib/format'
import Avatar from '../components/ui/Avatar'
import Badge from '../components/ui/Badge'

// Role-based home. The API decides which sections exist for this person (self / team / company / payroll);
// this page lays them out on a 12-column grid so every row lines up, whatever the role.
export { TimeTracker } from '../components/dashboard/Widgets'

const utc = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00Z`)
const fmt = (s: string, o: Intl.DateTimeFormatOptions) => utc(s).toLocaleDateString(undefined, { timeZone: 'UTC', ...o })
const STAGE: Record<string, string> = { draft: 'Draft', processing: 'Calculating', review: 'HR review', approved: 'HR approved', finance_approved: 'Finance approved', disbursed: 'Paid' }
const STAGES = ['draft', 'processing', 'review', 'approved', 'finance_approved', 'disbursed']

function greeting() {
  const h = new Date().getHours()
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
}

export default function DashboardPage() {
  const { user } = useAuth()
  const roles = user?.roles?.map((r) => r.name) ?? []
  const role = primaryRole(roles)
  const { data: d, isLoading } = useQuery({ queryKey: ['dashboard'], queryFn: async () => (await api.get('/dashboard')).data.data, staleTime: 30_000 })
  const ref = useReveal<HTMLDivElement>(!!d)
  const first = user?.employee?.firstName || user?.fullName?.split(' ')[0]
  const has = (a: string) => d?.apps?.includes(a)

  // Quick actions only for things this person can actually do
  const actions: [string, IconName, string][] = [
    ...(d?.self && has('leave') ? [['/leave', 'leaf', 'Apply for leave'] as [string, IconName, string]] : []),
    ...(d?.self && has('expenses') ? [['/expenses', 'receipt', 'New expense claim'] as [string, IconName, string]] : []),
    ...(d?.team?.approvals?.total ? [['/approvals', 'checkCircle', `Review approvals (${d.team.approvals.total})`] as [string, IconName, string]] : []),
    ...(d?.company ? [['/employees', 'plus', 'Add employee'] as [string, IconName, string]] : []),
    ...(d?.payroll?.current && d.payroll.current.status !== 'disbursed' ? [[`/payroll/cycles/${d.payroll.current.id}`, 'wallet', 'Open payroll cycle'] as [string, IconName, string]] : []),
  ]

  return (
    <div ref={ref}>
      <header data-rise style={{ display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap', marginBottom: 18 }}>
        <div style={{ flex: '1 1 320px' }}>
          <div className="dim" style={{ fontSize: 13 }}>{new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</div>
          <h1 style={{ fontSize: 'clamp(30px, 3.6vw, 44px)', lineHeight: 1.05, marginTop: 2 }}>{greeting()}, {first}</h1>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} data-tour="quick-actions">
          {actions.slice(0, 3).map(([to, ic, label], i) => <Link key={to} to={to} className={`btn ${i === 0 ? 'btn-primary' : 'btn-ghost'}`}><Icon name={ic} size={15} /> {label}</Link>)}
        </div>
      </header>

      {isLoading || !d ? <Skeleton /> : (
        <>
          <Kpis d={d} role={role} />
          {role === 'payroll_admin' || role === 'compliance_officer' ? <PayrollRows d={d} /> : null}
          {d.team && <TeamRows d={d} />}
          {d.company && <CompanyRows d={d} />}
          {d.self && <SelfRows d={d} />}
          {d.payroll && role !== 'payroll_admin' && role !== 'compliance_officer' && <PayrollRows d={d} />}
          {!d.self && !d.team && !d.payroll && !d.company && (
            <section className="card" style={{ padding: 40, textAlign: 'center' }}><div className="display" style={{ fontSize: 22 }}>Nothing to show yet</div><p className="dim" style={{ marginTop: 6 }}>Your administrator hasn't linked an employee record or role to your account.</p></section>
          )}
        </>
      )}
    </div>
  )
}

// ─── KPI tiles: always four, always the same height ──────────────────────────
function Kpis({ d, role }: { d: any; role: string }) {
  const s = d.self, t = d.team, c = d.company, p = d.payroll
  const has = (a: string) => d.apps.includes(a)
  const leaveLeft = s?.leave?.balances?.reduce((a: number, b: any) => a + b.available, 0) ?? 0
  const att = s?.attendance?.month
  const tiles: { label: string; value: number; suffix?: string; icon: IconName; to?: string; tone?: 'honey' | 'night'; format?: (v: number) => string }[] = []
  if (role === 'system_admin' || role === 'hr_admin') {
    tiles.push({ label: 'Employees', value: c?.headcount ?? 0, icon: 'users', to: '/employees', tone: 'night' })
    if (t?.today) tiles.push({ label: 'In today', value: t.today.in, suffix: `/ ${t.size}`, icon: 'clock', to: '/attendance' })
    tiles.push({ label: 'Approvals waiting', value: t?.approvals?.total ?? 0, icon: 'checkCircle', to: '/approvals', tone: 'honey' })
    tiles.push({ label: 'Joined this month', value: c?.joiners ?? 0, icon: 'sparkle' })
    if (!t?.today && has('exits')) tiles.push({ label: 'Exits in progress', value: c?.exitsOpen ?? 0, icon: 'door', to: '/exits' })
  } else if (role === 'payroll_admin' || role === 'compliance_officer') {
    tiles.push({ label: 'Open payroll cycles', value: p?.openCycles ?? 0, icon: 'wallet', to: '/payroll', tone: 'night' })
    tiles.push({ label: 'Payslips in current cycle', value: p?.current?.payslips ?? 0, icon: 'file', to: p?.current ? `/payroll/cycles/${p.current.id}` : '/payroll' })
    tiles.push({ label: 'Expenses to finance-approve', value: p?.expensesAwaitingFinance ?? 0, icon: 'receipt', to: '/expenses', tone: 'honey' })
    tiles.push({ label: 'Payroll inputs to approve', value: p?.inputsToApprove ?? 0, icon: 'checkCircle' })
  } else if (role === 'manager') {
    tiles.push({ label: 'Team members', value: t?.size ?? 0, icon: 'users', to: '/employees', tone: 'night' })
    if (t?.today) tiles.push({ label: 'Team in today', value: t.today.in, suffix: `/ ${t.size}`, icon: 'clock', to: '/attendance' })
    tiles.push({ label: 'Approvals waiting', value: t?.approvals?.total ?? 0, icon: 'checkCircle', to: '/approvals', tone: 'honey' })
    if (has('leave')) tiles.push({ label: 'My leave days left', value: Math.round(leaveLeft * 10) / 10, icon: 'leaf', to: '/leave' })
  } else {
    if (has('leave')) tiles.push({ label: 'Leave days left', value: Math.round(leaveLeft * 10) / 10, icon: 'leaf', to: '/leave', tone: 'night' })
    if (att) tiles.push({ label: 'Days present this month', value: att.present, suffix: `/ ${att.workingDays}`, icon: 'calendar', to: '/attendance' })
    if (att) tiles.push({ label: 'Hours this month', value: att.hours, format: fmtHours, icon: 'clock', to: '/attendance' })
    tiles.push({ label: 'Open tasks', value: s?.tasks?.open ?? 0, icon: 'list', to: '/activities', tone: 'honey' })
    if (s?.payslip && tiles.length < 4) tiles.push({ label: `Net pay · ${fmt(s.payslip.start, { month: 'short' })}`, value: s.payslip.net, icon: 'wallet', to: `/payroll/payslips/${s.payslip.id}` })
  }
  return (
    <div className="dgrid" data-tour="kpis" style={{ marginBottom: 'var(--gap)' }}>
      {tiles.slice(0, 4).map((k) => <Kpi key={k.label} {...k} />)}
    </div>
  )
}

function Kpi({ label, value, suffix, icon, to, tone, format }: { label: string; value: number; suffix?: string; icon: IconName; to?: string; tone?: 'honey' | 'night'; format?: (v: number) => string }) {
  const n = useCountUp(value, format ?? ((v) => (Number.isInteger(value) ? Math.round(v).toLocaleString() : v.toFixed(1))))
  const bg = tone === 'night' ? 'var(--night)' : tone === 'honey' ? 'var(--honey)' : undefined
  const fg = tone === 'night' ? 'var(--night-ink)' : 'var(--ink)'
  const body = (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <span style={{ fontSize: 13, color: tone === 'night' ? 'var(--night-dim)' : tone === 'honey' ? 'var(--honey-ink)' : 'var(--dim)' }}>{label}</span>
        <span style={{ width: 34, height: 34, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: tone === 'night' ? 'var(--night-2)' : tone === 'honey' ? 'rgba(255,255,255,.35)' : 'var(--well)' }}><Icon name={icon} size={16} /></span>
      </div>
      <div style={{ marginTop: 18, display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span className="display num" style={{ fontSize: 44, lineHeight: 1 }}><span ref={n}>0</span></span>
        {suffix && <span style={{ fontSize: 14, opacity: 0.6 }}>{suffix}</span>}
      </div>
    </>
  )
  const style = { padding: 20, background: bg, color: fg, display: 'block', minHeight: 132 } as const
  return to ? <Link to={to} data-card className="card lift span-3" style={style}>{body}</Link> : <div data-card className="card span-3" style={style}>{body}</div>
}

// ─── Manager / HR: team today + approvals, team leave this week ──────────────
function TeamRows({ d }: { d: any }) {
  const t = d.team
  const scopeLabel = t.scope === 'company' ? 'Company' : 'Team'
  return (
    <div className="dgrid row">
      <section data-card className="card span-8" style={{ padding: 22 }}>
        <CardHead title={`${scopeLabel} today`} to={t.scope === 'company' ? '/employees' : '/employees'} />
        {t.today && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 8, marginTop: 14 }}>
            {([['In', t.today.in, 'honey'], ['On leave', t.today.onLeave, 'night'], ['Not in yet', t.today.notIn, 'outline'], ['Absent', t.today.absent, 'stripes']] as [string, number, string][]).map(([l, v, k]) => (
              <div key={l}><div className="dim" style={{ fontSize: 12, marginBottom: 5 }}>{l}</div><div className={`seg ${k}`} style={k === 'stripes' ? { backgroundSize: '22px 22px' } : undefined}><span className="num">{v}</span></div></div>
            ))}
          </div>
        )}
        {t.people.length === 0 ? <Empty icon="users" text={t.scope === 'company' ? 'No employees yet. Add your first people from Employees.' : 'Nobody reports to you yet.'} /> : (
          <ul style={{ listStyle: 'none', marginTop: 16, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
            {t.people.map((p: any) => (
              <li key={p.id}>
                <Link to={`/employees/${p.id}`} className="well" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px' }}>
                  <Avatar name={p.name} src={p.avatarUrl} size={32} />
                  <span style={{ flex: 1, minWidth: 0 }}><span style={{ display: 'block', fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span><span className="muted" style={{ fontSize: 11 }}>{p.title ?? '—'}</span></span>
                  <StatusDot s={p.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section data-card className="card span-4" style={{ padding: 22, display: 'flex', flexDirection: 'column' }} data-tour="approvals-card">
        <CardHead title="Approvals" to="/approvals" />
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
          {t.approvals.leave > 0 && <span className="pill honey" style={{ textTransform: 'none' }}>{t.approvals.leave} leave</span>}
          {t.approvals.attendance > 0 && <span className="pill info" style={{ textTransform: 'none' }}>{t.approvals.attendance} attendance</span>}
          {t.approvals.expenses > 0 && <span className="pill warn" style={{ textTransform: 'none' }}>{t.approvals.expenses} expenses</span>}
          {t.approvals.finance > 0 && <span className="pill night" style={{ textTransform: 'none' }}>{t.approvals.finance} finance</span>}
        </div>
        {t.approvals.total === 0 ? <Empty icon="checkCircle" text="You're all caught up." /> : t.approvals.items.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12, flex: 1 }}>
            {t.approvals.expenses > 0 && <TodoLine n={t.approvals.expenses} label="expense claims to approve" to="/expenses" />}
            {t.approvals.finance > 0 && <TodoLine n={t.approvals.finance} label="claims awaiting finance approval" to="/expenses" />}
            {t.approvals.signoffs > 0 && <TodoLine n={t.approvals.signoffs} label="exit clearances to sign off" to="/exits" />}
          </div>
        ) : (
          <ul style={{ listStyle: 'none', marginTop: 12, flex: 1 }}>
            {t.approvals.items.map((a: any) => (
              <li key={a.kind + a.id} style={{ borderTop: '1px solid var(--line)' }}>
                <Link to={a.link} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '10px 0' }}>
                  <Avatar name={a.who} size={30} />
                  <span style={{ flex: 1, minWidth: 0 }}><span style={{ display: 'block', fontSize: 13, fontWeight: 500 }}>{a.who}</span><span className="dim" style={{ fontSize: 12 }}>{a.title} · {a.detail}</span></span>
                  <Icon name="chevronRight" size={15} className="muted" />
                </Link>
              </li>
            ))}
          </ul>
        )}
        {t.approvals.total > 0 && <Link to="/approvals" className="btn btn-primary btn-sm" style={{ marginTop: 12 }}>Open approvals inbox</Link>}
      </section>

      {d.apps.includes('leave') && <WeekLeave week={t.week} label={scopeLabel} />}
    </div>
  )
}

function WeekLeave({ week, label }: { week: any; label: string }) {
  const days = Array.from({ length: 5 }, (_, i) => new Date(utc(week.start).getTime() + i * 86400000).toISOString().slice(0, 10))
  const today = new Date().toISOString().slice(0, 10)
  const grid = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (grid.current && !reduced()) gsap.fromTo(grid.current.querySelectorAll('[data-ev]'), { opacity: 0, y: 12, scale: 0.95 }, { opacity: 1, y: 0, scale: 1, duration: 0.55, stagger: 0.05, delay: 0.2, ease: 'back.out(1.6)', clearProps: 'opacity,transform' })
  }, [week.start])
  return (
    <section data-card className="card span-12" style={{ padding: 22 }} data-tour="week">
      <CardHead title={`${label} leave this week`} to="/leave" />
      <div ref={grid} style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0,1fr))', gap: 8, marginTop: 14 }}>
        {days.map((day) => {
          const on = week.leave.filter((l: any) => l.start <= day && l.end >= day)
          return (
            <div key={day} style={{ borderLeft: '1px solid var(--line)', paddingLeft: 8, minHeight: 96 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                <span className="display num" style={{ fontSize: 16, width: 30, height: 30, lineHeight: '30px', textAlign: 'center', borderRadius: '50%', background: day === today ? 'var(--night)' : 'transparent', color: day === today ? 'var(--night-ink)' : 'var(--dim)' }}>{utc(day).getUTCDate()}</span>
                <span className="dim" style={{ fontSize: 12 }}>{fmt(day, { weekday: 'short' })}</span>
              </div>
              {on.length === 0 && <div className="muted" style={{ fontSize: 11 }}>Everyone in</div>}
              {on.map((l: any) => <div key={l.id + day} data-ev title={`${l.name} · ${l.type}`} style={{ background: 'var(--honey-2)', borderRadius: 10, padding: '5px 8px', marginBottom: 5, fontSize: 11.5, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}><strong style={{ fontWeight: 600 }}>{l.name.split(' ')[0]}</strong> · {l.type}</div>)}
            </div>
          )
        })}
      </div>
    </section>
  )
}

// ─── HR / admin: company snapshot ───────────────────────────────────────────
function CompanyRows({ d }: { d: any }) {
  const c = d.company
  const max = Math.max(1, ...c.departments.map((x: any) => x.count))
  const checklist: [boolean, string, string, string][] = [
    [c.headcount > 1, 'Add your employees', `${c.headcount} on the books`, '/employees'],
    [c.noLogin === 0, 'Give everyone a login', c.noLogin ? `${c.noLogin} without a login yet` : 'Everyone can sign in', '/employees'],
    [d.apps.length > 0, 'Choose your apps', `${d.apps.length} installed`, '/settings/apps'],
    [true, 'Company profile', 'Name, logo, country, currency', '/settings/company'],
  ]
  return (
    <div className="dgrid row">
      <section data-card className="card span-6" style={{ padding: 22 }}>
        <CardHead title="Headcount by department" to="/employees" />
        {c.departments.length === 0 ? <Empty icon="layers" text="No departments with people yet." /> : (
          <ul style={{ listStyle: 'none', marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {c.departments.map((dep: any) => (
              <li key={dep.name}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}><span>{dep.name}</span><span className="num dim">{dep.count}</span></div>
                <div style={{ height: 8, borderRadius: 4, background: 'var(--well)', marginTop: 5, overflow: 'hidden' }}><span style={{ display: 'block', height: '100%', width: `${(dep.count / max) * 100}%`, background: 'var(--night)', borderRadius: 4, transition: 'width 1s var(--ease)' }} /></div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section data-card className="card span-6" style={{ padding: 22 }}>
        <CardHead title="Workspace setup" to="/settings" />
        <ul style={{ listStyle: 'none', marginTop: 12 }}>
          {checklist.map(([done, title, sub, to]) => (
            <li key={title} style={{ borderTop: '1px solid var(--line)' }}>
              <Link to={to} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 0' }}>
                <span style={{ width: 26, height: 26, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: done ? 'var(--honey)' : 'transparent', border: done ? 'none' : '1.5px solid var(--line-2)' }}>{done && <Icon name="check" size={13} stroke={2.4} />}</span>
                <span style={{ flex: 1 }}><span style={{ display: 'block', fontSize: 13.5, fontWeight: 500 }}>{title}</span><span className="dim" style={{ fontSize: 12 }}>{sub}</span></span>
                <Icon name="chevronRight" size={15} className="muted" />
              </Link>
            </li>
          ))}
        </ul>
        {d.apps.includes('exits') && c.exitsOpen > 0 && <Link to="/exits" className="btn btn-ghost btn-sm" style={{ marginTop: 10 }}><Icon name="door" size={13} /> {c.exitsOpen} exit{c.exitsOpen === 1 ? '' : 's'} in progress</Link>}
      </section>
    </div>
  )
}

// ─── Personal: clock, hours, leave, tasks, pay ──────────────────────────────
function SelfRows({ d }: { d: any }) {
  const s = d.self
  const att = s.attendance
  const lv = s.leave
  const managerLike = !!d.team
  return (
    <>
      {managerLike && <h2 data-rise className="display" style={{ fontSize: 22, margin: '8px 2px 12px' }}>My work</h2>}
      <div className="dgrid row">
        {att && <TimeTracker className="span-4" />}
        {att && <HoursCard last7={att.last7} />}
        {lv && <LeaveCard lv={lv} span={att ? 'span-4' : 'span-6'} />}
        <TasksCard className={att ? 'span-6' : lv ? 'span-6' : 'span-8'} />
        <PayCard payslip={s.payslip} apps={d.apps} span={att || lv ? 'span-6' : 'span-4'} />
      </div>
    </>
  )
}

function HoursCard({ last7 }: { last7: { date: string; hours: number }[] }) {
  const worked = last7.filter((x) => x.hours > 0)
  const avg = worked.length ? worked.reduce((a, b) => a + b.hours, 0) / worked.length : 0
  const avgRef = useCountUp(avg, fmtHours)
  const max = Math.max(10, ...last7.map((x) => x.hours))
  const [hot, setHot] = useState(6)
  const bars = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (bars.current && !reduced()) gsap.fromTo(bars.current.querySelectorAll('[data-bar]'), { scaleY: 0 }, { scaleY: 1, duration: 0.9, ease: 'back.out(1.6)', stagger: 0.05, delay: 0.3, transformOrigin: '50% 100%', clearProps: 'transform' })
  }, [])
  return (
    <section data-card className="card span-4" style={{ padding: 22, display: 'flex', flexDirection: 'column' }}>
      <CardHead title="Hours" to="/attendance" />
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 8 }}>
        <span className="display num" style={{ fontSize: 30 }}><span ref={avgRef}>00:00:00</span></span>
        <span className="dim" style={{ fontSize: 12, lineHeight: 1.3 }}>average workday<br />last 7 days</span>
      </div>
      <div ref={bars} style={{ flex: 1, display: 'flex', alignItems: 'flex-end', gap: 10, marginTop: 14, minHeight: 120 }}>
        {last7.map((x, i) => (
          <div key={x.date} onMouseEnter={() => setHot(i)} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', height: '100%', position: 'relative' }}>
            {i === hot && x.hours > 0 && <span className="pill honey" style={{ position: 'absolute', top: -4, zIndex: 1, textTransform: 'none' }}>{fmtHours(x.hours)}</span>}
            <div style={{ flex: 1, width: '100%', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
              {x.hours > 0 ? <span data-bar style={{ width: 10, height: `${(x.hours / max) * 88}%`, borderRadius: 8, background: i === hot ? 'var(--honey)' : 'var(--night)' }} /> : <span style={{ width: 1, height: '100%', borderLeft: '1px dashed var(--line-2)' }} />}
            </div>
            <span className="dim" style={{ fontSize: 11, marginTop: 6 }}>{fmt(x.date, { weekday: 'narrow' })}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

function LeaveCard({ lv, span }: { lv: any; span: string }) {
  return (
    <section data-card className={`card ${span}`} style={{ padding: 22, display: 'flex', flexDirection: 'column' }} data-tour="balances">
      <CardHead title="My leave" to="/leave" />
      {lv.balances.length === 0 ? <Empty icon="leaf" text="No leave allocated yet." /> : (
        <ul style={{ listStyle: 'none', marginTop: 12, display: 'flex', flexDirection: 'column', gap: 9 }}>
          {lv.balances.filter((b: any) => b.total > 0 || b.used > 0).slice(0, 4).map((b: any) => (
            <li key={b.code}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}><span>{b.name}</span><span className="num dim">{b.available} left</span></div>
              <div style={{ height: 6, borderRadius: 3, background: 'var(--well)', marginTop: 4, overflow: 'hidden' }}><span style={{ display: 'block', height: '100%', width: `${b.total ? Math.min(100, (b.available / b.total) * 100) : 0}%`, background: 'var(--night)', borderRadius: 3 }} /></div>
            </li>
          ))}
          {lv.balances.every((b: any) => !(b.total > 0 || b.used > 0)) && <li className="dim" style={{ fontSize: 12 }}>Balances appear once leave is allocated or accrued.</li>}
        </ul>
      )}
      <div style={{ marginTop: 'auto', paddingTop: 12 }}>
        {lv.upcoming.length > 0
          ? <div className="well" style={{ padding: '8px 12px', fontSize: 12.5 }}><strong style={{ fontWeight: 500 }}>Next:</strong> {lv.upcoming[0].type}, {fmt(lv.upcoming[0].start, { day: 'numeric', month: 'short' })}{lv.upcoming[0].end !== lv.upcoming[0].start ? ` – ${fmt(lv.upcoming[0].end, { day: 'numeric', month: 'short' })}` : ''} <Badge label={lv.upcoming[0].status} /></div>
          : <Link to="/leave" className="btn btn-ghost btn-sm" style={{ width: '100%' }}><Icon name="plus" size={13} /> Apply for leave</Link>}
      </div>
    </section>
  )
}

function PayCard({ payslip, apps, span }: { payslip: any; apps: string[]; span: string }) {
  const net = useCountUp(payslip?.net ?? null, (v) => Math.round(v).toLocaleString())
  return (
    <section data-card className={`card ${span}`} style={{ padding: 22, display: 'flex', flexDirection: 'column', background: payslip ? 'linear-gradient(140deg, var(--honey-2), var(--app-3))' : undefined }}>
      <CardHead title={apps.includes('payroll') ? 'My pay' : 'Shortcuts'} to={apps.includes('payroll') ? '/payroll' : '/security'} />
      {apps.includes('payroll') && (payslip ? (
        <div style={{ marginTop: 10 }}>
          <div className="dim" style={{ fontSize: 12 }}>Net pay · {fmt(payslip.start, { month: 'long', year: 'numeric' })}</div>
          <div className="display num" style={{ fontSize: 40, lineHeight: 1.1 }}>{payslip.currency} <span ref={net}>0</span></div>
          <Link to={`/payroll/payslips/${payslip.id}`} className="btn btn-primary btn-sm" style={{ marginTop: 12 }}>View payslip <Icon name="arrowRight" size={13} /></Link>
        </div>
      ) : <Empty icon="wallet" text="Your payslips appear here after your first payroll." />)}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 'auto', paddingTop: 14 }}>
        {apps.includes('expenses') && <Link to="/expenses" className="btn btn-ghost btn-sm"><Icon name="receipt" size={13} /> Claim an expense</Link>}
        {apps.includes('attendance') && <Link to="/attendance" className="btn btn-ghost btn-sm"><Icon name="clock" size={13} /> Fix a missed punch</Link>}
        <Link to="/security" className="btn btn-ghost btn-sm"><Icon name="lock" size={13} /> Two-factor</Link>
      </div>
    </section>
  )
}

// ─── Payroll staff: the cycle in flight ─────────────────────────────────────
function PayrollRows({ d }: { d: any }) {
  const p = d.payroll
  if (!p) return null
  const c = p.current
  const idx = c ? STAGES.indexOf(c.status) : -1
  return (
    <div className="dgrid row">
      <section data-card className="card span-8" style={{ padding: 22 }}>
        <CardHead title="Payroll" to={c ? `/payroll/cycles/${c.id}` : '/payroll'} />
        {!c ? <Empty icon="wallet" text="No payroll cycles yet. Create one from Payroll." /> : (
          <>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
              <span className="display" style={{ fontSize: 26 }}>{fmt(c.start, { day: 'numeric', month: 'short' })} – {fmt(c.end, { day: 'numeric', month: 'short', year: 'numeric' })}</span>
              <Badge label={c.status} /><span className="dim" style={{ fontSize: 13 }}>{c.payslips} payslips</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${STAGES.length}, minmax(0,1fr))`, gap: 6, marginTop: 16 }}>
              {STAGES.map((st, i) => (
                <div key={st}>
                  <div className={`seg ${i < idx ? 'night' : i === idx ? 'honey' : 'outline'}`} style={{ height: 28, fontSize: 11, padding: '0 10px' }}>{i < idx ? <Icon name="check" size={12} stroke={2.4} /> : i + 1}</div>
                  <div className={i <= idx ? '' : 'muted'} style={{ fontSize: 11, marginTop: 5 }}>{STAGE[st]}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>
      <section data-card className="card span-4" style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <CardHead title="To do" to="/payroll" />
        <TodoLine n={p.expensesAwaitingFinance} label="expense claims to finance-approve" to="/expenses" />
        <TodoLine n={p.inputsToApprove} label="payroll inputs to approve" to={c ? `/payroll/cycles/${c.id}` : '/payroll'} />
        <TodoLine n={p.openCycles} label="payroll cycles not yet paid" to="/payroll" />
        {p.lastPaid && <div className="muted" style={{ fontSize: 12, marginTop: 'auto' }}>Last paid: {fmt(p.lastPaid.start, { month: 'long', year: 'numeric' })}</div>}
      </section>
    </div>
  )
}

function TodoLine({ n, label, to }: { n: number; label: string; to: string }) {
  return (
    <Link to={to} className="well" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px' }}>
      <span className="display num" style={{ fontSize: 24, minWidth: 30 }}>{n}</span>
      <span className="dim" style={{ flex: 1, fontSize: 13 }}>{label}</span>
      <Icon name="chevronRight" size={14} className="muted" />
    </Link>
  )
}

function StatusDot({ s }: { s: string }) {
  const m: Record<string, [string, string]> = { in: ['var(--ok)', 'In'], on_leave: ['var(--honey)', 'On leave'], absent: ['var(--danger)', 'Absent'], not_in: ['var(--grey)', 'Not in'] }
  const [c, l] = m[s] ?? m.not_in
  return <span title={l} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11 }} className="dim"><span style={{ width: 8, height: 8, borderRadius: '50%', background: c }} />{l}</span>
}

function Empty({ icon, text }: { icon: IconName; text: string }) {
  return <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', gap: 8, padding: '22px 10px', color: 'var(--faint)', fontSize: 13 }}><Icon name={icon} size={22} /><span>{text}</span></div>
}

function Skeleton() {
  return (
    <div className="dgrid">
      {[3, 3, 3, 3, 8, 4, 4, 4, 4].map((n, i) => <div key={i} className={`skeleton span-${n}`} style={{ height: i < 4 ? 132 : 260, borderRadius: 'var(--r-card)' }} />)}
    </div>
  )
}
