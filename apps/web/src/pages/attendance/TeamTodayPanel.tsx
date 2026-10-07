import { useTeamAttendanceToday } from '../../lib/hooks/useAttendance'
import Badge from '../../components/ui/Badge'

export default function TeamTodayPanel() {
  const { data: records = [], isLoading } = useTeamAttendanceToday()

  const formatTime = (iso: string | null) =>
    iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'

  if (isLoading) return <div style={{ color: 'var(--faint)', fontSize: '13px' }}>Loading team attendance...</div>

  if (records.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '40px', color: 'var(--faint)', fontSize: '13px' }}>
        No attendance records found for today.
      </div>
    )
  }

  const present = records.filter((r: any) => r.status === 'present').length
  const absent = records.filter((r: any) => r.status === 'absent').length
  const onLeave = records.filter((r: any) => r.status === 'on_leave').length

  return (
    <div>
      <div style={s.statRow}>
        <div style={s.statPill}>✅ {present} Present</div>
        <div style={{ ...s.statPill, backgroundColor: 'var(--danger-bg)', color: 'var(--danger)' }}>⚠ {absent} Absent</div>
        {onLeave > 0 && <div style={{ ...s.statPill, backgroundColor: 'var(--honey-soft)', color: 'var(--brand)' }}>🌿 {onLeave} On Leave</div>}
      </div>

      <div style={s.table}>
        <div style={s.headerRow}>
          <div style={{ ...s.col, flex: 2 }}>Employee</div>
          <div style={s.col}>Clock In</div>
          <div style={s.col}>Clock Out</div>
          <div style={s.col}>Hours</div>
          <div style={s.col}>Status</div>
        </div>
        {records.map((rec: any) => (
          <div key={rec.id} style={s.row}>
            <div style={{ ...s.col, flex: 2, display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={s.avatar}>{rec.employee?.user?.fullName?.charAt(0)}</div>
              <div>
                <div style={{ fontSize: '13px', fontWeight: '500', color: 'var(--ink)' }}>{rec.employee?.user?.fullName}</div>
                <div style={{ fontSize: '11px', color: 'var(--faint)' }}>{rec.employee?.jobPosition?.title || rec.employee?.orgUnit?.name}</div>
              </div>
            </div>
            <div style={s.col}>{formatTime(rec.checkInTime)}</div>
            <div style={s.col}>{formatTime(rec.checkOutTime)}</div>
            <div style={s.col}>{rec.workedHours ? `${rec.workedHours.toFixed(1)}h` : '—'}</div>
            <div style={s.col}><Badge label={rec.status} /></div>
          </div>
        ))}
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  statRow: { display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' },
  statPill: { padding: '6px 14px', borderRadius: '20px', fontSize: '13px', fontWeight: '500', backgroundColor: 'var(--ok-bg)', color: 'var(--ok)' },
  table: { backgroundColor: 'var(--card)', backdropFilter: 'blur(18px)', border: '1px solid var(--hair)', boxShadow: 'var(--shadow)', borderRadius: 'var(--r-card)', overflow: 'hidden' },
  headerRow: { display: 'flex', padding: '10px 16px', backgroundColor: 'var(--solid)', borderBottom: '1px solid var(--line)', gap: '12px' },
  row: { display: 'flex', padding: '12px 16px', borderBottom: '1px solid var(--well)', alignItems: 'center', gap: '12px' },
  col: { flex: 1, fontSize: '13px', color: 'var(--ink)' },
  avatar: { width: '28px', height: '28px', borderRadius: '50%', backgroundColor: 'var(--honey-soft)', color: 'var(--brand)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: '600', flexShrink: 0 },
}
