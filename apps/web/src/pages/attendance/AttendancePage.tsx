import { useState } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { TimeTracker } from '../DashboardPage'
import PageHeader from '../../components/ui/PageHeader'
import Icon from '../../components/ui/Icon'
import { useReveal } from '../../lib/motion'
import AttendanceCalendarView from './AttendanceCalendarView'
import RegularisationModal from './RegularisationModal'
import OvertimeModal from './OvertimeModal'
import ApprovalsPanel from './ApprovalsPanel'
import { usePageLabel } from '../../lib/hooks/usePageLabel'
import TeamTodayPanel from './TeamTodayPanel'

type Tab = 'my' | 'team' | 'approvals'

export default function AttendancePage() {
  const pageTitle = usePageLabel('/attendance')
  const { isManager } = useAuth()
  const [activeTab, setActiveTab] = useState<Tab>('my')
  const [showReg, setShowReg] = useState(false)
  const [showOT, setShowOT] = useState(false)
  const ref = useReveal<HTMLDivElement>(activeTab)

  const TABS: { key: Tab; label: string }[] = [
    { key: 'my', label: 'My Attendance' },
    ...(isManager ? [
      { key: 'team' as Tab, label: 'Team Today' },
      { key: 'approvals' as Tab, label: 'Approvals' },
    ] : []),
  ]

  return (
    <div ref={ref}>
      <PageHeader title={pageTitle} sub="Clock in, check your month and fix missed punches." actions={<>
        <button className="btn btn-ghost" onClick={() => setShowOT(true)}><Icon name="clock" size={15} /> Request overtime</button>
        <button className="btn btn-primary" onClick={() => setShowReg(true)}><Icon name="refresh" size={15} /> Fix a missed punch</button>
      </>} />

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
        <div className="att-grid">
          <TimeTracker />
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
  page: {},
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '20px' },
  title: { fontSize: 'clamp(32px, 4vw, 46px)', fontFamily: 'var(--font-display)', letterSpacing: '-0.02em', fontWeight: 400, color: 'var(--ink)', margin: 0 },
  sub: { fontSize: '13px', color: 'var(--faint)', marginTop: '2px' },
  headerActions: { display: 'flex', gap: '8px' },
  secondaryBtn: { padding: '9px 16px', backgroundColor: 'var(--well)', border: '1px solid var(--line)', borderRadius: 999, fontSize: '13px', cursor: 'pointer', color: 'var(--ink)' },
  tabs: { display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 20 },
  tab: { display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: '0 14px', borderRadius: 999, background: 'var(--card-2)', border: '1px solid var(--hair)', fontSize: 12, fontWeight: 500, color: 'var(--dim)', cursor: 'pointer', transition: 'background-color .35s var(--ease), color .35s var(--ease)' },
  tabActive: { background: 'var(--night)', color: 'var(--night-ink)', borderColor: 'var(--night)' },
}
