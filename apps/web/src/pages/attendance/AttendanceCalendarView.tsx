import { useState } from 'react'
import { useMyAttendanceCalendar } from '../../lib/hooks/useAttendance'

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']

const STATUS_STYLE: Record<string, { bg: string; color: string; label: string }> = {
  present:    { bg: '#e1f5ee', color: '#0F6E56', label: 'Present' },
  half_day:   { bg: '#faeeda', color: '#BA7517', label: 'Half Day' },
  absent:     { bg: '#faece7', color: '#993C1D', label: 'Absent' },
  lwp:        { bg: '#faece7', color: '#993C1D', label: 'LWP' },
  on_leave:   { bg: '#eeedfe', color: '#534AB7', label: 'On Leave' },
  holiday:    { bg: '#e6f1fb', color: '#185FA5', label: 'Holiday' },
  week_off:   { bg: '#f5f4f0', color: '#8c8c88', label: 'Week Off' },
  no_record:  { bg: '#fff', color: '#ccc9c1', label: '—' },
}

export default function AttendanceCalendarView() {
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)

  const { data, isLoading } = useMyAttendanceCalendar(year, month)
  const calendar = data?.calendar || []
  const summary = data?.summary

  const daysInMonth = new Date(year, month, 0).getDate()
  const firstDay = new Date(year, month - 1, 1).getDay()
  const offset = firstDay === 0 ? 6 : firstDay - 1

  const prevMonth = () => {
    if (month === 1) { setMonth(12); setYear(y => y - 1) } else setMonth(m => m - 1)
  }
  const nextMonth = () => {
    if (month === 12) { setMonth(1); setYear(y => y + 1) } else setMonth(m => m + 1)
  }

  const getDay = (day: number) => calendar.find((d: any) => {
    return Number(d.date.slice(8, 10)) === day
  })

  return (
    <div>
      {summary && (
        <div style={s.summaryRow}>
          {[
            { label: 'Present', value: summary.present, color: '#0F6E56' },
            { label: 'Absent', value: summary.absent, color: '#993C1D' },
            { label: 'Half Day', value: summary.halfDay, color: '#BA7517' },
            { label: 'On Leave', value: summary.onLeave, color: '#534AB7' },
            { label: 'Hours Worked', value: `${(summary.totalWorkedHours || 0).toFixed(1)}h`, color: '#1a1a18' },
            { label: 'Overtime', value: `${(summary.totalOvertimeHours || 0).toFixed(1)}h`, color: '#185FA5' },
          ].map((item) => (
            <div key={item.label} style={s.summaryCard}>
              <div style={{ ...s.summaryNum, color: item.color }}>{item.value}</div>
              <div style={s.summaryLabel}>{item.label}</div>
            </div>
          ))}
        </div>
      )}

      <div style={s.calCard}>
        <div style={s.calHeader}>
          <button style={s.navBtn} onClick={prevMonth}>←</button>
          <span style={s.monthLabel}>{MONTHS[month - 1]} {year}</span>
          <button style={s.navBtn} onClick={nextMonth}>→</button>
        </div>

        <div style={s.dayHeaders}>
          {DAYS.map(d => <div key={d} style={s.dayHeader}>{d}</div>)}
        </div>

        {isLoading ? (
          <div style={{ padding: '40px', textAlign: 'center', color: '#8c8c88', fontSize: '13px' }}>Loading...</div>
        ) : (
          <div style={s.grid}>
            {Array.from({ length: offset }).map((_, i) => (
              <div key={`e${i}`} style={s.emptyCell} />
            ))}
            {Array.from({ length: daysInMonth }).map((_, i) => {
              const day = i + 1
              const entry = getDay(day)
              const status = entry?.status || 'no_record'
              const ss = STATUS_STYLE[status] || STATUS_STYLE.no_record
              const isToday = day === now.getDate() && month === now.getMonth() + 1 && year === now.getFullYear()
              const record = entry?.record

              return (
                <div key={day} style={{
                  ...s.cell,
                  backgroundColor: ss.bg,
                  ...(isToday ? s.todayCell : {}),
                }}>
                  <div style={{ ...s.dayNum, ...(isToday ? s.todayNum : {}), color: isToday ? '#534AB7' : ss.color }}>
                    {day}
                  </div>
                  <div style={{ ...s.statusLabel, color: ss.color }}>{ss.label}</div>
                  {record?.workedHours != null && record.workedHours > 0 && (
                    <div style={s.hours}>{record.workedHours.toFixed(1)}h</div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        <div style={s.legend}>
          {Object.entries(STATUS_STYLE).filter(([k]) => k !== 'no_record').map(([key, val]) => (
            <div key={key} style={s.legendItem}>
              <div style={{ width: '10px', height: '10px', borderRadius: '2px', backgroundColor: val.bg, border: `0.5px solid ${val.color}`, flexShrink: 0 }} />
              <span style={{ fontSize: '11px', color: '#5c5c58' }}>{val.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  summaryRow: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: '10px', marginBottom: '16px' },
  summaryCard: { backgroundColor: '#fff', border: '0.5px solid #e2e0da', borderRadius: '8px', padding: '12px', textAlign: 'center' },
  summaryNum: { fontSize: '22px', fontWeight: '500', lineHeight: 1, marginBottom: '4px' },
  summaryLabel: { fontSize: '11px', color: '#8c8c88' },
  calCard: { backgroundColor: '#fff', border: '0.5px solid #e2e0da', borderRadius: '10px', overflow: 'hidden' },
  calHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: '0.5px solid #e2e0da' },
  navBtn: { background: 'none', border: '0.5px solid #e2e0da', borderRadius: '6px', padding: '6px 12px', cursor: 'pointer', fontSize: '14px', color: '#1a1a18' },
  monthLabel: { fontSize: '14px', fontWeight: '500', color: '#1a1a18' },
  dayHeaders: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', backgroundColor: '#f9f8f6', borderBottom: '0.5px solid #e2e0da' },
  dayHeader: { padding: '8px 4px', textAlign: 'center', fontSize: '11px', fontWeight: '500', color: '#8c8c88' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)' },
  emptyCell: { minHeight: '64px', backgroundColor: '#fafaf9', borderRight: '0.5px solid #f5f4f0', borderBottom: '0.5px solid #f5f4f0' },
  cell: { minHeight: '64px', padding: '6px 8px', borderRight: '0.5px solid rgba(0,0,0,0.04)', borderBottom: '0.5px solid rgba(0,0,0,0.04)', display: 'flex', flexDirection: 'column', gap: '2px' },
  todayCell: { outline: '2px solid #534AB7', outlineOffset: '-2px', zIndex: 1, position: 'relative' },
  dayNum: { fontSize: '12px', fontWeight: '400' },
  todayNum: { fontWeight: '700' },
  statusLabel: { fontSize: '10px', fontWeight: '500' },
  hours: { fontSize: '10px', color: '#8c8c88' },
  legend: { display: 'flex', flexWrap: 'wrap', gap: '10px', padding: '10px 14px', borderTop: '0.5px solid #e2e0da', backgroundColor: '#f9f8f6' },
  legendItem: { display: 'flex', alignItems: 'center', gap: '5px' },
}
