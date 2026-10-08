import { useLayoutEffect, useRef, useState } from 'react'
import { useMyAttendanceCalendar } from '../../lib/hooks/useAttendance'
import { gsap, reduced, useCountUp } from '../../lib/motion'
import Icon from '../../components/ui/Icon'
import { fmtHours } from '../../lib/format'

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const CHIP: Record<string, { cls: string; label?: string }> = {
  present: { cls: 'honey' }, half_day: { cls: 'warn', label: 'Half day' }, absent: { cls: 'danger', label: 'Absent' }, lwp: { cls: 'danger', label: 'LWP' },
  on_leave: { cls: 'mute', label: 'Leave' }, holiday: { cls: 'info', label: 'Holiday' },
}

// Month of attendance as day tiles (hours chip per day), like a timesheet
export default function AttendanceCalendarView() {
  const now = new Date()
  const [ym, setYm] = useState({ y: now.getFullYear(), m: now.getMonth() + 1 })
  const dir = useRef(0)
  const { data, isLoading } = useMyAttendanceCalendar(ym.y, ym.m)
  const calendar: any[] = data?.calendar || []
  const sum = data?.summary
  const hours = useCountUp(sum?.totalWorkedHours ?? 0, fmtHours)
  const offset = (new Date(Date.UTC(ym.y, ym.m - 1, 1)).getUTCDay() + 6) % 7
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  // Working days so far: weekdays up to today that aren't holidays (future days are neither present nor absent)
  const working = calendar.filter((d) => !d.isWeekend && d.status !== 'holiday' && d.date <= todayStr).length
  const pctOf = (n: number) => (working ? Math.min(100, Math.round(((n || 0) / working) * 100)) : 0)
  // Attendance rate: present days + half days at 0.5, over working days so far
  const rate = sum ? pctOf(sum.present + sum.halfDay * 0.5) : 0
  const grid = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!grid.current || reduced() || isLoading) return
    gsap.fromTo(grid.current.querySelectorAll('[data-day]'), { opacity: 0, scale: 0.9, x: dir.current * 18 }, { opacity: 1, scale: 1, x: 0, duration: 0.45, ease: 'power3.out', stagger: { each: 0.012 }, clearProps: 'opacity,transform' })
    gsap.fromTo(grid.current.querySelectorAll('[data-chip]'), { scale: 0.4, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.45, delay: 0.25, ease: 'back.out(2.4)', stagger: 0.015, clearProps: 'opacity,transform' })
  }, [ym.y, ym.m, isLoading])

  const shift = (n: number) => {
    dir.current = n
    setYm(({ y, m }) => { const d = new Date(Date.UTC(y, m - 1 + n, 1)); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 } })
  }
  const monthLabel = new Date(Date.UTC(ym.y, ym.m - 1, 1)).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })

  return (
    <section data-card className="card" style={{ padding: 22 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <span className="display num" style={{ fontSize: 40 }}><span ref={hours}>00:00:00</span></span>
        <span className="dim" style={{ fontSize: 13 }}>{sum ? `${sum.present} present · ${fmtHours(sum.totalOvertimeHours)} overtime` : ''}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          <button className="btn btn-ghost btn-icon btn-sm" style={{ width: 30 }} onClick={() => shift(-1)} aria-label="Previous month"><Icon name="chevronLeft" size={14} /></button>
          <span className="btn btn-ghost btn-sm" style={{ pointerEvents: 'none', minWidth: 130 }}>{monthLabel}</span>
          <button className="btn btn-ghost btn-icon btn-sm" style={{ width: 30 }} onClick={() => shift(1)} aria-label="Next month"><Icon name="chevronRight" size={14} /></button>
        </div>
      </div>

      {sum && (
        <div className="att-sum" title="Present = (present days + half days × 0.5) ÷ working days so far (weekdays up to today, holidays excluded)">
          <Bar label="Present" value={working ? `${rate}%` : '—'} pct={rate} cls="honey" />
          <Bar label="Half day" value={String(sum.halfDay)} pct={pctOf(sum.halfDay)} cls="night" />
          <Bar label="Absent" value={String(sum.absent)} pct={pctOf(sum.absent)} cls="danger" />
          <Bar label="Leave" value={String(sum.onLeave)} pct={pctOf(sum.onLeave)} cls="stripes" />
        </div>
      )}
      {sum && <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>{working ? `Out of ${working} working day${working === 1 ? '' : 's'} so far · half days count as ½` : 'No working days yet this month'}</div>}

      <div className="cal-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 8, marginTop: 18 }}>
        {DAYS.map((d) => <div key={d} className="dim" style={{ fontSize: 12, textAlign: 'center' }}>{d}</div>)}
      </div>
      <div ref={grid} className="cal-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 8, marginTop: 8 }}>
        {Array.from({ length: offset }, (_, i) => <div key={`pad${i}`} />)}
        {isLoading && Array.from({ length: 28 }, (_, i) => <div key={i} className="skeleton" style={{ height: 64, borderRadius: 14 }} />)}
        {!isLoading && calendar.map((d) => {
          const h = d.record?.workedHours
          const chip = CHIP[d.status]
          const isToday = d.date === todayStr
          return (
            <div key={d.date} data-day className="cal-day" style={{ border: isToday ? '1.5px solid var(--night)' : '1px solid var(--line)', background: d.isWeekend ? 'transparent' : 'var(--card-2)' }}>
              <span className="dim num" style={{ fontSize: 12 }}>{Number(d.date.slice(8))}</span>
              {chip && (h ? (
                // Phones get H:MM (full HH:MM:SS in the tooltip); a status without hours shrinks to its coloured dot
                <span data-chip className={`pill ${chip.cls} cal-chip`} title={`Worked ${fmtHours(h)}`}><span className="cal-full">{fmtHours(h)}</span><span className="cal-short">{fmtHours(h).replace(/^0?(\d+:\d\d):\d\d$/, '$1')}</span></span>
              ) : (
                <span data-chip className={`pill ${chip.cls} cal-chip`} title={chip.label ?? d.status} aria-label={chip.label ?? d.status}><span className="cal-full">{chip.label ?? d.status}</span></span>
              ))}
            </div>
          )
        })}
      </div>
    </section>
  )
}

// Label and value on top, a slim track below whose fill is the value's share of working days so far
function Bar({ label, value, pct, cls }: { label: string; value: string; pct: number; cls: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'baseline', columnGap: 6, marginBottom: 6 }}>
        <span className="dim" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{label}</span>
        <span className="num" style={{ fontSize: 14, fontWeight: 600 }}>{value}</span>
      </div>
      <div className="att-track"><span className={`att-fill ${cls}`} style={{ width: `${pct}%` }} /></div>
    </div>
  )
}
