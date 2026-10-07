import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../contexts/AuthContext'
import api from '../lib/api'
import type { DashboardData } from '../types'

export default function DashboardPage() {
  const { user, isManager } = useAuth()

  const { data, isLoading } = useQuery<DashboardData>({
    queryKey: ['dashboard'],
    queryFn: async () => {
      const res = await api.get('/activities/dashboard')
      return res.data.data
    },
  })

  if (isLoading) return <div style={s.loading}>Loading dashboard...</div>

  const attendance = data?.employee?.todayAttendance
  const balances = data?.employee?.leaveBalances || []
  const managerData = data?.manager

  return (
    <div style={s.page}>
      <div style={s.greeting}>
        Good {getTimeOfDay()}, {user?.employee?.firstName || user?.fullName} 👋
      </div>

      {/* Today's attendance card */}
      <div style={s.grid}>
        <div style={s.card}>
          <div style={s.cardLabel}>Today's Attendance</div>
          <div style={{ ...s.statusBadge, backgroundColor: getStatusColor(attendance?.status || 'not_started') }}>
            {formatStatus(attendance?.status || 'not_started')}
          </div>
          <div style={s.cardSub}>
            {attendance?.checkInTime
              ? `Checked in at ${formatTime(attendance.checkInTime)}`
              : 'Not clocked in yet'}
            {attendance?.checkOutTime && ` · Out at ${formatTime(attendance.checkOutTime)}`}
          </div>
          {attendance?.workedHours ? (
            <div style={s.cardSub}>{attendance.workedHours.toFixed(1)}h worked today</div>
          ) : null}
        </div>

        {isManager && managerData && (
          <>
            <div style={s.card}>
              <div style={s.cardLabel}>Pending Approvals</div>
              <div style={s.bigNumber}>{managerData.pendingLeaveApprovals}</div>
              <div style={s.cardSub}>leave requests awaiting your action</div>
            </div>
            <div style={s.card}>
              <div style={s.cardLabel}>Team Size</div>
              <div style={s.bigNumber}>{managerData.teamSize}</div>
              <div style={s.cardSub}>
                {managerData.pendingRegularisations} pending regularisation{managerData.pendingRegularisations !== 1 ? 's' : ''}
              </div>
            </div>
          </>
        )}

        <div style={s.card}>
          <div style={s.cardLabel}>Pending Activities</div>
          <div style={s.bigNumber}>{data?.employee?.pendingActivities || 0}</div>
          <div style={s.cardSub}>tasks assigned to you</div>
        </div>
      </div>

      {/* Leave balances */}
      <div style={s.section}>
        <div style={s.sectionTitle}>Leave Balances</div>
        <div style={s.balanceGrid}>
          {balances.filter(b => b.total > 0 || b.available > 0).map((b) => (
            <div key={b.code} style={s.balanceCard}>
              <div style={s.balanceName}>{b.leaveType}</div>
              <div style={s.balanceAvail}>{b.available.toFixed(1)}</div>
              <div style={s.balanceSub}>available of {b.total.toFixed(1)} days</div>
              {b.pending > 0 && (
                <div style={s.balancePending}>{b.pending.toFixed(1)} pending</div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Recent leave requests */}
      {(data?.employee?.recentLeaveRequests?.length ?? 0) > 0 && (
        <div style={s.section}>
          <div style={s.sectionTitle}>Recent Leave Requests</div>
          <div style={s.leaveList}>
            {data!.employee.recentLeaveRequests.map((req) => (
              <div key={req.id} style={s.leaveRow}>
                <div>
                  <span style={s.leaveType}>{req.leaveType.name}</span>
                  <span style={s.leaveDates}> · {formatDate(req.startDate)} → {formatDate(req.endDate)} · {req.totalDays}d</span>
                </div>
                <span style={{ ...s.leaveBadge, backgroundColor: getLeaveStatusColor(req.status) }}>
                  {req.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function getTimeOfDay() {
  const h = new Date().getHours()
  if (h < 12) return 'morning'
  if (h < 17) return 'afternoon'
  return 'evening'
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' })
}

function formatStatus(s: string) {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function getStatusColor(s: string) {
  const map: Record<string, string> = {
    present: '#e1f5ee', half_day: '#faeeda', absent: '#faece7',
    on_leave: '#eeedfe', not_started: '#f5f4f0', week_off: '#f5f4f0',
  }
  return map[s] || '#f5f4f0'
}

function getLeaveStatusColor(s: string) {
  const map: Record<string, string> = {
    approved: '#e1f5ee', pending: '#faeeda', rejected: '#faece7', cancelled: '#f5f4f0',
  }
  return map[s] || '#f5f4f0'
}

const s: Record<string, React.CSSProperties> = {
  page: { maxWidth: '1100px' },
  loading: { color: '#5c5c58', fontSize: '14px' },
  greeting: { fontSize: '22px', fontWeight: '500', color: '#1a1a18', marginBottom: '24px' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '12px', marginBottom: '28px' },
  card: { backgroundColor: '#fff', border: '0.5px solid #e2e0da', borderRadius: '10px', padding: '18px' },
  cardLabel: { fontSize: '12px', color: '#8c8c88', fontWeight: '500', marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '.04em' },
  statusBadge: { display: 'inline-block', padding: '4px 10px', borderRadius: '12px', fontSize: '13px', fontWeight: '500', marginBottom: '8px', color: '#1a1a18' },
  cardSub: { fontSize: '12px', color: '#5c5c58', marginTop: '4px' },
  bigNumber: { fontSize: '32px', fontWeight: '500', color: '#1a1a18', lineHeight: 1.2, marginBottom: '6px' },
  section: { marginBottom: '28px' },
  sectionTitle: { fontSize: '14px', fontWeight: '500', color: '#1a1a18', marginBottom: '12px' },
  balanceGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '10px' },
  balanceCard: { backgroundColor: '#fff', border: '0.5px solid #e2e0da', borderRadius: '8px', padding: '14px' },
  balanceName: { fontSize: '12px', color: '#5c5c58', marginBottom: '6px' },
  balanceAvail: { fontSize: '24px', fontWeight: '500', color: '#1a1a18', lineHeight: 1 },
  balanceSub: { fontSize: '11px', color: '#8c8c88', marginTop: '4px' },
  balancePending: { fontSize: '11px', color: '#BA7517', marginTop: '4px' },
  leaveList: { backgroundColor: '#fff', border: '0.5px solid #e2e0da', borderRadius: '8px', overflow: 'hidden' },
  leaveRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '0.5px solid #f5f4f0', fontSize: '13px' },
  leaveType: { fontWeight: '500', color: '#1a1a18' },
  leaveDates: { color: '#5c5c58' },
  leaveBadge: { padding: '2px 10px', borderRadius: '12px', fontSize: '11px', fontWeight: '500', color: '#1a1a18', textTransform: 'capitalize' },
}
