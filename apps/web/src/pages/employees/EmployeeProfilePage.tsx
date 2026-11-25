import { useState } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import { RequestCard, NewRequestModal, type Req } from './RequestsPage'
import { useEmployee, useReinstateEmployee } from '../../lib/hooks/useEmployees'
import { useAuth } from '../../contexts/AuthContext'
import Badge from '../../components/ui/Badge'
import ChatterPanel from '../../components/ChatterPanel'
import BankDetailsCard from './BankDetailsCard'
import AccessCard from '../../components/company/AccessCard'
import Avatar from '../../components/ui/Avatar'
import Icon from '../../components/ui/Icon'
import { useReveal } from '../../lib/motion'
import Profile360 from './Profile360'
import DocumentsTab from './DocumentsTab'
import LeaveBalancesPanel from '../leave/LeaveBalancesPanel'
import { useRecord, FieldsCard, ListSection, IdentitySection, PositionHistory, CustomFieldsCard, MissingBanner } from './RecordSections'
import { useMasters } from '../../lib/hooks/useMasters'
import Modal from '../../components/ui/Modal'
import { useToast } from '../../components/ui/Toast'
import TerminateDialog from './TerminateDialog'
import { SkillsTab, ResumeTab } from './SkillsResumeTabs'

// Date-only values are stored at UTC midnight: format them in UTC so the day never shifts
const dateOnly = (v?: string | null) => (v ? new Date(v).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : undefined)

type Tab = 'leave' | 'documents' | 'overview' | 'work' | 'personal' | 'family' | 'qualifications' | 'identity' | 'skills' | 'resume' | 'chatter' | 'access'

export default function EmployeeProfilePage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { isHR, hasRole, hasApp, user } = useAuth()
  const canManageAccess = hasRole('hr_admin') || hasRole('system_admin')
  const { data: employee, isLoading } = useEmployee(id!)
  const { label: master } = useMasters()
  const { data: rec } = useRecord(id!)
  const reinstate = useReinstateEmployee()
  const toast = useToast()
  const [params] = useSearchParams()
  const [activeTab, setActiveTab] = useState<Tab>((params.get('tab') as Tab) || 'overview')
  const [asking, setAsking] = useState(false)
  const qc = useQueryClient()
  const isSelf = !!user?.employee?.id && user.employee.id === id
  const { data: requests = [] } = useQuery({ queryKey: ['profile-requests', 'employee', id], enabled: isSelf || isHR, queryFn: async () => (await api.get('/profile-requests', { params: isSelf && !isHR ? { mine: '1', status: 'open' } : { employeeId: id, status: 'open' } })).data.data as Req[] })
  const refreshRequests = () => { qc.invalidateQueries({ queryKey: ['profile-requests'] }); qc.invalidateQueries({ queryKey: ['record', id] }) }
  const [terminating, setTerminating] = useState(false)
  const [reinstating, setReinstating] = useState(false)
  const ref = useReveal<HTMLDivElement>(employee?.id)

  if (isLoading) return <div style={{ padding: '40px', color: 'var(--faint)', fontSize: '13px' }}>Loading employee...</div>
  if (!employee) return <div style={{ padding: '40px', color: 'var(--danger)', fontSize: '13px' }}>Employee not found.</div>

  const fullName = `${employee.firstName} ${employee.lastName}`

  const canEditRecord = isSelf || hasRole('hr_admin') || hasRole('system_admin') // skills and resume
  const canSeeBank = hasRole('hr_admin') || hasRole('system_admin') || hasRole('payroll_admin')
  const doReinstate = async () => {
    try { const r = await reinstate.mutateAsync(id!); toast(r.message || 'Reinstated'); setReinstating(false) } catch (e: any) { toast(e?.response?.data?.message || 'Could not reinstate', 'error') }
  }

  const TABS: { key: Tab; label: string }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'personal', label: 'Personal' },
    { key: 'work', label: 'Job' },
    ...(rec?.can.seeSensitive ? [{ key: 'family' as Tab, label: 'Family' }] : []),
    { key: 'qualifications', label: 'Education & experience' },
    ...(rec?.can.seeSensitive ? [{ key: 'identity' as Tab, label: 'Identity' }, { key: 'documents' as Tab, label: 'Documents' }] : []),
    { key: 'skills', label: `Skills (${employee.skills?.length || 0})` },
    { key: 'resume', label: `Resume (${employee.resumeLines?.length || 0})` },
    { key: 'chatter', label: 'Chatter' },
    ...((hasRole('hr_admin') || hasRole('system_admin')) && hasApp('leave') ? [{ key: 'leave' as Tab, label: 'Leave balances' }] : []),
    ...(canManageAccess ? [{ key: 'access' as Tab, label: 'Login & access' }] : []),
  ]

  return (
    <div ref={ref}>
      <button data-rise className="btn btn-ghost btn-sm" style={{ marginBottom: 14 }} onClick={() => navigate(isHR ? '/employees' : '/dashboard')}><Icon name="chevronLeft" size={14} /> {isHR ? 'People' : 'Dashboard'}</button>

      {/* Profile header */}
      <div data-card className="card" style={s.profileHeader}>
        <Avatar name={fullName} src={employee.user?.avatarUrl} size={84} ring />
        <div style={s.headerInfo}>
          <h1 style={{ fontSize: 'clamp(30px, 3.6vw, 42px)', lineHeight: 1.05 }}>{fullName}</h1>
          <div className="dim" style={{ marginTop: 4, fontSize: 14 }}>
            {employee.jobPosition?.title || 'No position'} · {employee.orgUnit?.name}
          </div>
          <div style={{ display: 'flex', gap: 16, marginTop: 12, flexWrap: 'wrap', fontSize: 12.5 }} className="dim">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="briefcase" size={14} /> {employee.employeeCode}</span>
            {employee.workEmail && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="mail" size={14} /> {employee.workEmail}</span>}
            {employee.workLocation && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="pin" size={14} /> {employee.workLocation.city || employee.workLocation.name}</span>}
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="calendar" size={14} /> Since {dateOnly(employee.hireDate)}</span>
          </div>
          <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
            <Badge label={employee.active === false ? 'archived' : employee.employmentStatus} />
            <Badge label={master('employment_type', employee.employmentType)} />
          </div>
        </div>

        {/* Smart stat buttons */}
        <div style={s.statButtons}>
          {employee.contracts !== undefined && (
            <div style={s.statBtn}>
              <span style={s.statNum}>{employee._count?.contracts ?? 0}</span>
              <span style={s.statLabel}>Contracts</span>
            </div>
          )}
          <div style={s.statBtn}>
            <span style={s.statNum}>{employee._count?.leaveRequests ?? 0}</span>
            <span style={s.statLabel}>Leave Requests</span>
          </div>
          <div style={s.statBtn}>
            <span style={s.statNum}>{employee._count?.attendanceRecords ?? 0}</span>
            <span style={s.statLabel}>Attendance Days</span>
          </div>
        </div>
      </div>

      {employee.active === false && (
        <div role="status" className="well" style={{ padding: '12px 16px', marginBottom: 16, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ flex: 1, fontSize: 13 }}><strong style={{ fontWeight: 600 }}>Archived</strong>{employee.archivedAt ? ' on ' + dateOnly(employee.archivedAt) : ''}{employee.archiveReason ? ' · ' + employee.archiveReason : ''}. The record can be read but not changed until they are reinstated.</span>
          {isHR && <button className="btn btn-ghost btn-sm" onClick={() => setReinstating(true)}>Reinstate</button>}
        </div>
      )}

      {/* Tabs */}
      <div style={s.tabs}>
        {TABS.map((tab) => (
          <button
            key={tab.key}
            className={'chip' + (activeTab === tab.key ? ' is-on' : '')}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {(requests.length > 0 || isHR) && (
        <div style={{ display: 'grid', gap: 10, marginBottom: 16 }}>
          {requests.map((r) => <RequestCard key={r.id} r={r} mode={isHR && !isSelf ? 'hr' : 'self'} onChange={refreshRequests} />)}
          {isHR && !isSelf && employee.active && <div><button className="btn btn-ghost btn-sm" onClick={() => setAsking(true)}><Icon name="mail" size={13} /> {requests.some((r) => r.kind === 'onboarding') ? 'Ask for more details' : 'Start onboarding / ask for details'}</button></div>}
        </div>
      )}
      {asking && <NewRequestModal employeeIds={[employee.id]} onClose={(ok) => { setAsking(false); if (ok) refreshRequests() }} />}

      {/* Tab content */}
      <div className="card" style={s.tabContent}>
        {activeTab === 'overview' && <Profile360 employeeId={employee.id} self={{ id: employee.id, name: fullName, employeeCode: employee.employeeCode, title: employee.jobPosition?.title ?? null, avatarUrl: employee.user?.avatarUrl ?? null }} />}
        {activeTab === 'access' && canManageAccess && <AccessCard employeeId={employee.id} isSelf={employee.userId === user?.id} />}
        {activeTab === 'work' && (
          <div style={s.infoGrid}>
            <InfoRow label="Employee Code" value={employee.employeeCode} />
            <InfoRow label="Work Email" value={employee.workEmail} />
            <InfoRow label="Department" value={employee.orgUnit?.name} />
            <InfoRow label="Job Position" value={employee.jobPosition?.title} />
            <InfoRow label="Work Location" value={employee.workLocation ? `${employee.workLocation.name}, ${employee.workLocation.city}` : undefined} />
            <InfoRow label="Manager" value={employee.manager?.user?.fullName ?? (isHR ? 'No manager set. Use Change position below to assign one.' : undefined)} />
            <InfoRow label="Resource Calendar" value={employee.resourceCalendar?.name} />

            {canSeeBank && employee.active !== false && <BankDetailsCard employee={employee} />}

            {rec && <div style={{ gridColumn: '1 / -1', display: 'grid', gap: 26, marginTop: 8 }}><FieldsCard rec={rec} sections={['job']} title="Employment details" /><PositionHistory rec={rec} /></div>}

            {/* Current contract */}
            {employee.contracts?.length > 0 && (
              <div style={{ gridColumn: '1 / -1', marginTop: '16px' }}>
                <div style={s.sectionLabel}>Current Contract</div>
                <div style={s.contractCard}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <span style={{ fontWeight: '500', fontSize: '15px' }}>
                        {employee.contracts[0].currency} {employee.contracts[0].wageMonthly?.toLocaleString()}/month
                      </span>
                      <span style={{ color: 'var(--dim)', fontSize: '13px', marginLeft: '8px' }}>
                        ({employee.contracts[0].currency} {employee.contracts[0].ctcAnnual?.toLocaleString()} CTC)
                      </span>
                    </div>
                    <Badge label={employee.contracts[0].status} />
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--faint)', marginTop: '6px' }}>
                    Effective from {dateOnly(employee.contracts[0].effectiveFrom)}
                    {employee.contracts[0].effectiveUntil && ` · Until ${dateOnly(employee.contracts[0].effectiveUntil)}`}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'personal' && (rec ? (
          <div style={{ display: 'grid', gap: 26 }}>
            <MissingBanner rec={rec} />
            <FieldsCard rec={rec} sections={['personal']} title="Personal details" />
            <FieldsCard rec={rec} sections={['contact']} title="Contact" />
            <ListSection rec={rec} section="addresses" />
            <ListSection rec={rec} section="emergencyContacts" />
            <CustomFieldsCard rec={rec} />
          </div>
        ) : <div className="skeleton" style={{ height: 200, borderRadius: 14 }} />)}

        {activeTab === 'family' && rec && <ListSection rec={rec} section="family" />}

        {activeTab === 'qualifications' && rec && (
          <div style={{ display: 'grid', gap: 26 }}>
            <ListSection rec={rec} section="education" />
            <ListSection rec={rec} section="previousEmployment" />
          </div>
        )}

        {activeTab === 'identity' && rec && <IdentitySection rec={rec} />}

        {activeTab === 'documents' && <DocumentsTab employeeId={employee.id} />}
        {activeTab === 'leave' && (hasRole('hr_admin') || hasRole('system_admin')) && <LeaveBalancesPanel employeeId={employee.id} name={fullName} />}

        {activeTab === 'skills' && <SkillsTab employee={employee} canEdit={canEditRecord && employee.active !== false} />}

        {activeTab === 'resume' && <ResumeTab employee={employee} canEdit={canEditRecord && employee.active !== false} />}

        {activeTab === 'chatter' && (
          <ChatterPanel entityType="employee" entityId={id!} />
        )}
      </div>

      {/* End of employment */}
      {isHR && !isSelf && employee.active && (
        <section className="card" style={{ marginTop: 24, padding: 20, display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <strong style={{ color: 'var(--danger)', fontWeight: 600 }}>End employment</strong>
            <div className="dim" style={{ fontSize: 13, marginTop: 2 }}>Records the last working day and reason, passes their team to a new manager and switches their login off. History is kept.</div>
          </div>
          <button className="btn btn-danger" onClick={() => setTerminating(true)}>Terminate…</button>
        </section>
      )}
      {terminating && <TerminateDialog employee={employee} hasExits={hasApp('exits')} onClose={() => setTerminating(false)} />}
      {reinstating && (
        <Modal open onClose={() => setReinstating(false)} title={'Reinstate ' + fullName + '?'} width={460}>
          <div style={{ display: 'grid', gap: 14 }}>
            <p style={{ margin: 0 }}>{employee.firstName} comes back into the active lists. Their <strong>login stays off</strong>: turn it on under Login & access when you are ready. If they are paid through payroll, add a new contract.</p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><button className="btn btn-ghost" onClick={() => setReinstating(false)}>Cancel</button><button className="btn btn-primary" disabled={reinstate.isPending} onClick={doReinstate}>{reinstate.isPending ? 'Reinstating…' : 'Reinstate'}</button></div>
          </div>
        </Modal>
      )}
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value?: string | null }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
      <span style={{ fontSize: '11px', color: 'var(--faint)', fontWeight: '500' }}>{label}</span>
      <span style={{ fontSize: '13px', color: value ? 'var(--ink)' : 'var(--line-2)' }}>{value || '—'}</span>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: {},
  back: { background: 'none', border: 'none', color: 'var(--dim)', fontSize: '13px', cursor: 'pointer', padding: '0 0 16px', display: 'block' },
  profileHeader: { display: 'flex', alignItems: 'center', gap: 22, padding: 26, marginBottom: 16, flexWrap: 'wrap' },
  headerAvatar: { width: '52px', height: '52px', borderRadius: '50%', backgroundColor: 'var(--honey-soft)', color: 'var(--brand)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '20px', fontWeight: '600', flexShrink: 0 },
  headerInfo: { flex: 1 },
  headerName: { fontSize: '20px', fontWeight: '500', color: 'var(--ink)' },
  headerSub: { fontSize: '13px', color: 'var(--dim)', marginTop: '2px' },
  statButtons: { display: 'flex', gap: 28, flexShrink: 0 },
  statBtn: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4 },
  statNum: { fontFamily: 'var(--font-display)', fontSize: 40, lineHeight: 1, color: 'var(--ink)' },
  statLabel: { fontSize: '10px', color: 'var(--faint)', whiteSpace: 'nowrap' },
  tabs: { display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 20 },
  tab: { display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: '0 14px', borderRadius: 999, background: 'var(--card-2)', border: '1px solid var(--hair)', fontSize: 12, fontWeight: 500, color: 'var(--dim)', cursor: 'pointer', transition: 'background-color .35s var(--ease), color .35s var(--ease)' },
  tabActive: { background: 'var(--night)', color: 'var(--night-ink)', border: '1px solid var(--night)' },
  tabContent: { padding: 24 },
  infoGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '20px' },
  sectionLabel: { fontSize: '11px', color: 'var(--faint)', fontWeight: '500', marginBottom: '8px' },
  contractCard: { backgroundColor: 'var(--solid)', border: '1px solid var(--line)', borderRadius: '14px', padding: '14px' },
  empty: { color: 'var(--faint)', fontSize: '13px', padding: '20px 0' },
  skillGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '10px' },
  skillCard: { backgroundColor: 'var(--solid)', border: '1px solid var(--line)', borderRadius: '14px', padding: '12px' },
  skillType: { fontSize: '10px', color: 'var(--faint)', marginBottom: '4px' },
  skillName: { fontSize: '13px', fontWeight: '500', color: 'var(--ink)', marginBottom: '8px' },
  skillLevel: { display: 'flex', alignItems: 'center', gap: '8px' },
  progressBar: { flex: 1, height: '4px', backgroundColor: 'var(--line)', borderRadius: '2px', overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: 'var(--brand)', borderRadius: '2px' },
  skillLevelLabel: { fontSize: '11px', color: 'var(--dim)', whiteSpace: 'nowrap' },
  resumeLine: { backgroundColor: 'var(--solid)', border: '1px solid var(--line)', borderRadius: '14px', padding: '14px' },
  resumeType: { fontSize: '10px', color: 'var(--faint)', marginBottom: '4px' },
  resumeName: { fontSize: '14px', fontWeight: '500', color: 'var(--ink)' },
  resumeOrg: { fontSize: '13px', color: 'var(--dim)', marginTop: '2px' },
  resumeDates: { fontSize: '12px', color: 'var(--faint)', marginTop: '4px' },
  resumeDesc: { fontSize: '12px', color: 'var(--dim)', marginTop: '6px', lineHeight: 1.5 },
  dangerZone: { marginTop: '24px', backgroundColor: 'var(--card-2)', border: '1px solid var(--danger-line)', borderRadius: 'var(--r-card)', padding: '20px' },
  dangerTitle: { fontSize: '13px', fontWeight: '500', color: 'var(--danger)', marginBottom: '4px' },
  dangerSub: { fontSize: '12px', color: 'var(--dim)', marginBottom: '12px' },
  archiveBtn: { padding: '8px 16px', backgroundColor: 'var(--danger-bg)', color: 'var(--danger)', border: '1px solid var(--danger-line)', borderRadius: 999, fontSize: '13px', cursor: 'pointer', fontWeight: '500' },
  archiveInput: { padding: '8px 12px', borderRadius: '12px', border: '1px solid var(--line-2)', fontSize: '13px', outline: 'none' },
  cancelBtn: { padding: '8px 14px', background: 'none', border: '1px solid var(--line)', borderRadius: 999, fontSize: '13px', cursor: 'pointer', color: 'var(--dim)' },
}
