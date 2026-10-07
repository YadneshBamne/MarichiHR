import { useState } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import LeaveApprovalsPanel from '../leave/LeaveApprovalsPanel'
import ApprovalsPanel from '../attendance/ApprovalsPanel'
import { usePendingLeaveApprovals } from '../../lib/hooks/useLeave'
import {
  usePendingRegularisations as useAttPendingReg,
  usePendingOvertime as useAttPendingOT,
} from '../../lib/hooks/useAttendance'

type Tab = 'leave' | 'attendance'

export default function ApprovalsPage() {
  const { isManager } = useAuth()
  const [activeTab, setActiveTab] = useState<Tab>('leave')

  const { data: pendingLeave = [] } = usePendingLeaveApprovals()
  const { data: pendingReg = [] } = useAttPendingReg()
  const { data: pendingOT = [] } = useAttPendingOT()

  const leaveCount = Array.isArray(pendingLeave) ? pendingLeave.length : 0
  const attendanceCount = (Array.isArray(pendingReg) ? pendingReg.length : 0) + (Array.isArray(pendingOT) ? pendingOT.length : 0)
  const totalCount = leaveCount + attendanceCount

  if (!isManager) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 20px', color: '#5c5c58', fontFamily: '-apple-system, sans-serif' }}>
        <div style={{ fontSize: '32px', marginBottom: '12px' }}>🔒</div>
        <div style={{ fontSize: '16px', fontWeight: '500', color: '#1a1a18', marginBottom: '8px' }}>Access restricted</div>
        <div style={{ fontSize: '13px' }}>Approvals are only available to managers and HR administrators.</div>
      </div>
    )
  }

  const TABS = [
    { key: 'leave' as Tab, label: `Leave Requests`, count: leaveCount },
    { key: 'attendance' as Tab, label: `Attendance`, count: attendanceCount },
  ]

  return (
    <div style={s.page}>
      <div style={s.header}>
        <div>
          <h2 style={s.title}>Approvals</h2>
          <p style={s.sub}>
            {totalCount === 0
              ? 'All caught up — no pending approvals'
              : `${totalCount} item${totalCount !== 1 ? 's' : ''} waiting for your action`}
          </p>
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
            {tab.count > 0 && (
              <span style={s.badge}>{tab.count}</span>
            )}
          </button>
        ))}
      </div>

      {activeTab === 'leave' && <LeaveApprovalsPanel />}
      {activeTab === 'attendance' && <ApprovalsPanel />}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: { maxWidth: '800px' },
  header: { marginBottom: '20px' },
  title: { fontSize: '20px', fontWeight: '500', color: '#1a1a18', margin: 0 },
  sub: { fontSize: '13px', color: '#8c8c88', marginTop: '2px' },
  tabs: { display: 'flex', borderBottom: '0.5px solid #e2e0da', marginBottom: '20px', gap: '0' },
  tab: { display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 18px', background: 'none', border: 'none', fontSize: '13px', color: '#5c5c58', cursor: 'pointer', borderBottom: '2px solid transparent', marginBottom: '-0.5px' },
  tabActive: { color: '#534AB7', fontWeight: '500', borderBottomColor: '#534AB7' },
  badge: { backgroundColor: '#993C1D', color: '#fff', fontSize: '10px', fontWeight: '600', padding: '1px 6px', borderRadius: '10px', minWidth: '16px', textAlign: 'center' },
}
