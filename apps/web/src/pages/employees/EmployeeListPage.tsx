import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useEmployees, useOrgTree } from '../../lib/hooks/useEmployees'
import { useAuth } from '../../contexts/AuthContext'
import { useReveal, useRowsIn } from '../../lib/motion'
import PageHeader, { SearchField, EmptyState } from '../../components/ui/PageHeader'
import Avatar from '../../components/ui/Avatar'
import Icon from '../../components/ui/Icon'
import Modal from '../../components/ui/Modal'
import MasterSelect from '../../components/ui/MasterSelect'
import { usePageLabel } from '../../lib/hooks/usePageLabel'
import CreateEmployeeModal from './CreateEmployeeModal'
import { downloadCredentials } from './ImportEmployeesPage'
import { downloadCsv } from '../../lib/hooks/usePayroll'
import api from '../../lib/api'
import { useToast } from '../../components/ui/Toast'

const STATUS_PILL: Record<string, string> = { active: 'ok', probation: 'honey', notice: 'warn', on_leave: 'info', terminated: 'mute', resigned: 'mute' }
const since = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—')
type Status = 'active' | 'archived' | 'all'
const SORTS: [string, string, 'name' | 'hireDate' | 'department', 'asc' | 'desc'][] = [
  ['name-asc', 'Name A to Z', 'name', 'asc'], ['name-desc', 'Name Z to A', 'name', 'desc'],
  ['hire-desc', 'Newest joiners first', 'hireDate', 'desc'], ['hire-asc', 'Longest serving first', 'hireDate', 'asc'], ['dept-asc', 'Department', 'department', 'asc'],
]

function flatten(nodes: any[] = [], depth = 0, out: any[] = []): any[] {
  for (const n of nodes) { out.push({ ...n, depth }); flatten(n.children, depth + 1, out) }
  return out
}

export default function EmployeeListPage() {
  const { isAdmin: isHR } = useAuth() // only HR / system admins add people
  const pageTitle = usePageLabel('/employees')
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [search, setSearch] = useState('')
  const [unit, setUnit] = useState<string>('')
  const [subUnits, setSubUnits] = useState(true)
  const [type, setType] = useState('')
  const [status, setStatus] = useState<Status>('active')
  const [sortKey, setSortKey] = useState('name-asc')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<string[]>([])
  const [showCreate, setShowCreate] = useState(false)
  const [confirmIssue, setConfirmIssue] = useState(false)

  // Search as you type, without a request per keystroke
  useEffect(() => { const t = setTimeout(() => { setSearch(q.trim()); setPage(1) }, 300); return () => clearTimeout(t) }, [q])

  const [, , sort, dir] = SORTS.find((s) => s[0] === sortKey) ?? SORTS[0]
  const filters = { search: search || undefined, orgUnitId: unit || undefined, subUnits: unit && !subUnits ? ('0' as const) : undefined, employmentType: type || undefined, status, sort, dir }
  const { data, isLoading } = useEmployees({ page, limit: 25, ...filters })
  const { data: tree } = useOrgTree()
  const units = useMemo(() => flatten(Array.isArray(tree) ? tree : tree ? [tree] : []), [tree])
  const employees: any[] = data?.data || []
  const meta = data?.meta
  const page$ = useReveal<HTMLDivElement>()
  const rows = useRowsIn<HTMLTableSectionElement>(`${search}|${unit}|${subUnits}|${type}|${status}|${sortKey}|${page}|${employees.length}`)
  const toast = useToast()
  const [issuing, setIssuing] = useState(false)
  const [exporting, setExporting] = useState(false)
  const filtered = !!(search || unit || type || status !== 'active')
  // Temporary passwords for the selected people, downloaded once as a credentials sheet
  const issueLogins = async () => {
    setConfirmIssue(false)
    setIssuing(true)
    try {
      const list = (await api.post('/employees/access/bulk', { employeeIds: selected })).data.data
      downloadCredentials(list)
      toast(`Credentials sheet downloaded for ${list.length}. Store it safely.`)
      setSelected([])
    } catch (e: any) { toast(e?.response?.data?.message || 'Could not issue logins', 'error') } finally { setIssuing(false) }
  }
  const exportCsv = async () => {
    setExporting(true)
    try { await downloadCsv('/employees/export', Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== undefined)) as Record<string, string>) } finally { setExporting(false) }
  }
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
  const reset = () => { setQ(''); setUnit(''); setType(''); setStatus('active'); setSubUnits(true); setPage(1) }

  return (
    <div ref={page$}>
      <PageHeader
        title={pageTitle}
        sub={meta ? `${meta.total} ${status === 'archived' ? 'archived' : status === 'all' ? 'in total' : 'active'} ${meta.total === 1 ? 'person' : 'people'}` : ' '}
        actions={<>
          <SearchField value={q} onChange={setQ} placeholder="Search name, email, code or phone" width={300} />
          <button className="btn btn-ghost" disabled={exporting} onClick={exportCsv}><Icon name="download" size={16} /> Export CSV</button>
          {isHR && <button className="btn btn-ghost" onClick={() => navigate('/employees/import')}><Icon name="download" size={16} /> Import</button>}
          {isHR && <button className="btn btn-ghost" onClick={() => navigate('/employees/documents')}><Icon name="file" size={16} /> Documents</button>}
          {isHR && <button className="btn btn-primary" onClick={() => setShowCreate(true)}><Icon name="plus" size={16} /> Add employee</button>}
        </>}
      >
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 4 }}>
          <label className="field" style={{ minWidth: 190 }}><span>Department</span>
            <select className="input select" value={unit} onChange={(e) => { setUnit(e.target.value); setPage(1) }}>
              <option value="">All departments</option>
              {units.map((u) => <option key={u.id} value={u.id}>{'· '.repeat(u.depth)}{u.name}</option>)}
            </select></label>
          <label className="field" style={{ minWidth: 150 }}><span>Employment type</span>
            <MasterSelect list="employment_type" value={type} onChange={(v) => { setType(v); setPage(1) }} placeholder="All types" /></label>
          <label className="field" style={{ minWidth: 130 }}><span>Show</span>
            <select className="input select" value={status} onChange={(e) => { setStatus(e.target.value as Status); setPage(1) }}>
              <option value="active">Active people</option><option value="archived">Archived only</option><option value="all">Everyone</option>
            </select></label>
          <label className="field" style={{ minWidth: 170 }}><span>Sort by</span>
            <select className="input select" value={sortKey} onChange={(e) => { setSortKey(e.target.value); setPage(1) }}>{SORTS.map((s) => <option key={s[0]} value={s[0]}>{s[1]}</option>)}</select></label>
          {unit && <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, height: 42 }}><input type="checkbox" checked={subUnits} onChange={(e) => { setSubUnits(e.target.checked); setPage(1) }} /> Include sub-departments</label>}
          {filtered && <button className="btn btn-ghost btn-sm" onClick={reset}>Clear filters</button>}
        </div>
      </PageHeader>

      <section data-card className="card" style={{ padding: '6px 10px', overflowX: 'auto' }}>
        {isLoading ? (
          <div style={{ padding: 14 }}>{Array.from({ length: 6 }, (_, i) => <div key={i} className="skeleton" style={{ height: 38, marginBottom: 10 }} />)}</div>
        ) : employees.length === 0 ? (
          <EmptyState icon={<Icon name="users" size={24} />} title={filtered ? 'No one matches' : 'No people yet'} body={filtered ? 'Try a different search or clear the filters.' : 'Add your first team member to get started.'}
            action={isHR && !filtered ? <button className="btn btn-primary" onClick={() => setShowCreate(true)}><Icon name="plus" size={16} /> Add employee</button> : undefined} />
        ) : (
          <table className="tbl" style={{ minWidth: 860 }}>
            <thead>
              <tr>
                <th style={{ width: 36 }}><span className="sr-only">Select</span></th>
                <th>Name</th><th>Role</th><th>Team</th><th>Location</th><th>Started</th><th>Status</th>
              </tr>
            </thead>
            <tbody ref={rows}>
              {employees.map((e) => {
                const sel = selected.includes(e.id)
                const name = `${e.firstName} ${e.lastName}`
                return (
                  <tr key={e.id} data-row className={sel ? 'is-sel' : ''} onClick={() => navigate(`/employees/${e.id}`)} style={{ cursor: 'pointer', opacity: e.active === false ? 0.65 : 1 }}>
                    <td onClick={(ev) => ev.stopPropagation()} style={{ width: 36 }}>
                      <input type="checkbox" checked={sel} onChange={() => toggle(e.id)} aria-label={`Select ${name}`} />
                    </td>
                    <td>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                        <Avatar name={name} src={e.user?.avatarUrl} size={30} />
                        <span>
                          <span style={{ display: 'block', fontWeight: 500 }}>{name}</span>
                          <span className="muted" style={{ fontSize: 11 }}>{e.employeeCode}</span>
                        </span>
                      </span>
                    </td>
                    <td>
                      {e.jobPosition?.title || <span className="muted">—</span>}
                      {isHR && e.user?.roleNames?.length > 0 && <span className="muted" style={{ display: 'block', fontSize: 11 }}>{e.user.roleNames.map((r: string) => r.replace(/_/g, ' ')).join(', ')}</span>}
                    </td>
                    <td>{e.orgUnit?.name || '—'}</td>
                    <td>{e.workLocation?.city || e.workLocation?.name || <span className="muted">—</span>}</td>
                    <td className="num">{since(e.hireDate)}</td>
                    <td><span className={`pill ${sel ? 'night' : e.active === false ? 'mute' : STATUS_PILL[e.employmentStatus] || 'mute'}`}>{e.active === false ? 'archived' : (e.employmentStatus || '').replace(/_/g, ' ')}</span></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>

      {(selected.length > 0 || (meta && meta.totalPages > 1)) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14, flexWrap: 'wrap' }}>
          {selected.length > 0 && <span className="pill night" style={{ height: 30, padding: '0 14px' }}>{selected.length} selected <button className="link" style={{ color: 'var(--honey)' }} onClick={() => setSelected([])}>Clear</button></span>}
          {isHR && selected.length > 0 && <button className="btn btn-honey btn-sm" disabled={issuing} onClick={() => setConfirmIssue(true)}><Icon name="key" size={14} /> Issue logins</button>}
          {meta && meta.totalPages > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto' }}>
              <button className="btn btn-ghost btn-sm" disabled={!meta.hasPrev} onClick={() => setPage((p) => p - 1)}><Icon name="chevronLeft" size={14} /> Prev</button>
              <span className="dim num" style={{ fontSize: 13 }}>Page {meta.page} of {meta.totalPages}</span>
              <button className="btn btn-ghost btn-sm" disabled={!meta.hasNext} onClick={() => setPage((p) => p + 1)}>Next <Icon name="chevronRight" size={14} /></button>
            </div>
          )}
        </div>
      )}

      {confirmIssue && (
        <Modal open onClose={() => setConfirmIssue(false)} title="Issue new logins?" width={440}>
          <div style={{ display: 'grid', gap: 14 }}>
            <p style={{ margin: 0 }}>Give <strong>{selected.length} {selected.length === 1 ? 'person' : 'people'}</strong> a new temporary password? Any password they have now stops working, and they sign in again with the new one. You get one sheet with all of them to download.</p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><button className="btn btn-ghost" onClick={() => setConfirmIssue(false)}>Cancel</button><button className="btn btn-primary" onClick={issueLogins}>Issue logins</button></div>
          </div>
        </Modal>
      )}
      <CreateEmployeeModal open={showCreate} onClose={() => setShowCreate(false)} />
    </div>
  )
}
