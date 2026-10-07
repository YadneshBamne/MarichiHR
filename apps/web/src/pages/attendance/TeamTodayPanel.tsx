import { useTeamAttendanceToday } from '../../lib/hooks/useAttendance'
import Badge from '../../components/ui/Badge'

export default function TeamTodayPanel() {
  const { data: records = [], isLoading } = useTeamAttendanceToday()

  const formatTime = (iso: string | null) =>
    iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'

  if (isLoading) return <div style={{ color: '#8c8c88', fontSize: '13px' }}>Loading team attendance...</div>

  if (records.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '40px', color: '#8c8c88', fontSize: '13px' }}>
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
        <div style={{ ...s.statPill, backgroundColor: '#faece7', color: '#993C1D' }}>⚠ {absent} Absent</div>
        {onLeave > 0 && <div style={{ ...s.statPill, backgroundColor: '#eeedfe', color: '#534AB7' }}>🌿 {onLeave} On Leave</div>}
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
                <div style={{ fontSize: '13px', fontWeight: '500', color: '#1a1a18' }}>{rec.employee?.user?.fullName}</div>
                <div style={{ fontSize: '11px', color: '#8c8c88' }}>{rec.employee?.jobPosition?.title || rec.employee?.orgUnit?.name}</div>
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
  statPill: { padding: '6px 14px', borderRadius: '20px', fontSize: '13px', fontWeight: '500', backgroundColor: '#e1f5ee', color: '#0F6E56' },
  table: { backgroundColor: '#fff', border: '0.5px solid #e2e0da', borderRadius: '10px', overflow: 'hidden' },
  headerRow: { display: 'flex', padding: '10px 16px', backgroundColor: '#f9f8f6', borderBottom: '0.5px solid #e2e0da', gap: '12px' },
  row: { display: 'flex', padding: '12px 16px', borderBottom: '0.5px solid #f5f4f0', alignItems: 'center', gap: '12px' },
  col: { flex: 1, fontSize: '13px', color: '#1a1a18' },
  avatar: { width: '28px', height: '28px', borderRadius: '50%', backgroundColor: '#eeedfe', color: '#534AB7', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: '600', flexShrink: 0 },
}
