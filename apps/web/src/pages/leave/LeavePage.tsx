import { useState } from 'react'
import { useMyLeaveBalances, useMyLeaveRequests, useCancelLeave } from '../../lib/hooks/useLeave'
import { useAuth } from '../../contexts/AuthContext'
import Badge from '../../components/ui/Badge'
import ApplyLeaveModal from './ApplyLeaveModal'
import AllocationRequestModal from './AllocationRequestModal'
import LeaveApprovalsPanel from './LeaveApprovalsPanel'
import TeamLeaveCalendar from './TeamLeaveCalendar'

type Tab = 'overview' | 'requests' | 'approvals' | 'calendar'

export default function LeavePage() {
  const { isManager } = useAuth()
  const [activeTab, setActiveTab] = useState<Tab>('overview')
  const [showApply, setShowApply] = useState(false)
  const [showAllocation, setShowAllocation] = useState(false)

  const { data: balances = [], isLoading: balancesLoading } = useMyLeaveBalances()
  const { data: requestsData } = useMyLeaveRequests()
  const requests = requestsData?.requests || []
  const cancelLeave = useCancelLeave()

  const TABS: { key: Tab; label: string }[] = [
    { key: 'overview', label: 'My Balances' },
    { key: 'requests', label: 'My Requests' },
    ...(isManager ? [{ key: 'approvals' as Tab, label: 'Approvals' }] : []),
    { key: 'calendar', label: 'Team Calendar' },
  ]

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })

  return (
    <div style={s.page}>
      <div style={s.header}>
        <div>
          <h2 style={s.title}>Leave</h2>
          <p style={s.sub}>Manage your time off</p>
        </div>
        <div style={s.headerActions}>
          <button style={s.secondaryBtn} onClick={() => setShowAllocation(true)}>
            Request Allocation
          </button>
          <button style={s.primaryBtn} onClick={() => setShowApply(true)}>
            + Apply for Leave
          </button>
        </div>
      </div>

      <div style={s.tabs}>
        {TABS.map((tab) => (
          <button
            key={tab.key}
            style={{ ...s.tab, ...(activeTab === tab.key ? s.tabActive : {}) }}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'overview' && (
        <div>
          {balancesLoading ? (
            <div style={s.loading}>Loading balances...</div>
          ) : (
            <div style={s.balanceGrid}>
              {balances.map((b: any) => {
                const available = Math.max(0, b.balanceDays - b.usedDays - b.pendingDays)
                const pct = b.balanceDays > 0 ? (b.usedDays / b.balanceDays) * 100 : 0
                return (
                  <div key={b.leaveTypeId || b.leaveType?.id} style={s.balanceCard}>
                    <div style={s.balanceName}>{b.leaveType?.name || b.leaveType}</div>
                    <div style={s.balanceNumbers}>
                      <span style={s.availNum}>{available.toFixed(1)}</span>
                      <span style={s.totalNum}>/ {b.balanceDays.toFixed(1)} days</span>
                    </div>
                    <div style={s.progressTrack}>
                      <div style={{ ...s.progressFill, width: `${Math.min(100, pct)}%` }} />
                    </div>
                    <div style={s.balanceFooter}>
                      <span>{b.usedDays.toFixed(1)} used</span>
                      {b.pendingDays > 0 && <span style={{ color: '#BA7517' }}>{b.pendingDays.toFixed(1)} pending</span>}
                      <span style={{ marginLeft: 'auto' }}>{available.toFixed(1)} available</span>
                    </div>
                    {!b.leaveType?.isPaid && (
                      <div style={s.unpaidTag}>Unpaid</div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {activeTab === 'requests' && (
        <div style={s.tableWrap}>
          {requests.length === 0 ? (
            <div style={s.empty}>No leave requests yet. Click "+ Apply for Leave" to get started.</div>
          ) : (
            <table style={s.table}>
              <thead>
                <tr>
                  {['Leave Type', 'From', 'To', 'Days', 'Reason', 'Status', ''].map((h) => (
                    <th key={h} style={s.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {requests.map((req: any) => (
                  <tr key={req.id} style={s.tr}>
                    <td style={s.td}><strong>{req.leaveType?.name}</strong></td>
                    <td style={s.td}>{formatDate(req.startDate)}</td>
                    <td style={s.td}>{formatDate(req.endDate)}</td>
                    <td style={s.td}>{req.totalDays}d</td>
                    <td style={s.td}><span style={{ color: '#5c5c58' }}>{req.reason || '—'}</span></td>
                    <td style={s.td}><Badge label={req.status} /></td>
                    <td style={s.td}>
                      {req.status === 'pending' && (
                        <button
                          style={s.cancelBtn}
                          onClick={() => cancelLeave.mutate(req.id)}
                          disabled={cancelLeave.isPending}
                        >
                          Cancel
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {activeTab === 'approvals' && isManager && (
        <LeaveApprovalsPanel />
      )}

      {activeTab === 'calendar' && (
        <TeamLeaveCalendar />
      )}

      <ApplyLeaveModal open={showApply} onClose={() => setShowApply(false)} />
      <AllocationRequestModal open={showAllocation} onClose={() => setShowAllocation(false)} />
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: { maxWidth: '1100px' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '20px' },
  title: { fontSize: '20px', fontWeight: '500', color: '#1a1a18', margin: 0 },
  sub: { fontSize: '13px', color: '#8c8c88', marginTop: '2px' },
  headerActions: { display: 'flex', gap: '8px' },
  primaryBtn: { padding: '9px 18px', backgroundColor: '#534AB7', color: '#fff', border: 'none', borderRadius: '6px', fontSize: '13px', fontWeight: '500', cursor: 'pointer' },
  secondaryBtn: { padding: '9px 18px', backgroundColor: '#f5f4f0', border: '0.5px solid #e2e0da', borderRadius: '6px', fontSize: '13px', cursor: 'pointer', color: '#1a1a18' },
  tabs: { display: 'flex', borderBottom: '0.5px solid #e2e0da', marginBottom: '20px' },
  tab: { padding: '10px 18px', background: 'none', border: 'none', fontSize: '13px', color: '#5c5c58', cursor: 'pointer', borderBottom: '2px solid transparent', marginBottom: '-0.5px' },
  tabActive: { color: '#534AB7', fontWeight: '500', borderBottomColor: '#534AB7' },
  loading: { color: '#8c8c88', fontSize: '13px' },
  balanceGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '12px' },
  balanceCard: { backgroundColor: '#fff', border: '0.5px solid #e2e0da', borderRadius: '10px', padding: '18px', position: 'relative' },
  balanceName: { fontSize: '13px', fontWeight: '500', color: '#1a1a18', marginBottom: '10px' },
  balanceNumbers: { display: 'flex', alignItems: 'baseline', gap: '6px', marginBottom: '10px' },
  availNum: { fontSize: '28px', fontWeight: '500', color: '#1a1a18', lineHeight: 1 },
  totalNum: { fontSize: '13px', color: '#8c8c88' },
  progressTrack: { height: '4px', backgroundColor: '#e2e0da', borderRadius: '2px', overflow: 'hidden', marginBottom: '8px' },
  progressFill: { height: '100%', backgroundColor: '#534AB7', borderRadius: '2px' },
  balanceFooter: { display: 'flex', gap: '12px', fontSize: '11px', color: '#8c8c88' },
  unpaidTag: { position: 'absolute', top: '12px', right: '12px', fontSize: '10px', backgroundColor: '#f5f4f0', color: '#8c8c88', padding: '2px 8px', borderRadius: '10px', border: '0.5px solid #e2e0da' },
  tableWrap: { backgroundColor: '#fff', border: '0.5px solid #e2e0da', borderRadius: '10px', overflow: 'hidden' },
  empty: { padding: '40px', textAlign: 'center', color: '#8c8c88', fontSize: '13px' },
  table: { width: '100%', borderCollapse: 'collapse' },
  th: { padding: '10px 16px', textAlign: 'left', fontSize: '11px', fontWeight: '500', color: '#8c8c88', textTransform: 'uppercase', letterSpacing: '.04em', borderBottom: '0.5px solid #e2e0da', backgroundColor: '#f9f8f6' },
  tr: { borderBottom: '0.5px solid #f5f4f0' },
  td: { padding: '12px 16px', fontSize: '13px', color: '#1a1a18' },
  cancelBtn: { padding: '5px 12px', backgroundColor: '#faece7', color: '#993C1D', border: '0.5px solid #f5c6b8', borderRadius: '4px', fontSize: '12px', cursor: 'pointer' },
}
