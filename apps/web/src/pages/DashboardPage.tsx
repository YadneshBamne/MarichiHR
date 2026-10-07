import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../lib/api'
import { useAuth } from '../contexts/AuthContext'
import { useTodayAttendance, useClockIn, useClockOut } from '../lib/hooks/useAttendance'
import { useReveal, useCountUp, gsap, reduced, pop } from '../lib/motion'
import { useToast } from '../components/ui/Toast'
import Icon, { type IconName } from '../components/ui/Icon'
import Avatar from '../components/ui/Avatar'

// ─── date helpers (date-only values are UTC-midnight YYYY-MM-DD) ──────────────
const ymd = (d: Date) => d.toISOString().slice(0, 10)
const utc = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00Z`)
const addDays = (s: string, n: number) => ymd(new Date(utc(s).getTime() + n * 86400000))
const localToday = () => { const d = new Date(); return ymd(new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))) }
const mondayOf = (s: string) => addDays(s, -((utc(s).getUTCDay() + 6) % 7))
const fmt = (s: string, o: Intl.DateTimeFormatOptions) => utc(s).toLocaleDateString(undefined, { timeZone: 'UTC', ...o })
const DAY_HOURS = 8
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'

function greeting() {
  const h = new Date().getHours()
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
}

export default function DashboardPage() {
  const { user, hasRole } = useAuth()
  const isManager = hasRole('manager') || hasRole('hr_admin') || hasRole('system_admin')
  const hasEmployee = !!user?.employee
  const today = localToday()
  const thisMonth = { y: utc(today).getUTCFullYear(), m: utc(today).getUTCMonth() + 1 }
  const prevMonth = thisMonth.m === 1 ? { y: thisMonth.y - 1, m: 12 } : { y: thisMonth.y, m: thisMonth.m - 1 }

  const dash = useQuery({ queryKey: ['dashboard'], enabled: hasEmployee, queryFn: async () => (await api.get('/activities/dashboard')).data.data })
  const calNow = useQuery({ queryKey: ['attendance-calendar-me', thisMonth.y, thisMonth.m], enabled: hasEmployee, queryFn: async () => (await api.get('/attendance/calendar/me', { params: { year: thisMonth.y, month: thisMonth.m } })).data.data })
  const calPrev = useQuery({ queryKey: ['attendance-calendar-me', prevMonth.y, prevMonth.m], enabled: hasEmployee && utc(today).getUTCDate() < 8, queryFn: async () => (await api.get('/attendance/calendar/me', { params: { year: prevMonth.y, month: prevMonth.m } })).data.data })
  const payslips = useQuery({ queryKey: ['my-payslips'], enabled: hasEmployee, queryFn: async () => (await api.get('/payroll/payslips/me')).data.data as any[] })
  const unread = useQuery({ queryKey: ['notifications'], queryFn: async () => (await api.get('/notifications')).data.data })

  const days = useMemo(() => [...(calPrev.data?.calendar ?? []), ...(calNow.data?.calendar ?? [])] as any[], [calNow.data, calPrev.data])
  const emp = dash.data?.employee
  const balances: any[] = emp?.leaveBalances ?? []
  const leaveTotal = balances.reduce((a, b) => a + (b.total || 0), 0)
  const leaveUsed = balances.reduce((a, b) => a + (b.used || 0), 0)
  const leaveLeft = balances.reduce((a, b) => a + (b.available || 0), 0)

  // Attendance so far this month: present (or half) working days over working days elapsed
  const monthDays = (calNow.data?.calendar ?? []).filter((d: any) => d.date < today && !d.isWeekend)
  const presentish = monthDays.filter((d: any) => ['present', 'half_day', 'on_leave'].includes(d.status)).length
  const attendancePct = monthDays.length ? Math.round((presentish / monthDays.length) * 100) : 0
  const monthHours = calNow.data?.summary?.totalWorkedHours ?? 0
  const expectedHours = monthDays.length * DAY_HOURS
  const hoursPct = expectedHours ? Math.min(100, Math.round((monthHours / expectedHours) * 100)) : 0

  const lastPay = (payslips.data ?? []).find((p) => ymd(new Date(p.payrollCycle.payPeriodEnd)) <= today) ?? payslips.data?.[0]
  const ref = useReveal<HTMLDivElement>()

  return (
    <div ref={ref}>
      {/* ─── Greeting + KPI rail ─── */}
      <div data-rise className="dash-head">
        <h1 style={{ fontSize: 'clamp(34px, 4.4vw, 54px)', lineHeight: 1.05 }}>{greeting()}, {user?.employee?.firstName || user?.fullName?.split(' ')[0]}</h1>
      </div>
      <div className="dash-kpis" data-tour="kpis">
        <div className="kpi-rail" data-rise>
          {hasEmployee ? (
            <>
              <Seg label="Leave used" pct={leaveTotal ? Math.round((leaveUsed / leaveTotal) * 100) : 0} kind="night" grow={1.1} />
              <Seg label="Attendance" pct={attendancePct} kind="honey" grow={1} />
              <Seg label="Hours vs plan" pct={hoursPct} kind="stripes" grow={2.2} />
              <Seg label="Open tasks" pct={emp?.pendingActivities ?? 0} raw kind="outline" grow={0.9} />
            </>
          ) : (
            <div className="dim" style={{ fontSize: 13 }}>Signed in as {user?.roles?.map((r) => r.name.replace(/_/g, ' ')).join(', ')} without an employee record. Personal widgets are hidden.</div>
          )}
        </div>
        <div className="kpi-nums" data-rise>
          {isManager && dash.data?.manager ? (
            <>
              <BigNum value={dash.data.manager.teamSize} label="Team" icon="users" />
              <BigNum value={dash.data.manager.pendingLeaveApprovals + dash.data.manager.pendingRegularisations} label="To approve" icon="checkCircle" to="/approvals" />
              <BigNum value={Math.round(leaveLeft * 10) / 10} label="Leave days" icon="leaf" />
            </>
          ) : (
            <>
              <BigNum value={Math.round(leaveLeft * 10) / 10} label="Leave days" icon="leaf" to="/leave" />
              <BigNum value={emp?.pendingActivities ?? 0} label="Tasks" icon="list" to="/activities" />
              <BigNum value={unread.data?.unread ?? 0} label="Unread" icon="bell" />
            </>
          )}
        </div>
      </div>

      {/* ─── Card grid ─── */}
      {hasEmployee ? (
        <div className="dash-grid">
          <ProfileCard lastPay={lastPay} />
          <ProgressCard days={days} today={today} />
          <TimeTracker />
          <TasksCard />
          <AccordionCard balances={balances} payslips={payslips.data ?? []} />
          <WeekCard isManager={isManager} />
        </div>
      ) : (
        <StaffHome />
      )}
    </div>
  )
}

// ─── KPI pieces ──────────────────────────────────────────────────────────────
function Seg({ label, pct, kind, grow, raw }: { label: string; pct: number; kind: string; grow: number; raw?: boolean }) {
  const n = useCountUp(pct, (v) => (raw ? `${Math.round(v)}` : `${Math.round(v)}%`))
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (ref.current && !reduced()) gsap.fromTo(ref.current, { scaleX: 0 }, { scaleX: 1, duration: 1, ease: 'power3.out', delay: 0.2, transformOrigin: '0 50%' })
  }, [])
  return (
    <div style={{ flex: grow, minWidth: 90 }}>
      <div className="dim" style={{ fontSize: 12, marginBottom: 6 }}>{label}</div>
      <div ref={ref} className={`seg ${kind}`} style={kind === 'stripes' ? { animation: 'stripes 3.2s linear infinite', backgroundSize: '22px 22px' } : undefined}>
        <span className="num" style={kind === 'stripes' ? { background: 'var(--solid)', padding: '2px 8px', borderRadius: 999 } : undefined}><span ref={n}>0</span></span>
      </div>
    </div>
  )
}

function BigNum({ value, label, icon, to }: { value: number; label: string; icon: IconName; to?: string }) {
  const n = useCountUp(value, (v) => (Number.isInteger(value) ? Math.round(v).toString() : v.toFixed(1)))
  const body = (
    <>
      <div className="display num" style={{ fontSize: 'clamp(36px, 4vw, 54px)', lineHeight: 1 }}><span ref={n}>0</span></div>
      <div className="dim" style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 5, marginTop: 4 }}><Icon name={icon} size={13} /> {label}</div>
    </>
  )
  return to ? <Link to={to} style={{ display: 'block' }}>{body}</Link> : <div>{body}</div>
}

// ─── Profile hero ────────────────────────────────────────────────────────────
function ProfileCard({ lastPay }: { lastPay: any }) {
  const { user } = useAuth()
  const name = user?.fullName || ''
  const title = (user?.employee as any)?.jobPosition?.title || user?.roles?.find((r) => r.name !== 'employee')?.name.replace(/_/g, ' ') || 'Team member'
  const net = useCountUp(lastPay?.netPay ?? null, (v) => Math.round(v).toLocaleString())
  return (
    <Link to={user?.employee ? `/employees/${user.employee.id}` : '/dashboard'} data-card className="card lift area-profile" style={{ position: 'relative', overflow: 'hidden', minHeight: 300, display: 'block', background: 'linear-gradient(160deg, var(--honey-2), var(--app-3) 55%, var(--honey) 140%)' }}>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', paddingBottom: 60 }}>
        <Avatar name={name} src={user?.avatarUrl} size={150} />
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '60px 20px 18px', background: 'linear-gradient(transparent, rgba(37,37,35,.72))', color: 'var(--night-ink)', display: 'flex', alignItems: 'flex-end', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</div>
          <div style={{ fontSize: 12, opacity: 0.8, textTransform: 'capitalize' }}>{title}</div>
        </div>
        {lastPay && (
          <span title="Net pay on your latest payslip" style={{ padding: '7px 12px', borderRadius: 999, border: '1px solid rgba(255,255,255,.4)', background: 'rgba(255,255,255,.12)', fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', backdropFilter: 'blur(6px)' }}>
            {lastPay.currency} <span ref={net} className="num">0</span>
          </span>
        )}
      </div>
    </Link>
  )
}

// ─── Hours over the last 7 days ──────────────────────────────────────────────
function ProgressCard({ days, today }: { days: any[]; today: string }) {
  const week = Array.from({ length: 7 }, (_, i) => addDays(today, i - 6)).map((d) => {
    const rec = days.find((x) => x.date === d)
    return { date: d, hours: rec?.record?.workedHours ?? 0, status: rec?.status ?? 'no_record', weekend: [0, 6].includes(utc(d).getUTCDay()) }
  })
  const worked = week.filter((d) => d.hours > 0)
  const avg = worked.length ? worked.reduce((a, b) => a + b.hours, 0) / worked.length : 0
  const avgRef = useCountUp(avg, (v) => v.toFixed(1))
  const max = Math.max(DAY_HOURS + 2, ...week.map((d) => d.hours))
  const [hot, setHot] = useState(6)
  const bars = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (bars.current && !reduced()) gsap.fromTo(bars.current.querySelectorAll('[data-bar]'), { scaleY: 0 }, { scaleY: 1, duration: 0.9, ease: 'back.out(1.6)', stagger: 0.05, delay: 0.35, transformOrigin: '50% 100%', clearProps: 'transform' })
  }, [days.length])
  const h = (n: number) => `${Math.floor(n)}h ${String(Math.round((n % 1) * 60)).padStart(2, '0')}m`
  return (
    <section data-card className="card area-progress" style={{ padding: 22, display: 'flex', flexDirection: 'column' }}>
      <CardHead title="Progress" to="/attendance" />
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginTop: 10 }}>
        <span className="display num" style={{ fontSize: 40 }}><span ref={avgRef}>0</span> h</span>
        <span className="dim" style={{ fontSize: 12, lineHeight: 1.3 }}>Avg. workday<br />last 7 days</span>
      </div>
      <div ref={bars} style={{ flex: 1, display: 'flex', alignItems: 'flex-end', gap: 10, marginTop: 16, minHeight: 130 }} role="img" aria-label={`Hours worked: ${week.map((d) => `${fmt(d.date, { weekday: 'short' })} ${d.hours.toFixed(1)}`).join(', ')}`}>
        {week.map((d, i) => {
          const on = i === hot
          return (
            <div key={d.date} onMouseEnter={() => setHot(i)} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', height: '100%', position: 'relative' }}>
              {on && d.hours > 0 && <span className="pill honey" style={{ position: 'absolute', top: -4, whiteSpace: 'nowrap', zIndex: 1 }}>{h(d.hours)}</span>}
              <div style={{ flex: 1, width: '100%', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', borderLeft: d.hours ? 'none' : '1px dashed var(--line-2)', marginLeft: d.hours ? 0 : '50%' }}>
                {d.hours > 0 && <span data-bar style={{ width: 10, height: `${(d.hours / max) * 88}%`, borderRadius: 8, background: on ? 'var(--honey)' : 'var(--night)', transition: 'background-color .3s' }} />}
              </div>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: d.hours ? 'var(--night)' : 'var(--line-2)', margin: '8px 0 6px' }} />
              <span className="dim" style={{ fontSize: 11 }}>{fmt(d.date, { weekday: 'narrow' })}</span>
            </div>
          )
        })}
      </div>
    </section>
  )
}

// ─── Live time tracker (clock in / out) ──────────────────────────────────────
export function TimeTracker() {
  const { data: t } = useTodayAttendance()
  const clockIn = useClockIn()
  const clockOut = useClockOut()
  const toast = useToast()
  const [now, setNow] = useState(Date.now())
  const ring = useRef<SVGCircleElement>(null)
  const running = !!t?.clockedIn && !t?.clockedOut
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [running])
  const secs = running && t?.checkInTime ? Math.max(0, (now - new Date(t.checkInTime).getTime()) / 1000) : (t?.workedHours ?? 0) * 3600
  const hh = String(Math.floor(secs / 3600)).padStart(2, '0')
  const mm = String(Math.floor((secs % 3600) / 60)).padStart(2, '0')
  const ss = String(Math.floor(secs % 60)).padStart(2, '0')
  const pct = Math.min(100, (secs / (DAY_HOURS * 3600)) * 100)
  useLayoutEffect(() => {
    if (!ring.current) return
    if (reduced()) ring.current.style.strokeDashoffset = String(100 - pct)
    else gsap.to(ring.current, { strokeDashoffset: 100 - pct, duration: 1.2, ease: 'power3.inOut' })
  }, [Math.floor(pct)]) // eslint-disable-line react-hooks/exhaustive-deps

  const where = () => new Promise<{ latitude?: number; longitude?: number }>((res) => {
    if (!navigator.geolocation) return res({})
    navigator.geolocation.getCurrentPosition((p) => res({ latitude: p.coords.latitude, longitude: p.coords.longitude }), () => res({}), { timeout: 5000 })
  })
  const start = async () => {
    try { await clockIn.mutateAsync({ method: 'web', ...(await where()) }); toast('Clocked in. Have a good day!') } catch (e) { toast(errMsg(e), 'error') }
  }
  const stop = async () => {
    try { await clockOut.mutateAsync({ method: 'web', ...(await where()) }); toast('Clocked out. Hours saved to attendance.') } catch (e) { toast(errMsg(e), 'error') }
  }
  const status = t?.clockedOut ? `Done · ${(t.workedHours ?? 0).toFixed(1)} h` : running ? `Since ${new Date(t!.checkInTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Not clocked in'
  const ticks = Array.from({ length: 60 }, (_, i) => { const a = (i / 60) * Math.PI * 2 - Math.PI / 2; const r1 = i % 5 ? 86 : 82; return { x1: 100 + Math.cos(a) * r1, y1: 100 + Math.sin(a) * r1, x2: 100 + Math.cos(a) * 91, y2: 100 + Math.sin(a) * 91 } })
  return (
    <section data-card data-tour="clock" className="card area-timer" style={{ padding: 22, display: 'flex', flexDirection: 'column' }}>
      <CardHead title="Time tracker" to="/attendance" />
      <div style={{ position: 'relative', width: '100%', maxWidth: 220, aspectRatio: '1', margin: '10px auto 4px' }}>
        <svg viewBox="0 0 200 200" style={{ width: '100%', height: '100%' }} aria-hidden="true">
          {ticks.map((k, i) => <line key={i} {...k} stroke="var(--line-2)" strokeWidth={i % 5 ? 1 : 1.6} />)}
          <circle cx="100" cy="100" r="70" fill="none" stroke="var(--well)" strokeWidth="14" />
          <circle ref={ring} cx="100" cy="100" r="70" fill="none" stroke="var(--honey)" strokeWidth="14" strokeLinecap="round" pathLength={100} strokeDasharray="100" strokeDashoffset="100" transform="rotate(-90 100 100)" />
        </svg>
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }} aria-live="off">
          <span className="display num" style={{ fontSize: 40 }}>{hh}:{mm}</span>
          <span className="dim num" style={{ fontSize: 11 }}>{running ? `${ss}s · running` : status}</span>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 'auto' }}>
        <button className="btn btn-primary btn-icon" aria-label="Clock in" title="Clock in" disabled={!!t?.clockedIn || clockIn.isPending} onClick={start}><Icon name="play" size={15} /></button>
        <button className="btn btn-ghost btn-icon" aria-label="Clock out" title="Clock out" disabled={!running || clockOut.isPending} onClick={stop}><Icon name="stop" size={14} /></button>
        <span className="dim" style={{ fontSize: 12, marginLeft: 'auto', textAlign: 'right' }}>{status}</span>
      </div>
    </section>
  )
}

// ─── Tasks (activities assigned to me) ───────────────────────────────────────
const TASK_ICON: Record<string, IconName> = { email: 'mail', call: 'phone', meeting: 'users', 'to-do': 'checkCircle', todo: 'checkCircle', document: 'file', upload: 'file' }
function TasksCard() {
  const qc = useQueryClient()
  const toast = useToast()
  const { data: tasks = [], isLoading } = useQuery({ queryKey: ['my-activities'], queryFn: async () => (await api.get('/activities/mine')).data.data as any[] })
  const [done, setDone] = useState<string[]>([])
  const complete = useMutation({
    mutationFn: (id: string) => api.post(`/activities/${id}/complete`, { doneNote: 'Completed from the dashboard' }),
    onSuccess: () => { toast('Task completed'); setTimeout(() => { qc.invalidateQueries({ queryKey: ['my-activities'] }); qc.invalidateQueries({ queryKey: ['dashboard'] }) }, 900) },
    onError: (e, id) => { setDone((d) => d.filter((x) => x !== id)); toast(errMsg(e), 'error') },
  })
  const today = localToday()
  const weekEnd = addDays(today, 7)
  const overdue = tasks.filter((t) => ymd(new Date(t.dueDate)) < today).length
  const thisWeek = tasks.filter((t) => { const d = ymd(new Date(t.dueDate)); return d >= today && d <= weekEnd }).length
  const later = tasks.length - overdue - thisWeek
  const pct = tasks.length ? Math.round(((tasks.length - overdue) / tasks.length) * 100) : 100
  const pctRef = useCountUp(pct, (v) => `${Math.round(v)}%`)
  const tick = (id: string, el: HTMLElement) => { setDone((d) => [...d, id]); pop(el, 0.4); complete.mutate(id) }
  const phases = [{ label: 'Overdue', n: overdue, tone: 'var(--danger)' }, { label: 'This week', n: thisWeek, tone: 'var(--honey)' }, { label: 'Later', n: later, tone: 'var(--night)' }]
  return (
    <section data-card data-tour="tasks" className="card area-tasks" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ padding: '6px 6px 0', display: 'flex', alignItems: 'baseline' }}>
        <h2 style={{ fontSize: 22, flex: 1 }}>My tasks</h2>
        <span className="display num" style={{ fontSize: 36 }} title="Share of open tasks that are on time"><span ref={pctRef}>0%</span></span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, padding: '0 6px' }}>
        {phases.map((p) => (
          <div key={p.label}>
            <div className="dim num" style={{ fontSize: 11, marginBottom: 4 }}>{p.n}</div>
            <div style={{ height: 30, borderRadius: 10, background: 'var(--well)', overflow: 'hidden', position: 'relative' }}>
              <span style={{ position: 'absolute', inset: 0, background: p.tone, transformOrigin: '0 50%', transform: `scaleX(${tasks.length ? p.n / tasks.length : 0})`, transition: 'transform .9s var(--ease)', opacity: 0.9 }} />
              <span style={{ position: 'relative', fontSize: 11, fontWeight: 600, padding: '0 8px', lineHeight: '30px', color: p.n && p.tone !== 'var(--honey)' ? 'var(--night-ink)' : 'var(--ink)', mixBlendMode: 'normal' }}>{p.label}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="card-night scroll-y" style={{ flex: 1, borderRadius: 22, padding: 16, minHeight: 260, maxHeight: 480 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', marginBottom: 10 }}>
          <span style={{ fontSize: 15, fontWeight: 500, flex: 1 }}>Open tasks</span>
          <span className="display num" style={{ fontSize: 28 }}>{tasks.length}</span>
        </div>
        {isLoading && [0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 40, marginBottom: 10, opacity: 0.15 }} />)}
        {!isLoading && tasks.length === 0 && (
          <div style={{ textAlign: 'center', padding: '40px 10px', color: 'var(--night-dim)', fontSize: 13 }}><Icon name="sparkle" size={22} style={{ color: 'var(--honey)' }} /><div style={{ marginTop: 8 }}>Nothing on your plate. New tasks assigned to you show up here.</div></div>
        )}
        <ul style={{ listStyle: 'none' }}>
          {tasks.map((t) => {
            const isDone = done.includes(t.id)
            const due = ymd(new Date(t.dueDate))
            const late = due < today
            return (
              <li key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 2px', opacity: isDone ? 0.55 : 1, transition: 'opacity .4s' }}>
                <span style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--night-2)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Icon name={TASK_ICON[(t.activityType?.name || '').toLowerCase()] ?? 'checkCircle'} size={15} />
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 13, textDecoration: isDone ? 'line-through' : 'none', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.title}</span>
                  <span style={{ fontSize: 11, color: late ? '#f2a48d' : 'var(--night-dim)' }}>{late ? 'Overdue · ' : ''}{fmt(due, { day: 'numeric', month: 'short' })}</span>
                </span>
                <button aria-label={`Mark "${t.title}" done`} disabled={isDone} onClick={(e) => tick(t.id, e.currentTarget)}
                  style={{ width: 26, height: 26, borderRadius: '50%', border: 'none', background: isDone ? 'var(--honey)' : 'var(--night-2)', color: 'var(--ink)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  {isDone && <Icon name="check" size={14} stroke={2.2} />}
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    </section>
  )
}

// ─── Accordion: balances, payslips, quick actions ────────────────────────────
function AccordionCard({ balances, payslips }: { balances: any[]; payslips: any[] }) {
  const [open, setOpen] = useState<string | null>('balances')
  const sections: { key: string; title: string; body: React.ReactNode }[] = [
    {
      key: 'balances', title: 'Leave balances', body: balances.length ? (
        <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {balances.map((b) => (
            <li key={b.code}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}><span>{b.leaveType}</span><span className="num dim">{b.available} / {b.total}</span></div>
              <div style={{ height: 6, borderRadius: 3, background: 'var(--well)', marginTop: 5, overflow: 'hidden' }}><span style={{ display: 'block', height: '100%', width: `${b.total ? Math.min(100, (b.available / b.total) * 100) : 0}%`, background: 'var(--night)', borderRadius: 3, transition: 'width 1s var(--ease)' }} /></div>
            </li>
          ))}
        </ul>
      ) : <p className="dim" style={{ fontSize: 12 }}>No leave allocated yet.</p>,
    },
    {
      key: 'payslips', title: 'Payslips', body: payslips.length ? (
        <ul style={{ listStyle: 'none' }}>
          {payslips.slice(0, 3).map((p) => (
            <li key={p.id}>
              <Link to={`/payroll/payslips/${p.id}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0' }}>
                <span style={{ width: 34, height: 34, borderRadius: 12, background: 'var(--well)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="file" size={16} /></span>
                <span style={{ flex: 1 }}><span style={{ display: 'block', fontSize: 13 }}>{new Date(p.payrollCycle.payPeriodStart).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })}</span><span className="muted" style={{ fontSize: 11 }}>Net {p.currency} {Number(p.netPay).toLocaleString()}</span></span>
                <Icon name="chevronRight" size={15} className="muted" />
              </Link>
            </li>
          ))}
        </ul>
      ) : <p className="dim" style={{ fontSize: 12 }}>Payslips appear here once payroll is released.</p>,
    },
    {
      key: 'actions', title: 'Quick actions', body: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {([['/leave', 'leaf', 'Apply for leave'], ['/expenses', 'receipt', 'New expense claim'], ['/attendance', 'clock', 'Fix a missed punch'], ['/security', 'lock', 'Turn on two-factor']] as [string, IconName, string][]).map(([to, ic, label]) => (
            <Link key={to} to={to} className="btn btn-ghost btn-sm" style={{ justifyContent: 'flex-start' }}><Icon name={ic} size={14} /> {label}</Link>
          ))}
        </div>
      ),
    },
  ]
  return (
    <section data-card data-tour="balances" className="card area-acc" style={{ padding: '8px 20px' }}>
      {sections.map((s, i) => <AccItem key={s.key} title={s.title} open={open === s.key} last={i === sections.length - 1} onToggle={() => setOpen(open === s.key ? null : s.key)}>{s.body}</AccItem>)}
    </section>
  )
}

function AccItem({ title, open, onToggle, children, last }: { title: string; open: boolean; onToggle: () => void; children: React.ReactNode; last: boolean }) {
  const body = useRef<HTMLDivElement>(null)
  const chev = useRef<HTMLSpanElement>(null)
  const first = useRef(true)
  useLayoutEffect(() => {
    const el = body.current
    if (!el) return
    if (first.current || reduced()) { el.style.height = open ? 'auto' : '0px'; first.current = false; return }
    gsap.to(chev.current, { rotation: open ? 180 : 0, duration: 0.45, ease: 'power3.out' })
    if (open) gsap.fromTo(el, { height: 0 }, { height: 'auto', duration: 0.5, ease: 'power3.out' })
    else gsap.to(el, { height: 0, duration: 0.4, ease: 'power3.inOut' })
    if (open) gsap.fromTo(el.children, { opacity: 0, y: -8 }, { opacity: 1, y: 0, duration: 0.45, delay: 0.08, ease: 'power3.out', clearProps: 'opacity,transform' })
  }, [open])
  return (
    <div style={{ borderBottom: last ? 'none' : '1px solid var(--line)' }}>
      <button onClick={onToggle} aria-expanded={open} style={{ display: 'flex', width: '100%', alignItems: 'center', padding: '14px 0', border: 'none', background: 'none', fontSize: 14, fontWeight: 500, textAlign: 'left' }}>
        <span style={{ flex: 1 }}>{title}</span>
        <span ref={chev} style={{ display: 'inline-flex', transform: open ? 'rotate(180deg)' : undefined }}><Icon name="chevronDown" size={16} /></span>
      </button>
      <div ref={body} style={{ overflow: 'hidden', height: 0 }}><div style={{ paddingBottom: 14 }}>{children}</div></div>
    </div>
  )
}

// ─── Week of leave (mine + my team) ──────────────────────────────────────────
function WeekCard({ isManager }: { isManager: boolean }) {
  const { user } = useAuth()
  const today = localToday()
  const [start, setStart] = useState(mondayOf(today))
  const dir = useRef(0)
  const end = addDays(start, 6)
  const mine = useQuery({ queryKey: ['leave-requests-me', 'week'], queryFn: async () => (await api.get('/leave/requests/me', { params: { limit: 100 } })).data.data })
  const team = useQuery({ queryKey: ['leave-team-week', start], enabled: isManager, queryFn: async () => (await api.get('/leave/calendar/team', { params: { startDate: start, endDate: end } })).data.data as any[] })
  const myList: any[] = Array.isArray(mine.data) ? mine.data : mine.data?.items ?? mine.data?.data ?? []
  const events = [
    ...myList.filter((r) => ['approved', 'pending'].includes(r.status)).map((r) => ({ id: r.id, who: 'You', name: user?.fullName || 'You', type: r.leaveType?.name, start: ymd(new Date(r.startDate)), end: ymd(new Date(r.endDate)), pending: r.status === 'pending', mine: true })),
    ...(team.data ?? []).map((r) => ({ id: r.id, who: r.employee?.user?.fullName?.split(' ')[0], name: r.employee?.user?.fullName, type: r.leaveType?.name, start: ymd(new Date(r.startDate)), end: ymd(new Date(r.endDate)), pending: false, mine: false })),
  ].filter((e) => e.start <= end && e.end >= start)
  const days = Array.from({ length: 6 }, (_, i) => addDays(start, i))
  const grid = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!grid.current || reduced()) return
    gsap.fromTo(grid.current.querySelectorAll('[data-day]'), { x: dir.current * 26, opacity: 0 }, { x: 0, opacity: 1, duration: 0.5, stagger: 0.035, ease: 'power3.out', clearProps: 'opacity,transform' })
    gsap.fromTo(grid.current.querySelectorAll('[data-ev]'), { opacity: 0, y: 14, scale: 0.94 }, { opacity: 1, y: 0, scale: 1, duration: 0.6, stagger: 0.06, delay: 0.15, ease: 'back.out(1.7)', clearProps: 'opacity,transform' })
  }, [start, events.length])
  const move = (n: number) => { dir.current = n; setStart(addDays(start, n * 7)) }
  return (
    <section data-card data-tour="week" className="card area-week" style={{ padding: 20, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button className="btn btn-ghost btn-sm" onClick={() => move(-1)} aria-label="Previous week"><Icon name="chevronLeft" size={14} /> {fmt(addDays(start, -7), { day: 'numeric', month: 'short' })}</button>
        <h2 style={{ flex: 1, textAlign: 'center', fontSize: 18 }}>{fmt(start, { day: 'numeric', month: 'short' })} – {fmt(addDays(start, 5), { day: 'numeric', month: 'short' })}</h2>
        {start !== mondayOf(today) && <button className="link" onClick={() => { dir.current = start > today ? -1 : 1; setStart(mondayOf(today)) }}>Today</button>}
        <button className="btn btn-ghost btn-sm" onClick={() => move(1)} aria-label="Next week">{fmt(addDays(start, 7), { day: 'numeric', month: 'short' })} <Icon name="chevronRight" size={14} /></button>
      </div>
      <div ref={grid} style={{ display: 'grid', gridTemplateColumns: 'repeat(6, minmax(0, 1fr))', gap: 6, marginTop: 14, flex: 1, minHeight: 190 }}>
        {days.map((d) => {
          const isToday = d === today
          const dayEvents = events.filter((e) => e.start <= d && e.end >= d)
          return (
            <div key={d} data-day style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', borderLeft: '1px solid var(--line)', paddingLeft: 6, minWidth: 0 }}>
              <div style={{ textAlign: 'center', marginBottom: 10 }}>
                <div className="dim" style={{ fontSize: 11 }}>{fmt(d, { weekday: 'short' })}</div>
                <div className="display num" style={{ fontSize: 18, width: 34, height: 34, lineHeight: '34px', margin: '2px auto 0', borderRadius: '50%', background: isToday ? 'var(--night)' : 'transparent', color: isToday ? 'var(--night-ink)' : 'var(--dim)' }}>{utc(d).getUTCDate()}</div>
              </div>
              {dayEvents.map((e) => (
                <div key={e.id + d} data-ev title={`${e.name} · ${e.type}${e.pending ? ' (pending)' : ''}`} style={{ borderRadius: 12, padding: '6px 8px', marginBottom: 6, fontSize: 11.5, lineHeight: 1.3, background: e.mine ? (e.pending ? 'var(--card-2)' : 'var(--night)') : 'var(--honey-2)', color: e.mine && !e.pending ? 'var(--night-ink)' : 'var(--ink)', border: e.pending ? '1px dashed var(--line-2)' : '1px solid transparent', overflow: 'hidden' }}>
                  <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.who}</div>
                  <div style={{ opacity: 0.75, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.type}{e.pending ? ' · pending' : ''}</div>
                </div>
              ))}
            </div>
          )
        })}
      </div>
      {events.length === 0 && <p className="dim" style={{ fontSize: 12, textAlign: 'center', marginTop: 6 }}>No leave {isManager ? 'for you or your team ' : ''}this week.</p>}
    </section>
  )
}

function CardHead({ title, to }: { title: string; to: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center' }}>
      <h2 style={{ fontSize: 20, flex: 1 }}>{title}</h2>
      <Link to={to} aria-label={`Open ${title}`} className="btn btn-ghost btn-icon" style={{ width: 34, height: 34 }} onMouseEnter={(e) => { if (!reduced()) gsap.fromTo(e.currentTarget.firstChild, { x: -3, y: 3 }, { x: 0, y: 0, duration: 0.4, ease: 'back.out(2)' }) }}><Icon name="arrowUpRight" size={15} /></Link>
    </div>
  )
}

// People without an employee record (e.g. finance) get a launcher instead of personal widgets
function StaffHome() {
  const links: [string, IconName, string, string][] = [
    ['/payroll', 'wallet', 'Payroll', 'Cycles, approvals, bank file and GL export'],
    ['/expenses', 'receipt', 'Expenses', 'Finance approval and reimbursement'],
    ['/compensation', 'sliders', 'Compensation', 'Structures, rules and grade bands'],
    ['/attendance', 'clock', 'Attendance', 'Lock attendance before payroll'],
  ]
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 'var(--gap)', marginTop: 24 }}>
      {links.map(([to, ic, t, b]) => (
        <Link key={to} to={to} data-card className="card lift" style={{ padding: 22 }}>
          <span style={{ width: 44, height: 44, borderRadius: '50%', background: 'var(--honey)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><Icon name={ic} size={20} /></span>
          <h2 style={{ fontSize: 22, marginTop: 16 }}>{t}</h2>
          <p className="dim" style={{ fontSize: 13, marginTop: 4 }}>{b}</p>
        </Link>
      ))}
    </div>
  )
}
