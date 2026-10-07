import { useState } from 'react'
import { useTeamLeaveCalendar } from '../../lib/hooks/useLeave'

function getMonthRange(year: number, month: number) {
  const start = new Date(year, month - 1, 1).toISOString().split('T')[0]
  const end = new Date(year, month, 0).toISOString().split('T')[0]
  return { start, end }
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']

export default function TeamLeaveCalendar() {
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)

  const { start, end } = getMonthRange(year, month)
  const { data: leaves = [], isLoading } = useTeamLeaveCalendar(start, end)

  const daysInMonth = new Date(year, month, 0).getDate()
  const firstDay = new Date(year, month - 1, 1).getDay()
  const offset = firstDay === 0 ? 6 : firstDay - 1

  const prevMonth = () => {
    if (month === 1) { setMonth(12); setYear(y => y - 1) }
    else setMonth(m => m - 1)
  }
  const nextMonth = () => {
    if (month === 12) { setMonth(1); setYear(y => y + 1) }
    else setMonth(m => m + 1)
  }

  const getLeavesForDay = (day: number) => {
    const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`
    return leaves.filter((l: any) => {
      const s = l.startDate.split('T')[0]
      const e = l.endDate.split('T')[0]
      return dateStr >= s && dateStr <= e
    })
  }

  return (
    <div style={s.root}>
      <div style={s.header}>
        <button style={s.navBtn} onClick={prevMonth}>←</button>
        <span style={s.monthLabel}>{MONTHS[month - 1]} {year}</span>
        <button style={s.navBtn} onClick={nextMonth}>→</button>
      </div>

      <div style={s.dayHeaders}>
        {DAYS.map(d => <div key={d} style={s.dayHeader}>{d}</div>)}
      </div>

      <div style={s.grid}>
        {Array.from({ length: offset }).map((_, i) => (
          <div key={`empty-${i}`} style={s.emptyCell} />
        ))}
        {Array.from({ length: daysInMonth }).map((_, i) => {
          const day = i + 1
          const dayLeaves = getLeavesForDay(day)
          const isToday = day === now.getDate() && month === now.getMonth() + 1 && year === now.getFullYear()
          const dow = new Date(year, month - 1, day).getDay()
          const isWeekend = dow === 0 || dow === 6

          return (
            <div key={day} style={{
              ...s.cell,
              ...(isToday ? s.todayCell : {}),
              ...(isWeekend ? s.weekendCell : {}),
            }}>
              <div style={{ ...s.dayNum, ...(isToday ? s.todayNum : {}) }}>{day}</div>
              {dayLeaves.slice(0, 2).map((l: any) => (
                <div key={l.id} style={s.leaveChip} title={`${l.employee?.user?.fullName} — ${l.leaveType?.name}`}>
                  {l.employee?.user?.fullName?.split(' ')[0]}
                </div>
              ))}
              {dayLeaves.length > 2 && (
                <div style={s.moreChip}>+{dayLeaves.length - 2}</div>
              )}
            </div>
          )
        })}
      </div>

      {isLoading && <div style={{ textAlign: 'center', color: '#8c8c88', fontSize: '13px', padding: '12px' }}>Loading...</div>}

      {leaves.length > 0 && (
        <div style={s.legend}>
          <div style={s.legendTitle}>Team on leave this month</div>
          {Array.from(new Set(leaves.map((l: any) => l.employee?.user?.fullName))).map((name: any) => (
            <span key={name} style={s.legendItem}>{name}</span>
          ))}
        </div>
      )}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  root: { backgroundColor: '#fff', border: '0.5px solid #e2e0da', borderRadius: '10px', overflow: 'hidden' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: '0.5px solid #e2e0da' },
  navBtn: { background: 'none', border: '0.5px solid #e2e0da', borderRadius: '6px', padding: '6px 12px', cursor: 'pointer', fontSize: '14px', color: '#1a1a18' },
  monthLabel: { fontSize: '14px', fontWeight: '500', color: '#1a1a18' },
  dayHeaders: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', backgroundColor: '#f9f8f6', borderBottom: '0.5px solid #e2e0da' },
  dayHeader: { padding: '8px 4px', textAlign: 'center', fontSize: '11px', fontWeight: '500', color: '#8c8c88' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)' },
  cell: { minHeight: '72px', padding: '6px', borderRight: '0.5px solid #f5f4f0', borderBottom: '0.5px solid #f5f4f0', overflow: 'hidden' },
  emptyCell: { minHeight: '72px', backgroundColor: '#fafaf9' },
  todayCell: { backgroundColor: '#f0effe' },
  weekendCell: { backgroundColor: '#fafaf9' },
  dayNum: { fontSize: '12px', color: '#5c5c58', marginBottom: '4px', fontWeight: '400' },
  todayNum: { fontWeight: '600', color: '#534AB7' },
  leaveChip: { fontSize: '10px', backgroundColor: '#eeedfe', color: '#534AB7', borderRadius: '3px', padding: '1px 4px', marginBottom: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'default' },
  moreChip: { fontSize: '10px', color: '#8c8c88', padding: '1px 4px' },
  legend: { padding: '12px 16px', borderTop: '0.5px solid #e2e0da', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  legendTitle: { fontSize: '11px', color: '#8c8c88', fontWeight: '500' },
  legendItem: { fontSize: '12px', backgroundColor: '#eeedfe', color: '#534AB7', padding: '2px 10px', borderRadius: '12px' },
}
