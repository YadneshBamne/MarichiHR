import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import SetupChecklist from '../components/company/SetupChecklist'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../lib/api'
import { useAuth } from '../contexts/AuthContext'
import { useReveal, useCountUp, gsap, reduced } from '../lib/motion'
import { primaryRole } from '../components/AppShell'
import { TimeTracker, TasksCard, CardHead } from '../components/dashboard/Widgets'
import SwapGrid, { type CardDef } from '../components/dashboard/SwapGrid'
import Icon, { type IconName } from '../components/ui/Icon'
import { fmtHours } from '../lib/format'
import Avatar from '../components/ui/Avatar'
import Modal from '../components/ui/Modal'
import Badge from '../components/ui/Badge'
import { greeting as greet } from '../lib/i18n'
import { useCompany } from '../lib/hooks/useCompany'

// Role-based home. The API decides which sections exist for this person (self / team / company / payroll); this page turns them into cards
// and lays them out on a grid the person can rearrange (drag the grip at the top of a card onto another card of the same size). The layout is
// saved per person. Cards come in three sizes: kpi (a quarter row), half, full.
export { TimeTracker } from '../components/dashboard/Widgets'

const utc = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00Z`)
const fmt = (s: string, o: Intl.DateTimeFormatOptions) => utc(s).toLocaleDateString(undefined, { timeZone: 'UTC', ...o })
const STAGE: Record<string, string> = { draft: 'Draft', processing: 'Calculating', review: 'Review', approved: 'First approval', finance_approved: 'Second approval', disbursed: 'Paid' }
const STAGES = ['draft', 'processing', 'review', 'approved', 'finance_approved', 'disbursed']
const GROUP: Record<string, string> = { time: 'Leave and time', money: 'Money', people: 'People', review: 'To review' }
const ago = (iso?: string | null) => { if (!iso) return ''; const h = Math.round((Date.now() - new Date(iso).getTime()) / 3_600_000); return h < 1 ? 'just now' : h < 24 ? `${h} h` : `${Math.round(h / 24)} d` }

const greeting = () => greet(new Date().getHours())

export default function DashboardPage() {
  const { user } = useAuth()
  const qc = useQueryClient()
  const roles = user?.roles?.map((r) => r.name) ?? []
  const role = primaryRole(roles)
  const { data: d, isLoading } = useQuery({ queryKey: ['dashboard'], queryFn: async () => (await api.get('/dashboard')).data.data, staleTime: 30_000 })
  const layout = useQuery({ queryKey: ['dashboard-layout'], retry: false, staleTime: Infinity, queryFn: async () => (await api.get('/dashboard/layout')).data.data as Layout })
  const [choosing, setChoosing] = useState(false)
  const hidden = new Set(layout.data?.hidden ?? [])
  const setHidden = (ids: string[]) => { qc.setQueryData(['dashboard-layout'], (o: Layout | undefined) => ({ slots: o?.slots ?? null, hidden: ids })); api.put('/dashboard/layout', { hidden: ids }).catch(() => undefined) }
  const ref = useReveal<HTMLDivElement>(!!d && !layout.isLoading)
  const first = user?.employee?.firstName || user?.fullName?.split(' ')[0]
  const has = (a: string) => d?.apps?.includes(a)
  const { data: company } = useCompany()
  const feature = (f: string) => !company?.entitlements || company.entitlements.features.includes(f)

  // Quick actions only for things this person can actually do
  const actions: [string, IconName, string][] = [
    ...(d?.self && has('leave') ? [['/leave', 'leaf', 'Apply for leave'] as [string, IconName, string]] : []),
    ...(d?.self && has('expenses') ? [['/expenses', 'receipt', 'New expense claim'] as [string, IconName, string]] : []),
    ...(d?.self && feature('timesheets') ? [['/timesheets', 'pie', 'Log hours'] as [string, IconName, string]] : []),
    ...(d?.self && feature('helpdesk') ? [['/helpdesk', 'info', 'Ask HR'] as [string, IconName, string]] : []),
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
          {[...actions].sort((a, b) => Number(b[0] === '/approvals') - Number(a[0] === '/approvals')).slice(0, 4).map(([to, ic, label], i) => <Link key={to} to={to} className={`btn ${i === 0 ? 'btn-primary' : 'btn-ghost'}`}><Icon name={ic} size={15} /> {label}</Link>)}
          {d && <button type="button" className="btn btn-ghost" onClick={() => setChoosing(true)} title="Choose which cards you see"><Icon name="sliders" size={15} /> Customize</button>}
        </div>
      </header>

      {isLoading || !d || layout.isLoading ? <Skeleton /> : (
        <>
          <NewsBanner />
          {!d.self && !d.team && !d.payroll && !d.company ? (
            <section className="card" style={{ padding: 40, textAlign: 'center' }}><div className="display" style={{ fontSize: 22 }}>Nothing to show yet</div><p className="dim" style={{ marginTop: 6 }}>Your administrator hasn't linked an employee record or role to your account.</p></section>
          ) : (() => {
            const all = buildCards(d, role)
            const shown = all.filter((c) => !hidden.has(c.id))
            return (
              <>
                {shown.length ? <SwapGrid cards={shown} saved={layout.data?.slots} onSaved={(slots) => qc.setQueryData(['dashboard-layout'], (o: Layout | undefined) => ({ slots, hidden: o?.hidden ?? [] }))} /> : (
                  <section className="card" style={{ padding: 40, textAlign: 'center' }}><div className="display" style={{ fontSize: 22 }}>Your dashboard is empty</div><p className="dim" style={{ marginTop: 6 }}>You have hidden every card. <button type="button" className="link" onClick={() => setChoosing(true)}>Choose what to show</button></p></section>
                )}
                {choosing && <ChooseCards cards={all} hidden={hidden} onChange={setHidden} onClose={() => setChoosing(false)} />}
              </>
            )
          })()}
        </>
      )}
    </div>
  )
}

type Layout = { slots: Record<string, string> | null; hidden: string[] }

// "Customize": tick the cards you want on your dashboard. Saved at once, for you only.
function ChooseCards({ cards, hidden, onChange, onClose }: { cards: CardDef[]; hidden: Set<string>; onChange: (ids: string[]) => void; onClose: () => void }) {
  const toggle = (id: string) => { const n = new Set(hidden); n.has(id) ? n.delete(id) : n.add(id); onChange([...n]) }
  const group = (size: 'kpi' | 'other') => cards.filter((c) => (size === 'kpi') === (c.size === 'kpi'))
  const row = (c: CardDef) => (
    <label key={c.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 4px', minHeight: 44, cursor: 'pointer' }}>
      <input type="checkbox" checked={!hidden.has(c.id)} onChange={() => toggle(c.id)} />
      <span>{c.title}</span>
    </label>
  )
  return (
    <Modal open onClose={onClose} title="Customize your dashboard" width={460}>
      <div style={{ display: 'grid', gap: 12 }}>
        <p className="dim" style={{ margin: 0, fontSize: 13 }}>Tick what you want to see. It is saved for you only. You can also drag any card on the dashboard to move it.</p>
        <div><strong style={{ fontSize: 13 }}>Key numbers</strong>{group('kpi').map(row)}</div>
        <div><strong style={{ fontSize: 13 }}>Cards</strong>{group('other').map(row)}</div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
          <button type="button" className="btn btn-ghost btn-sm" disabled={!hidden.size} onClick={() => onChange([])}>Show everything</button>
          <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </Modal>
  )
}

// What each card is called in the "Customize" list
const TITLES: Record<string, string> = { payroll_cycle: 'Payroll cycle', payroll_todo: 'Payroll to do', team_today: 'Team today', approvals: 'Approvals', week_leave: 'Leave this week', headcount: 'Headcount by department', setup: 'Next steps', clock: 'Time tracker', hours: 'Hours', my_leave: 'My leave', my_tasks: 'My tasks', my_pay: 'My pay' }

// The cards this person gets, in their default order
function buildCards(d: any, role: string): CardDef[] {
  const cards: CardDef[] = kpiTiles(d, role).map((k) => ({ id: `kpi_${k.id}`, size: 'kpi' as const, title: k.label, render: () => <Kpi {...k} /> }))
  // Every card also has a compact tile (its key number): that is what it shows when it is dragged into a small slot
  const add = (id: string, size: CardDef['size'], el: ReactNode, tile: Omit<Tile, 'id'>) => cards.push({ id, size, title: TITLES[id] ?? tile.label, render: (compact) => (compact ? <Kpi id={id} {...tile} /> : el) })
  const payrollRole = role === 'payroll_admin' || role === 'compliance_officer'
  const payrollCards = () => {
    const p = d.payroll
    if (!p) return
    add('payroll_cycle', 'half', <PayrollCycleCard p={p} />, { label: 'Open payroll cycles', value: p.openCycles ?? 0, icon: 'wallet', to: '/payroll' })
    add('payroll_todo', 'half', <PayrollTodoCard p={p} />, { label: 'Payroll to do', value: (p.expensesAwaitingFinance ?? 0) + (p.inputsToApprove ?? 0), icon: 'checkCircle', to: '/payroll' })
  }
  if (payrollRole) payrollCards()
  if (d.team) {
    const t = d.team
    add('team_today', 'half', <TeamTodayCard t={t} />, { label: `${t.scope === 'company' ? 'Company' : 'Team'} in today`, value: t.today?.in ?? t.size, suffix: `/ ${t.size}`, icon: 'users', to: '/employees' })
    add('approvals', 'half', <ApprovalsCard t={t} />, { label: 'Approvals waiting', value: t.approvals.total, icon: 'checkCircle', to: '/approvals', tone: 'honey' })
    if (d.apps.includes('leave')) add('week_leave', 'full', <WeekLeaveCard week={t.week} label={t.scope === 'company' ? 'Company' : 'Team'} />, { label: 'On leave this week', value: new Set(t.week.leave.map((l: any) => l.employeeId)).size, icon: 'leaf', to: '/leave' })
  }
  if (d.company) {
    const c = d.company
    add('headcount', 'half', <HeadcountCard c={c} />, { label: 'Employees', value: c.headcount, icon: 'users', to: '/employees' })
    add('setup', 'half', <SetupCard c={c} apps={d.apps} />, { label: 'People without a login', value: c.noLogin ?? 0, icon: 'lock', to: '/employees' })
  }
  if (d.self) {
    const s = d.self
    const leaveLeft = s.leave?.balances?.reduce((a: number, b: any) => a + b.available, 0) ?? 0
    if (s.attendance) {
      const worked = s.attendance.last7.filter((x: any) => x.hours > 0)
      add('clock', 'half', <TimeTracker />, { label: 'Worked today', value: s.attendance.today.workedHours ?? 0, format: fmtHours, icon: 'clock', to: '/attendance' })
      add('hours', 'half', <HoursCard last7={s.attendance.last7} />, { label: 'Average workday', value: worked.length ? worked.reduce((a: number, b: any) => a + b.hours, 0) / worked.length : 0, format: fmtHours, icon: 'clock', to: '/attendance' })
    }
    if (s.leave) add('my_leave', 'half', <LeaveCard lv={s.leave} holidays={s.holidays ?? []} />, { label: 'My leave days left', value: Math.round(leaveLeft * 10) / 10, icon: 'leaf', to: '/leave' })
    add('my_tasks', 'half', <TasksCard />, { label: 'Open tasks', value: s.tasks?.open ?? 0, icon: 'list', to: '/activities', tone: 'honey' })
    add('my_pay', 'half', <PayCard payslip={s.payslip} apps={d.apps} />, { label: s.payslip ? 'Latest net pay' : 'My pay', value: s.payslip?.net ?? 0, icon: 'wallet', to: s.payslip ? `/payroll/payslips/${s.payslip.id}` : '/payroll' })
  }
  if (!payrollRole) payrollCards()
  return cards
}

// ─── KPI tiles: always up to four, always the same height ────────────────────
type Tile = { id: string; label: string; value: number; suffix?: string; icon: IconName; to?: string; tone?: 'honey' | 'night'; format?: (v: number) => string }
function kpiTiles(d: any, role: string): Tile[] {
  const s = d.self, t = d.team, c = d.company, p = d.payroll
  const has = (a: string) => d.apps.includes(a)
  const leaveLeft = s?.leave?.balances?.reduce((a: number, b: any) => a + b.available, 0) ?? 0
  const att = s?.attendance?.month
  const tiles: Tile[] = []
  if (role === 'system_admin' || role === 'hr_admin') {
    tiles.push({ id: 'employees', label: 'Employees', value: c?.headcount ?? 0, icon: 'users', to: '/employees', tone: 'night' })
    if (t?.today) tiles.push({ id: 'in_today', label: 'In today', value: t.today.in, suffix: `/ ${t.size}`, icon: 'clock', to: '/attendance' })
    tiles.push({ id: 'approvals', label: 'Approvals waiting', value: t?.approvals?.total ?? 0, icon: 'checkCircle', to: '/approvals', tone: 'honey' })
    tiles.push({ id: 'joined', label: 'Joined this month', value: c?.joiners ?? 0, icon: 'sparkle' })
    if (!t?.today && has('exits')) tiles.push({ id: 'exits', label: 'Exits in progress', value: c?.exitsOpen ?? 0, icon: 'door', to: '/exits' })
  } else if (role === 'payroll_admin' || role === 'compliance_officer') {
    tiles.push({ id: 'cycles', label: 'Open payroll cycles', value: p?.openCycles ?? 0, icon: 'wallet', to: '/payroll', tone: 'night' })
    tiles.push({ id: 'payslips', label: 'Payslips in current cycle', value: p?.current?.payslips ?? 0, icon: 'file', to: p?.current ? `/payroll/cycles/${p.current.id}` : '/payroll' })
    tiles.push({ id: 'expenses_fin', label: 'Expenses to finance-approve', value: p?.expensesAwaitingFinance ?? 0, icon: 'receipt', to: '/expenses', tone: 'honey' })
    tiles.push({ id: 'inputs', label: 'Payroll inputs to approve', value: p?.inputsToApprove ?? 0, icon: 'checkCircle' })
  } else if (role === 'manager') {
    tiles.push({ id: 'team', label: 'Team members', value: t?.size ?? 0, icon: 'users', to: '/employees', tone: 'night' })
    if (t?.today) tiles.push({ id: 'team_in', label: 'Team in today', value: t.today.in, suffix: `/ ${t.size}`, icon: 'clock', to: '/attendance' })
    tiles.push({ id: 'approvals', label: 'Approvals waiting', value: t?.approvals?.total ?? 0, icon: 'checkCircle', to: '/approvals', tone: 'honey' })
    if (has('leave')) tiles.push({ id: 'leave_mine', label: 'My leave days left', value: Math.round(leaveLeft * 10) / 10, icon: 'leaf', to: '/leave' })
  } else {
    if (has('leave')) tiles.push({ id: 'leave_left', label: 'Leave days left', value: Math.round(leaveLeft * 10) / 10, icon: 'leaf', to: '/leave', tone: 'night' })
    if (att) tiles.push({ id: 'present', label: 'Days present this month', value: att.present, suffix: `/ ${att.workingDays}`, icon: 'calendar', to: '/attendance' })
    if (att) tiles.push({ id: 'hours', label: 'Hours this month', value: att.hours, format: fmtHours, icon: 'clock', to: '/attendance' })
    tiles.push({ id: 'tasks', label: 'Open tasks', value: s?.tasks?.open ?? 0, icon: 'list', to: '/activities', tone: 'honey' })
    if (s?.payslip && tiles.length < 4) tiles.push({ id: 'netpay', label: `Net pay · ${fmt(s.payslip.start, { month: 'short' })}`, value: s.payslip.net, icon: 'wallet', to: `/payroll/payslips/${s.payslip.id}` })
  }
  return tiles.slice(0, 4)
}

function Kpi({ label, value, suffix, icon, to, tone, format }: Tile) {
  const n = useCountUp(value, format ?? ((v) => (Number.isInteger(value) ? Math.round(v).toLocaleString() : v.toFixed(1))))
  const bg = tone === 'night' ? 'var(--night)' : tone === 'honey' ? 'var(--honey)' : undefined
  const fg = tone === 'night' ? 'var(--night-ink)' : 'var(--ink)'
  const body = (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <span style={{ fontSize: 13, color: tone === 'night' ? 'var(--night-dim)' : tone === 'honey' ? 'var(--honey-ink)' : 'var(--dim)' }}>{label}</span>
        <span style={{ width: 34, height: 34, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: tone === 'night' ? 'var(--night-2)' : tone === 'honey' ? 'rgba(255,255,255,.35)' : 'var(--well)' }}><Icon name={icon} size={16} /></span>
      </div>
      {/* the number grows with the room it is given (a tile dragged into a big slot) and sits in the middle of it */}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6, paddingTop: 6 }}>
        <span className="display num" style={{ fontSize: 'clamp(44px, 26cqmin, 132px)', lineHeight: 1 }}><span ref={n}>0</span></span>
        {suffix && <span style={{ fontSize: 'clamp(14px, 7cqmin, 32px)', opacity: 0.6, alignSelf: 'flex-end', paddingBottom: '0.4em' }}>{suffix}</span>}
      </div>
    </>
  )
  // a tile fills whatever height its row gives it: the label stays on top and the number sits at the bottom, so a tall row never leaves a hole in it
  const style = { padding: 20, background: bg, color: fg, display: 'flex', flexDirection: 'column', gap: 6, minHeight: 132, containerType: 'size' } as const
  return to ? <Link to={to} data-card className="card" style={style} draggable={false}>{body}</Link> : <div data-card className="card" style={style}>{body}</div>
}

// ─── Manager / HR: team today, everything waiting for them, team leave this week ──────────────
function TeamTodayCard({ t }: { t: any }) {
  const scopeLabel = t.scope === 'company' ? 'Company' : 'Team'
  return (
    <section data-card className="card" style={{ padding: 22 }}>
      <CardHead title={`${scopeLabel} today`} to="/employees" />
      {t.today && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(76px, 1fr))', gap: 8, marginTop: 14 }}>
          {([['In', t.today.in, 'honey'], ['On leave', t.today.onLeave, 'night'], ['Not in yet', t.today.notIn, 'outline'], ['Absent', t.today.absent, 'stripes']] as [string, number, string][]).map(([l, v, k]) => (
            <div key={l}><div className="dim" style={{ fontSize: 12, marginBottom: 5 }}>{l}</div><div className={`seg ${k}`} style={k === 'stripes' ? { backgroundSize: '22px 22px' } : undefined}><span className="num">{v}</span></div></div>
          ))}
        </div>
      )}
      {t.people.length === 0 ? <Empty icon="users" text={t.scope === 'company' ? 'Nobody else here yet. Add your people from Employees.' : 'Nobody reports to you yet.'} /> : (
        <ul style={{ listStyle: 'none', marginTop: 16, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 8 }}>
          {t.people.map((p: any) => (
            <li key={p.id}>
              <Link to={`/employees/${p.id}`} className="well" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px' }} draggable={false}>
                <Avatar name={p.name} src={p.avatarUrl} size={32} />
                <span style={{ flex: 1, minWidth: 0 }}><span style={{ display: 'block', fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span><span className="muted" style={{ fontSize: 11 }}>{p.title ?? '—'}</span></span>
                <StatusDot s={p.status} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function ApprovalsCard({ t }: { t: any }) {
  const a = t.approvals
  return (
    <section data-card className="card" style={{ padding: 22, display: 'flex', flexDirection: 'column' }} data-tour="approvals-card">
      <CardHead title="Approvals" to="/approvals" />
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
        {Object.entries(a.groups ?? {}).filter(([, n]) => (n as number) > 0).map(([k, n]) => <span key={k} className={`pill ${k === 'time' ? 'honey' : k === 'money' ? 'warn' : k === 'people' ? 'night' : 'info'}`} style={{ textTransform: 'none' }}>{n as number} {GROUP[k]?.toLowerCase()}</span>)}
      </div>
      {a.total === 0 ? <Empty icon="checkCircle" text="You're all caught up." /> : (
        <ul style={{ listStyle: 'none', marginTop: 12, flex: 1 }}>
          {a.items.map((i: any) => (
            <li key={i.key} style={{ borderTop: '1px solid var(--line)' }}>
              <Link to={i.link} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '10px 0' }} draggable={false}>
                {i.who ? <Avatar name={i.who} size={30} /> : <span style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--well)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}><Icon name="checkCircle" size={15} /></span>}
                <span style={{ flex: 1, minWidth: 0 }}><span style={{ display: 'block', fontSize: 13, fontWeight: 500 }}>{i.who ?? i.label}</span><span className="dim" style={{ fontSize: 12 }}>{i.who ? `${i.label} · ` : ''}{i.summary}</span></span>
                {i.at && <span className="muted" style={{ fontSize: 11 }}>{ago(i.at)}</span>}
                <Icon name="chevronRight" size={15} className="muted" />
              </Link>
            </li>
          ))}
        </ul>
      )}
      {a.total > 0 && <Link to="/approvals" className="btn btn-primary btn-sm" style={{ marginTop: 12 }} draggable={false}>Open approvals inbox ({a.total})</Link>}
    </section>
  )
}

function WeekLeaveCard({ week, label }: { week: any; label: string }) {
  const days = Array.from({ length: 5 }, (_, i) => new Date(utc(week.start).getTime() + i * 86400000).toISOString().slice(0, 10))
  const today = new Date().toISOString().slice(0, 10)
  const grid = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (grid.current && !reduced()) gsap.fromTo(grid.current.querySelectorAll('[data-ev]'), { opacity: 0, y: 12, scale: 0.95 }, { opacity: 1, y: 0, scale: 1, duration: 0.55, stagger: 0.05, delay: 0.2, ease: 'back.out(1.6)', clearProps: 'opacity,transform' })
  }, [week.start])
  return (
    <section data-card className="card" style={{ padding: 22 }} data-tour="week">
      <CardHead title={`${label} leave this week`} to="/leave" />
      <div ref={grid} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(112px, 1fr))', gap: 8, marginTop: 14 }}>
        {days.map((day) => {
          const on = week.leave.filter((l: any) => l.start <= day && l.end >= day)
          return (
            <div key={day} style={{ borderLeft: '1px solid var(--line)', paddingLeft: 8, minHeight: 96 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                <span className="display num" style={{ fontSize: 16, width: 30, height: 30, lineHeight: '30px', textAlign: 'center', borderRadius: '50%', background: day === today ? 'var(--night)' : 'transparent', color: day === today ? 'var(--night-ink)' : 'var(--dim)' }}>{utc(day).getUTCDate()}</span>
                <span className="dim" style={{ fontSize: 12 }}>{fmt(day, { weekday: 'short' })}</span>
              </div>
              {(week.holidays ?? []).filter((h: any) => h.date === day).map((h: any) => <div key={h.date} data-ev title={`Public holiday · ${h.name}`} style={{ background: 'var(--night)', color: 'var(--night-ink)', borderRadius: 10, padding: '5px 8px', marginBottom: 5, fontSize: 11.5, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{h.name}</div>)}
              {on.length === 0 && !(week.holidays ?? []).some((h: any) => h.date === day) && <div className="muted" style={{ fontSize: 11 }}>Everyone in</div>}
              {on.map((l: any) => <div key={l.id + day} data-ev title={`${l.name} · ${l.type}`} style={{ background: 'var(--honey-2)', borderRadius: 10, padding: '5px 8px', marginBottom: 5, fontSize: 11.5, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}><strong style={{ fontWeight: 600 }}>{l.name.split(' ')[0]}</strong> · {l.type}</div>)}
            </div>
          )
        })}
      </div>
    </section>
  )
}

// ─── HR / admin: company snapshot ───────────────────────────────────────────
function HeadcountCard({ c }: { c: any }) {
  const max = Math.max(1, ...c.departments.map((x: any) => x.count))
  return (
    <section data-card className="card" style={{ padding: 22 }}>
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
  )
}
function SetupCard({ c, apps }: { c: any; apps: string[] }) {
  return (
    <section data-card className="card" style={{ padding: 22 }}>
      <SetupChecklist />
      {apps.includes('exits') && c.exitsOpen > 0 && <Link to="/exits" className="btn btn-ghost btn-sm" style={{ marginTop: 10 }} draggable={false}><Icon name="door" size={13} /> {c.exitsOpen} exit{c.exitsOpen === 1 ? '' : 's'} in progress</Link>}
    </section>
  )
}

// ─── Personal: hours, leave, pay (the clock and tasks are shared widgets) ──────────────────────
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
    <section data-card className="card" style={{ padding: 22, display: 'flex', flexDirection: 'column' }}>
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

function LeaveCard({ lv, holidays }: { lv: any; holidays: { date: string; name: string }[] }) {
  return (
    <section data-card className="card" style={{ padding: 22, display: 'flex', flexDirection: 'column' }} data-tour="balances">
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
      <div style={{ marginTop: 'auto', paddingTop: 12, display: 'grid', gap: 6 }}>
        {holidays[0] && <Link to="/holidays" className="well" style={{ padding: '8px 12px', fontSize: 12.5, display: 'block' }} draggable={false}><strong style={{ fontWeight: 500 }}>Holiday:</strong> {holidays[0].name}, {fmt(holidays[0].date, { weekday: 'short', day: 'numeric', month: 'short' })}</Link>}
        {lv.upcoming.length > 0
          ? <div className="well" style={{ padding: '8px 12px', fontSize: 12.5 }}><strong style={{ fontWeight: 500 }}>Next:</strong> {lv.upcoming[0].type}, {fmt(lv.upcoming[0].start, { day: 'numeric', month: 'short' })}{lv.upcoming[0].end !== lv.upcoming[0].start ? ` – ${fmt(lv.upcoming[0].end, { day: 'numeric', month: 'short' })}` : ''} <Badge label={lv.upcoming[0].status} /></div>
          : <Link to="/leave" className="btn btn-ghost btn-sm" style={{ width: '100%' }} draggable={false}><Icon name="plus" size={13} /> Apply for leave</Link>}
      </div>
    </section>
  )
}

function PayCard({ payslip, apps }: { payslip: any; apps: string[] }) {
  const net = useCountUp(payslip?.net ?? null, (v) => Math.round(v).toLocaleString())
  return (
    <section data-card className="card" style={{ padding: 22, display: 'flex', flexDirection: 'column', background: payslip ? 'linear-gradient(140deg, var(--honey-2), var(--app-3))' : undefined }}>
      <CardHead title={apps.includes('payroll') ? 'My pay' : 'Shortcuts'} to={apps.includes('payroll') ? '/payroll' : '/security'} />
      {apps.includes('payroll') && (payslip ? (
        <div style={{ marginTop: 10 }}>
          <div className="dim" style={{ fontSize: 12 }}>Net pay · {fmt(payslip.start, { month: 'long', year: 'numeric' })}</div>
          <div className="display num" style={{ fontSize: 40, lineHeight: 1.1 }}>{payslip.currency} <span ref={net}>0</span></div>
          <Link to={`/payroll/payslips/${payslip.id}`} className="btn btn-primary btn-sm" style={{ marginTop: 12 }} draggable={false}>View payslip <Icon name="arrowRight" size={13} /></Link>
        </div>
      ) : <Empty icon="wallet" text="Your payslips appear here after your first payroll." />)}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 'auto', paddingTop: 14 }}>
        {apps.includes('expenses') && <Link to="/expenses" className="btn btn-ghost btn-sm" draggable={false}><Icon name="receipt" size={13} /> Claim an expense</Link>}
        {apps.includes('attendance') && <Link to="/attendance" className="btn btn-ghost btn-sm" draggable={false}><Icon name="clock" size={13} /> Fix a missed punch</Link>}
        <Link to="/security" className="btn btn-ghost btn-sm" draggable={false}><Icon name="lock" size={13} /> Two-factor</Link>
      </div>
    </section>
  )
}

// ─── Payroll staff: the cycle in flight ─────────────────────────────────────
function PayrollCycleCard({ p }: { p: any }) {
  const c = p.current
  const idx = c ? STAGES.indexOf(c.status) : -1
  return (
    <section data-card className="card" style={{ padding: 22 }}>
      <CardHead title="Payroll" to={c ? `/payroll/cycles/${c.id}` : '/payroll'} />
      {!c ? <Empty icon="wallet" text="No payroll cycles yet. Create one from Payroll." /> : (
        <>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
            <span className="display" style={{ fontSize: 26 }}>{fmt(c.start, { day: 'numeric', month: 'short' })} – {fmt(c.end, { day: 'numeric', month: 'short', year: 'numeric' })}</span>
            <Badge label={c.status} /><span className="dim" style={{ fontSize: 13 }}>{c.payslips} payslips</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(78px, 1fr))', gap: 6, marginTop: 16 }}>
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
  )
}
function PayrollTodoCard({ p }: { p: any }) {
  const c = p.current
  return (
    <section data-card className="card" style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <CardHead title="To do" to="/payroll" />
      <TodoLine n={p.expensesAwaitingFinance} label="expense claims to finance-approve" to="/expenses" />
      <TodoLine n={p.inputsToApprove} label="payroll inputs to approve" to={c ? `/payroll/cycles/${c.id}` : '/payroll'} />
      <TodoLine n={p.openCycles} label="payroll cycles not yet paid" to="/payroll" />
      {p.lastPaid && <div className="muted" style={{ fontSize: 12, marginTop: 'auto' }}>Last paid: {fmt(p.lastPaid.start, { month: 'long', year: 'numeric' })}</div>}
    </section>
  )
}

function TodoLine({ n, label, to }: { n: number; label: string; to: string }) {
  return (
    <Link to={to} className="well" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px' }} draggable={false}>
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
      {[3, 3, 3, 3, 6, 6, 6, 6].map((n, i) => <div key={i} className={`skeleton span-${n}`} style={{ height: i < 4 ? 132 : 260, borderRadius: 'var(--r-card)' }} />)}
    </div>
  )
}

// Newest announcement still to read (or acknowledge), as a one-line banner
function NewsBanner() {
  const { data = [] } = useQuery({ queryKey: ['announcements'], queryFn: async () => (await api.get('/announcements')).data.data as any[] })
  const a = data.find((x) => !x.read || (x.requiresAck && !x.acknowledged))
  if (!a) return null
  return (
    <Link to="/announcements" data-rise className="card" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', marginBottom: 'var(--gap)', borderLeft: '4px solid var(--honey)' }}>
      <Icon name="message" size={16} />
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><strong style={{ fontWeight: 600 }}>{a.title}</strong> <span className="dim">· {a.author}</span></span>
      <span className="pill honey">{a.requiresAck && !a.acknowledged ? 'Please acknowledge' : 'New'}</span>
    </Link>
  )
}
