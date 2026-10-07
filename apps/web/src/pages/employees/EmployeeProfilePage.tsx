import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useEmployee, useArchiveEmployee } from '../../lib/hooks/useEmployees'
import { useAuth } from '../../contexts/AuthContext'
import Badge from '../../components/ui/Badge'
import ChatterPanel from '../../components/ChatterPanel'
import BankDetailsCard from './BankDetailsCard'

type Tab = 'work' | 'personal' | 'skills' | 'resume' | 'chatter'

export default function EmployeeProfilePage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { isHR, hasRole } = useAuth()
  const { data: employee, isLoading } = useEmployee(id!)
  const archiveEmployee = useArchiveEmployee()
  const [activeTab, setActiveTab] = useState<Tab>('work')
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false)
  const [archiveReason, setArchiveReason] = useState('')

  if (isLoading) return <div style={{ padding: '40px', color: '#8c8c88', fontSize: '13px' }}>Loading employee...</div>
  if (!employee) return <div style={{ padding: '40px', color: '#993C1D', fontSize: '13px' }}>Employee not found.</div>

  const fullName = `${employee.firstName} ${employee.lastName}`

  const handleArchive = async () => {
    if (!archiveReason.trim()) return
    try {
      await archiveEmployee.mutateAsync({ id: id!, reason: archiveReason })
      navigate('/employees')
    } catch {}
  }

  const TABS: { key: Tab; label: string }[] = [
    { key: 'work', label: 'Work Info' },
    { key: 'personal', label: 'Personal' },
    { key: 'skills', label: `Skills (${employee.skills?.length || 0})` },
    { key: 'resume', label: `Resume (${employee.resumeLines?.length || 0})` },
    { key: 'chatter', label: 'Chatter' },
  ]

  return (
    <div style={s.page}>
      {/* Back */}
      <button style={s.back} onClick={() => navigate('/employees')}>← Employees</button>

      {/* Profile header */}
      <div style={s.profileHeader}>
        <div style={s.headerAvatar}>{employee.firstName?.charAt(0)}</div>
        <div style={s.headerInfo}>
          <div style={s.headerName}>{fullName}</div>
          <div style={s.headerSub}>
            {employee.jobPosition?.title || 'No position'} · {employee.orgUnit?.name} · {employee.employeeCode}
          </div>
          <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
            <Badge label={employee.employmentStatus} />
            <Badge label={employee.employmentType} />
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

      {/* Tabs */}
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

      {/* Tab content */}
      <div style={s.tabContent}>
        {activeTab === 'work' && (
          <div style={s.infoGrid}>
            <InfoRow label="Employee Code" value={employee.employeeCode} />
            <InfoRow label="Work Email" value={employee.workEmail} />
            <InfoRow label="Work Mobile" value={employee.mobileWork} />
            <InfoRow label="Department" value={employee.orgUnit?.name} />
            <InfoRow label="Job Position" value={employee.jobPosition?.title} />
            <InfoRow label="Work Location" value={employee.workLocation ? `${employee.workLocation.name}, ${employee.workLocation.city}` : undefined} />
            <InfoRow label="Manager" value={employee.manager?.user?.fullName} />
            <InfoRow label="Hire Date" value={employee.hireDate ? new Date(employee.hireDate).toLocaleDateString() : undefined} />
            <InfoRow label="Employment Type" value={employee.employmentType?.replace(/_/g, ' ')} />
            <InfoRow label="Tax Jurisdiction" value={employee.taxJurisdiction} />
            <InfoRow label="Probation End" value={employee.probationEndDate ? new Date(employee.probationEndDate).toLocaleDateString() : undefined} />
            <InfoRow label="Resource Calendar" value={employee.resourceCalendar?.name} />

            {hasRole('hr_admin') && <BankDetailsCard employee={employee} />}

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
                      <span style={{ color: '#5c5c58', fontSize: '13px', marginLeft: '8px' }}>
                        ({employee.contracts[0].currency} {employee.contracts[0].ctcAnnual?.toLocaleString()} CTC)
                      </span>
                    </div>
                    <Badge label={employee.contracts[0].status} />
                  </div>
                  <div style={{ fontSize: '12px', color: '#8c8c88', marginTop: '6px' }}>
                    Effective from {new Date(employee.contracts[0].effectiveFrom).toLocaleDateString()}
                    {employee.contracts[0].effectiveUntil && ` · Until ${new Date(employee.contracts[0].effectiveUntil).toLocaleDateString()}`}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'personal' && (
          <div style={s.infoGrid}>
            <InfoRow label="Personal Email" value={employee.personalEmail} />
            <InfoRow label="Personal Mobile" value={employee.mobilePersonal} />
            <InfoRow label="Date of Birth" value={employee.dateOfBirth ? new Date(employee.dateOfBirth).toLocaleDateString() : undefined} />
            <InfoRow label="Gender" value={employee.gender} />
            <InfoRow label="Nationality" value={employee.nationality} />
            <InfoRow label="Emergency Contact" value={employee.emergencyContactName} />
            <InfoRow label="Emergency Phone" value={employee.emergencyContactPhone} />
            <InfoRow label="Relationship" value={employee.emergencyContactRelation} />
          </div>
        )}

        {activeTab === 'skills' && (
          <div>
            {employee.skills?.length === 0 ? (
              <div style={s.empty}>No skills added yet.</div>
            ) : (
              <div style={s.skillGrid}>
                {employee.skills?.map((es: any) => (
                  <div key={es.id} style={s.skillCard}>
                    <div style={s.skillType}>{es.skill?.skillType?.name}</div>
                    <div style={s.skillName}>{es.skill?.name}</div>
                    {es.skillLevel && (
                      <div style={s.skillLevel}>
                        <div style={s.progressBar}>
                          <div style={{ ...s.progressFill, width: `${es.skillLevel.progressPct}%` }} />
                        </div>
                        <span style={s.skillLevelLabel}>{es.skillLevel.levelName}</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === 'resume' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {employee.resumeLines?.length === 0 ? (
              <div style={s.empty}>No resume lines added yet.</div>
            ) : (
              employee.resumeLines?.map((line: any) => (
                <div key={line.id} style={s.resumeLine}>
                  <div style={s.resumeType}>{line.lineType}</div>
                  <div style={s.resumeName}>{line.name}</div>
                  {line.organisation && <div style={s.resumeOrg}>{line.organisation}</div>}
                  {(line.dateStart || line.dateEnd) && (
                    <div style={s.resumeDates}>
                      {line.dateStart ? new Date(line.dateStart).toLocaleDateString([], { month: 'short', year: 'numeric' }) : ''}
                      {line.dateEnd ? ` → ${new Date(line.dateEnd).toLocaleDateString([], { month: 'short', year: 'numeric' })}` : line.dateStart ? ' → Present' : ''}
                    </div>
                  )}
                  {line.description && <div style={s.resumeDesc}>{line.description}</div>}
                </div>
              ))
            )}
          </div>
        )}

        {activeTab === 'chatter' && (
          <ChatterPanel entityType="employee" entityId={id!} />
        )}
      </div>

      {/* Archive section */}
      {isHR && employee.active && (
        <div style={s.dangerZone}>
          <div style={s.dangerTitle}>Archive Employee</div>
          <div style={s.dangerSub}>Archiving removes the employee from active lists but preserves all historical data.</div>
          {!showArchiveConfirm ? (
            <button style={s.archiveBtn} onClick={() => setShowArchiveConfirm(true)}>Archive Employee</button>
          ) : (
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
              <input
                style={{ ...s.archiveInput, flex: 1 }}
                placeholder="Reason for archiving..."
                value={archiveReason}
                onChange={(e) => setArchiveReason(e.target.value)}
              />
              <button
                style={{ ...s.archiveBtn, opacity: !archiveReason.trim() ? 0.5 : 1 }}
                disabled={!archiveReason.trim() || archiveEmployee.isPending}
                onClick={handleArchive}
              >
                {archiveEmployee.isPending ? 'Archiving...' : 'Confirm Archive'}
              </button>
              <button style={s.cancelBtn} onClick={() => setShowArchiveConfirm(false)}>Cancel</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value?: string | null }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
      <span style={{ fontSize: '11px', color: '#8c8c88', fontWeight: '500', textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</span>
      <span style={{ fontSize: '13px', color: value ? '#1a1a18' : '#ccc9c1' }}>{value || '—'}</span>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: { maxWidth: '1000px' },
  back: { background: 'none', border: 'none', color: '#5c5c58', fontSize: '13px', cursor: 'pointer', padding: '0 0 16px', display: 'block' },
  profileHeader: { display: 'flex', alignItems: 'flex-start', gap: '16px', backgroundColor: '#fff', border: '0.5px solid #e2e0da', borderRadius: '10px', padding: '24px', marginBottom: '16px' },
  headerAvatar: { width: '52px', height: '52px', borderRadius: '50%', backgroundColor: '#eeedfe', color: '#534AB7', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '20px', fontWeight: '600', flexShrink: 0 },
  headerInfo: { flex: 1 },
  headerName: { fontSize: '20px', fontWeight: '500', color: '#1a1a18' },
  headerSub: { fontSize: '13px', color: '#5c5c58', marginTop: '2px' },
  statButtons: { display: 'flex', gap: '1px', borderRadius: '8px', overflow: 'hidden', border: '0.5px solid #e2e0da', flexShrink: 0 },
  statBtn: { display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '12px 20px', backgroundColor: '#f9f8f6', gap: '2px', cursor: 'default' },
  statNum: { fontSize: '20px', fontWeight: '500', color: '#1a1a18', lineHeight: 1 },
  statLabel: { fontSize: '10px', color: '#8c8c88', whiteSpace: 'nowrap' },
  tabs: { display: 'flex', gap: '0', borderBottom: '0.5px solid #e2e0da', marginBottom: '20px' },
  tab: { padding: '10px 18px', background: 'none', border: 'none', fontSize: '13px', color: '#5c5c58', cursor: 'pointer', borderBottom: '2px solid transparent', marginBottom: '-0.5px' },
  tabActive: { color: '#534AB7', fontWeight: '500', borderBottomColor: '#534AB7' },
  tabContent: { backgroundColor: '#fff', border: '0.5px solid #e2e0da', borderRadius: '10px', padding: '24px' },
  infoGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '20px' },
  sectionLabel: { fontSize: '11px', color: '#8c8c88', fontWeight: '500', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: '8px' },
  contractCard: { backgroundColor: '#f9f8f6', border: '0.5px solid #e2e0da', borderRadius: '8px', padding: '14px' },
  empty: { color: '#8c8c88', fontSize: '13px', padding: '20px 0' },
  skillGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '10px' },
  skillCard: { backgroundColor: '#f9f8f6', border: '0.5px solid #e2e0da', borderRadius: '8px', padding: '12px' },
  skillType: { fontSize: '10px', color: '#8c8c88', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: '4px' },
  skillName: { fontSize: '13px', fontWeight: '500', color: '#1a1a18', marginBottom: '8px' },
  skillLevel: { display: 'flex', alignItems: 'center', gap: '8px' },
  progressBar: { flex: 1, height: '4px', backgroundColor: '#e2e0da', borderRadius: '2px', overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: '#534AB7', borderRadius: '2px' },
  skillLevelLabel: { fontSize: '11px', color: '#5c5c58', whiteSpace: 'nowrap' },
  resumeLine: { backgroundColor: '#f9f8f6', border: '0.5px solid #e2e0da', borderRadius: '8px', padding: '14px' },
  resumeType: { fontSize: '10px', color: '#8c8c88', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: '4px' },
  resumeName: { fontSize: '14px', fontWeight: '500', color: '#1a1a18' },
  resumeOrg: { fontSize: '13px', color: '#5c5c58', marginTop: '2px' },
  resumeDates: { fontSize: '12px', color: '#8c8c88', marginTop: '4px' },
  resumeDesc: { fontSize: '12px', color: '#5c5c58', marginTop: '6px', lineHeight: 1.5 },
  dangerZone: { marginTop: '24px', backgroundColor: '#fff', border: '0.5px solid #f5c6b8', borderRadius: '10px', padding: '20px' },
  dangerTitle: { fontSize: '13px', fontWeight: '500', color: '#993C1D', marginBottom: '4px' },
  dangerSub: { fontSize: '12px', color: '#5c5c58', marginBottom: '12px' },
  archiveBtn: { padding: '8px 16px', backgroundColor: '#faece7', color: '#993C1D', border: '0.5px solid #f5c6b8', borderRadius: '6px', fontSize: '13px', cursor: 'pointer', fontWeight: '500' },
  archiveInput: { padding: '8px 12px', borderRadius: '6px', border: '0.5px solid #ccc9c1', fontSize: '13px', outline: 'none' },
  cancelBtn: { padding: '8px 14px', background: 'none', border: '0.5px solid #e2e0da', borderRadius: '6px', fontSize: '13px', cursor: 'pointer', color: '#5c5c58' },
}
