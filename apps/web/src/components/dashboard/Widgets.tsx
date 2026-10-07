import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import { useTodayAttendance, useClockIn, useClockOut } from '../../lib/hooks/useAttendance'
import { useCountUp, gsap, reduced, pop } from '../../lib/motion'
import { useToast } from '../ui/Toast'
import Icon, { type IconName } from '../ui/Icon'

// Dashboard widgets shared by the dashboard and the attendance page
const ymd = (d: Date) => d.toISOString().slice(0, 10)
const utc = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00Z`)
const addDays = (s: string, n: number) => ymd(new Date(utc(s).getTime() + n * 86400000))
const localToday = () => { const d = new Date(); return ymd(new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))) }
const fmt = (s: string, o: Intl.DateTimeFormatOptions) => utc(s).toLocaleDateString(undefined, { timeZone: 'UTC', ...o })
const DAY_HOURS = 8
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'

// ─── Live time tracker (clock in / out) ──────────────────────────────────────
export function TimeTracker({ className = '' }: { className?: string }) {
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
    <section data-card data-tour="clock" className={`card ${className}`} style={{ padding: 22, display: 'flex', flexDirection: 'column' }}>
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
export function TasksCard({ className = '' }: { className?: string }) {
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
    <section data-card data-tour="tasks" className={`card ${className}`} style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
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

export function CardHead({ title, to }: { title: string; to: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center' }}>
      <h2 style={{ fontSize: 20, flex: 1 }}>{title}</h2>
      <Link to={to} aria-label={`Open ${title}`} className="btn btn-ghost btn-icon" style={{ width: 34, height: 34 }} onMouseEnter={(e) => { if (!reduced()) gsap.fromTo(e.currentTarget.firstChild, { x: -3, y: 3 }, { x: 0, y: 0, duration: 0.4, ease: 'back.out(2)' }) }}><Icon name="arrowUpRight" size={15} /></Link>
    </div>
  )
}

