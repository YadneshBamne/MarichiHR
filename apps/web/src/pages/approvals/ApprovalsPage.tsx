import { useState } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import LeaveApprovalsPanel from '../leave/LeaveApprovalsPanel'
import ApprovalsPanel from '../attendance/ApprovalsPanel'
import { WaitingForMe, Monitor, ChainsSetup, usePendingChain } from './ApprovalChainsPanel'
import { usePendingLeaveApprovals } from '../../lib/hooks/useLeave'
import {
  usePendingRegularisations as useAttPendingReg,
  usePendingOvertime as useAttPendingOT,
} from '../../lib/hooks/useAttendance'

type Tab = 'leave' | 'attendance' | 'mine' | 'monitor' | 'chains'

export default function ApprovalsPage() {
  const { isManager, hasApp, hasRole } = useAuth()
  const hr = hasRole('hr_admin') || hasRole('system_admin')
  const lv = hasApp('leave'), att = hasApp('attendance')
  const [activeTab, setActiveTab] = useState<Tab>(!isManager ? 'mine' : lv ? 'leave' : 'attendance')
  const { data: chainPending = [] } = usePendingChain()

  const { data: pendingLeave = [] } = usePendingLeaveApprovals(isManager && lv)
  const { data: pendingReg = [] } = useAttPendingReg(isManager && att)
  const { data: pendingOT = [] } = useAttPendingOT(isManager && att)

  const leaveCount = Array.isArray(pendingLeave) ? pendingLeave.length : 0
  const attendanceCount = (Array.isArray(pendingReg) ? pendingReg.length : 0) + (Array.isArray(pendingOT) ? pendingOT.length : 0)
  const totalCount = leaveCount + attendanceCount + chainPending.length

  const TABS = [
    ...(lv ? [{ key: 'leave' as Tab, label: 'Leave requests', count: leaveCount }] : []),
    ...(att ? [{ key: 'attendance' as Tab, label: 'Attendance', count: attendanceCount }] : []),
    { key: 'mine' as Tab, label: 'Approval chains & delegation', count: chainPending.length },
    ...(hr ? [{ key: 'monitor' as Tab, label: 'Monitor', count: 0 }, { key: 'chains' as Tab, label: 'Set up chains', count: 0 }] : []),
  ].filter((t) => isManager || ['mine'].includes(t.key))

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

      {activeTab === 'mine' && <WaitingForMe />}
      {activeTab === 'monitor' && hr && <Monitor />}
      {activeTab === 'chains' && hr && <ChainsSetup />}
      {activeTab === 'leave' && lv && isManager && <LeaveApprovalsPanel />}
      {activeTab === 'attendance' && att && isManager && <ApprovalsPanel />}
      {!lv && !att && <div className="card" style={{ padding: 40, textAlign: 'center' }}><div className="display" style={{ fontSize: 22 }}>Nothing to approve here yet</div><p className="dim" style={{ marginTop: 6, fontSize: 13 }}>Approvals come from the Leave and Attendance apps. Expense approvals live in Expenses.</p></div>}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: {},
  header: { marginBottom: '20px' },
  title: { fontSize: 'clamp(32px, 4vw, 46px)', fontFamily: 'var(--font-display)', letterSpacing: '-0.02em', fontWeight: 400, color: 'var(--ink)', margin: 0 },
  sub: { fontSize: '13px', color: 'var(--faint)', marginTop: '2px' },
  tabs: { display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 20 },
  tab: { display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: '0 14px', borderRadius: 999, background: 'var(--card-2)', border: '1px solid var(--hair)', fontSize: 12, fontWeight: 500, color: 'var(--dim)', cursor: 'pointer', transition: 'background-color .35s var(--ease), color .35s var(--ease)' },
  tabActive: { background: 'var(--night)', color: 'var(--night-ink)', borderColor: 'var(--night)' },
  badge: { backgroundColor: 'var(--danger)', color: 'var(--night-ink)', fontSize: '10px', fontWeight: '600', padding: '1px 6px', borderRadius: 'var(--r-card)', minWidth: '16px', textAlign: 'center' },
}
