import { useState } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import ClockWidget from './ClockWidget'
import AttendanceCalendarView from './AttendanceCalendarView'
import RegularisationModal from './RegularisationModal'
import OvertimeModal from './OvertimeModal'
import ApprovalsPanel from './ApprovalsPanel'
import TeamTodayPanel from './TeamTodayPanel'

type Tab = 'my' | 'team' | 'approvals'

export default function AttendancePage() {
  const { isManager } = useAuth()
  const [activeTab, setActiveTab] = useState<Tab>('my')
  const [showReg, setShowReg] = useState(false)
  const [showOT, setShowOT] = useState(false)

  const TABS: { key: Tab; label: string }[] = [
    { key: 'my', label: 'My Attendance' },
    ...(isManager ? [
      { key: 'team' as Tab, label: 'Team Today' },
      { key: 'approvals' as Tab, label: 'Approvals' },
    ] : []),
  ]

  return (
    <div style={s.page}>
      <div style={s.header}>
        <div>
          <h2 style={s.title}>Attendance</h2>
          <p style={s.sub}>Track your time and manage your team</p>
        </div>
        <div style={s.headerActions}>
          <button style={s.secondaryBtn} onClick={() => setShowOT(true)}>Request Overtime</button>
          <button style={s.secondaryBtn} onClick={() => setShowReg(true)}>Raise Regularisation</button>
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

      {activeTab === 'my' && (
        <div>
          <ClockWidget />
          <AttendanceCalendarView />
        </div>
      )}

      {activeTab === 'team' && isManager && <TeamTodayPanel />}

      {activeTab === 'approvals' && isManager && <ApprovalsPanel />}

      <RegularisationModal open={showReg} onClose={() => setShowReg(false)} />
      <OvertimeModal open={showOT} onClose={() => setShowOT(false)} />
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: { maxWidth: '1100px' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '20px' },
  title: { fontSize: '20px', fontWeight: '500', color: '#1a1a18', margin: 0 },
  sub: { fontSize: '13px', color: '#8c8c88', marginTop: '2px' },
  headerActions: { display: 'flex', gap: '8px' },
  secondaryBtn: { padding: '9px 16px', backgroundColor: '#f5f4f0', border: '0.5px solid #e2e0da', borderRadius: '6px', fontSize: '13px', cursor: 'pointer', color: '#1a1a18' },
  tabs: { display: 'flex', borderBottom: '0.5px solid #e2e0da', marginBottom: '20px' },
  tab: { padding: '10px 18px', background: 'none', border: 'none', fontSize: '13px', color: '#5c5c58', cursor: 'pointer', borderBottom: '2px solid transparent', marginBottom: '-0.5px' },
  tabActive: { color: '#534AB7', fontWeight: '500', borderBottomColor: '#534AB7' },
}
