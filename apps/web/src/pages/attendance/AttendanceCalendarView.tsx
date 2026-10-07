import { useLayoutEffect, useRef, useState } from 'react'
import { useMyAttendanceCalendar } from '../../lib/hooks/useAttendance'
import { gsap, reduced, useCountUp } from '../../lib/motion'
import Icon from '../../components/ui/Icon'

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
  const hours = useCountUp(sum?.totalWorkedHours ?? 0, (v) => v.toFixed(1))
  const offset = (new Date(Date.UTC(ym.y, ym.m - 1, 1)).getUTCDay() + 6) % 7
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const working = calendar.filter((d) => !d.isWeekend).length || 1
  const share = (n: number) => `${Math.round(((n || 0) / working) * 100)}%`
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
        <span className="display num" style={{ fontSize: 40 }}><span ref={hours}>0</span><span className="dim" style={{ fontSize: 16 }}> hrs</span></span>
        <span className="dim" style={{ fontSize: 13 }}>{sum ? `${sum.present} present · ${(sum.totalOvertimeHours || 0).toFixed(1)} h overtime` : ''}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          <button className="btn btn-ghost btn-icon btn-sm" style={{ width: 30 }} onClick={() => shift(-1)} aria-label="Previous month"><Icon name="chevronLeft" size={14} /></button>
          <span className="btn btn-ghost btn-sm" style={{ pointerEvents: 'none', minWidth: 130 }}>{monthLabel}</span>
          <button className="btn btn-ghost btn-icon btn-sm" style={{ width: 30 }} onClick={() => shift(1)} aria-label="Next month"><Icon name="chevronRight" size={14} /></button>
        </div>
      </div>

      {sum && (
        <div style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'flex-end' }}>
          <Bar label="Present" w={sum.present} cls="honey" text={share(sum.present)} grow={Math.max(sum.present, 3)} />
          <Bar label="Half day" w={sum.halfDay} cls="night" text={String(sum.halfDay)} grow={Math.max(sum.halfDay, 1.2)} />
          <Bar label="Absent" w={sum.absent} cls="outline" text={String(sum.absent)} grow={Math.max(sum.absent, 1.2)} />
          <Bar label="Leave" w={sum.onLeave} cls="stripes" text={String(sum.onLeave)} grow={Math.max(sum.onLeave, 1.2)} />
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 8, marginTop: 18 }}>
        {DAYS.map((d) => <div key={d} className="dim" style={{ fontSize: 12, textAlign: 'center' }}>{d}</div>)}
      </div>
      <div ref={grid} style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 8, marginTop: 8 }}>
        {Array.from({ length: offset }, (_, i) => <div key={`pad${i}`} />)}
        {isLoading && Array.from({ length: 28 }, (_, i) => <div key={i} className="skeleton" style={{ height: 64, borderRadius: 14 }} />)}
        {!isLoading && calendar.map((d) => {
          const h = d.record?.workedHours
          const chip = CHIP[d.status]
          const isToday = d.date === todayStr
          return (
            <div key={d.date} data-day style={{ minHeight: 64, borderRadius: 14, padding: '7px 9px', border: isToday ? '1.5px solid var(--night)' : '1px solid var(--line)', background: d.isWeekend ? 'transparent' : 'var(--card-2)', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
              <span className="dim num" style={{ fontSize: 12 }}>{Number(d.date.slice(8))}</span>
              {chip && (h ? <span data-chip className={`pill ${chip.cls}`} style={{ alignSelf: 'flex-start' }}>{h.toFixed(1)}h</span> : <span data-chip className={`pill ${chip.cls}`} style={{ alignSelf: 'flex-start' }}>{chip.label ?? d.status}</span>)}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function Bar({ label, cls, text, grow }: { label: string; w: number; cls: string; text: string; grow: number }) {
  return (
    <div style={{ flex: grow, minWidth: 64 }}>
      <div className="dim" style={{ fontSize: 11, marginBottom: 5 }}>{label}</div>
      <div className={`seg ${cls}`} style={cls === 'stripes' ? { animation: 'stripes 3.2s linear infinite', backgroundSize: '22px 22px' } : undefined}>{text}</div>
    </div>
  )
}
