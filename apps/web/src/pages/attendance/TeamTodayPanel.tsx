import { useTeamAttendanceToday, type TeamStatus } from '../../lib/hooks/useAttendance'
import Avatar from '../../components/ui/Avatar'
import { EmptyState } from '../../components/ui/PageHeader'
import Icon from '../../components/ui/Icon'
import { fmtHours } from '../../lib/format'

// Team Today: everyone in the team (HR: the company) with where they stand right now. People who need a look come first.
const STATUS: Record<TeamStatus, { pill: string; label: string }> = {
  absent: { pill: 'danger', label: 'Absent' },
  not_yet_in: { pill: 'warn', label: 'Not in yet' },
  in: { pill: 'ok', label: 'In' },
  done: { pill: 'info', label: 'Done for today' },
  on_leave: { pill: 'honey', label: 'On leave' },
  day_off: { pill: 'mute', label: 'Day off' },
}
const ORDER: TeamStatus[] = ['absent', 'not_yet_in', 'in', 'done', 'on_leave', 'day_off']
const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—')

export default function TeamTodayPanel() {
  const { data, isLoading, isError } = useTeamAttendanceToday()

  if (isLoading) return <div className="skeleton" style={{ height: 220, borderRadius: 18 }} />
  if (isError || !data) return <div className="card" style={{ padding: 20 }}>Could not load the team. Try again in a moment.</div>
  if (!data.people.length) return <div className="card"><EmptyState icon={<Icon name="users" size={26} />} title="No one to show" body="People who report to you appear here, with who is in, absent or on leave today." /></div>

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} aria-label="Today at a glance">
        {ORDER.map((k) => (
          <span key={k} className={`pill ${STATUS[k].pill}`} style={{ textTransform: 'none', opacity: data.counts[k] ? 1 : 0.5 }}>{data.counts[k]} {STATUS[k].label.toLowerCase()}</span>
        ))}
        <span className="dim" style={{ fontSize: 12, alignSelf: 'center', marginLeft: 'auto' }}>{data.counts.total} {data.counts.total === 1 ? 'person' : 'people'}</span>
      </div>

      <section className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table className="tbl" style={{ width: '100%', minWidth: 560 }}>
          <thead><tr><th>Person</th><th>Status</th><th>In</th><th>Out</th><th>Hours</th></tr></thead>
          <tbody>
            {data.people.map((p) => (
              <tr key={p.employeeId}>
                <td>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <Avatar name={p.name} src={p.avatarUrl} size={30} />
                    <span><strong style={{ fontWeight: 500 }}>{p.name}</strong><span className="dim" style={{ display: 'block', fontSize: 12 }}>{p.position || p.department || p.code}</span></span>
                  </span>
                </td>
                <td><span className={`pill ${STATUS[p.status].pill}`} style={{ textTransform: 'none' }}>{p.status === 'on_leave' && p.leaveType ? p.leaveType : STATUS[p.status].label}</span></td>
                <td className="num">{time(p.checkInTime)}</td>
                <td className="num">{time(p.checkOutTime)}</td>
                <td className="num">{p.openSince ? 'Working now' : p.workedHours ? fmtHours(p.workedHours) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  )
}
