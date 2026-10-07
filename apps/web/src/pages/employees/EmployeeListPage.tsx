import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useEmployees, useOrgTree } from '../../lib/hooks/useEmployees'
import { useAuth } from '../../contexts/AuthContext'
import { useReveal, useRowsIn } from '../../lib/motion'
import PageHeader, { SearchField, EmptyState } from '../../components/ui/PageHeader'
import Avatar from '../../components/ui/Avatar'
import Icon from '../../components/ui/Icon'
import { usePageLabel } from '../../lib/hooks/usePageLabel'
import CreateEmployeeModal from './CreateEmployeeModal'

const STATUS_PILL: Record<string, string> = { active: 'ok', probation: 'honey', notice: 'warn', on_leave: 'info', terminated: 'mute', resigned: 'mute' }
const since = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—')

function flatten(nodes: any[] = [], out: any[] = []): any[] {
  for (const n of nodes) { out.push(n); flatten(n.children, out) }
  return out
}

export default function EmployeeListPage() {
  const { isAdmin: isHR } = useAuth() // only HR / system admins add people
  const pageTitle = usePageLabel('/employees')
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [search, setSearch] = useState('')
  const [unit, setUnit] = useState<string>('')
  const [archived, setArchived] = useState(false)
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<string[]>([])
  const [showCreate, setShowCreate] = useState(false)

  // Search as you type, without a request per keystroke
  useEffect(() => { const t = setTimeout(() => { setSearch(q.trim()); setPage(1) }, 300); return () => clearTimeout(t) }, [q])

  const { data, isLoading } = useEmployees({ page, limit: 25, search: search || undefined, orgUnitId: unit || undefined, showArchived: archived || undefined })
  const { data: tree } = useOrgTree()
  const units = useMemo(() => flatten(Array.isArray(tree) ? tree : tree ? [tree] : []), [tree])
  const employees: any[] = data?.data || []
  const meta = data?.meta
  const page$ = useReveal<HTMLDivElement>()
  const rows = useRowsIn<HTMLTableSectionElement>(`${search}|${unit}|${page}|${archived}|${employees.length}`)
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))

  return (
    <div ref={page$}>
      <PageHeader
        title={pageTitle}
        sub={meta ? `${meta.total} ${archived ? 'including archived' : 'active'} ${meta.total === 1 ? 'person' : 'people'}` : ' '}
        actions={<>
          <SearchField value={q} onChange={setQ} placeholder="Search by name, email or code" width={280} />
          {isHR && <button className="btn btn-primary" onClick={() => setShowCreate(true)}><Icon name="plus" size={16} /> Add member</button>}
        </>}
      >
        <div className="chips">
          <button className={`chip${!unit ? ' is-on' : ''}`} onClick={() => { setUnit(''); setPage(1) }}>All {!unit && meta && <span className="n">{meta.total}</span>}</button>
          {units.map((u) => (
            <button key={u.id} className={`chip${unit === u.id ? ' is-on' : ''}`} onClick={() => { setUnit(u.id); setPage(1) }}>
              {u.name} {unit === u.id && meta && <span className="n">{meta.total}</span>}
            </button>
          ))}
          <button className={`chip${archived ? ' is-on' : ''}`} onClick={() => { setArchived(!archived); setPage(1) }} style={{ marginLeft: 'auto' }}>
            <Icon name="door" size={13} /> Show archived
          </button>
        </div>
      </PageHeader>

      <section data-card className="card" style={{ padding: '6px 10px', overflowX: 'auto' }}>
        {isLoading ? (
          <div style={{ padding: 14 }}>{Array.from({ length: 6 }, (_, i) => <div key={i} className="skeleton" style={{ height: 38, marginBottom: 10 }} />)}</div>
        ) : employees.length === 0 ? (
          <EmptyState icon={<Icon name="users" size={24} />} title={search || unit ? 'No one matches' : 'No people yet'} body={search || unit ? 'Try a different search or team.' : 'Add your first team member to get started.'}
            action={isHR && !search && !unit ? <button className="btn btn-primary" onClick={() => setShowCreate(true)}><Icon name="plus" size={16} /> Add member</button> : undefined} />
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
                  <tr key={e.id} data-row className={sel ? 'is-sel' : ''} onClick={() => navigate(`/employees/${e.id}`)} style={{ cursor: 'pointer' }}>
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
                    <td>{e.jobPosition?.title || <span className="muted">—</span>}</td>
                    <td>{e.orgUnit?.name || '—'}</td>
                    <td>{e.workLocation?.city || e.workLocation?.name || <span className="muted">—</span>}</td>
                    <td className="num">{since(e.hireDate)}</td>
                    <td><span className={`pill ${sel ? 'night' : STATUS_PILL[e.employmentStatus] || 'mute'}`}>{(e.employmentStatus || '').replace(/_/g, ' ')}</span></td>
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
          {meta && meta.totalPages > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto' }}>
              <button className="btn btn-ghost btn-sm" disabled={!meta.hasPrev} onClick={() => setPage((p) => p - 1)}><Icon name="chevronLeft" size={14} /> Prev</button>
              <span className="dim num" style={{ fontSize: 13 }}>Page {meta.page} of {meta.totalPages}</span>
              <button className="btn btn-ghost btn-sm" disabled={!meta.hasNext} onClick={() => setPage((p) => p + 1)}>Next <Icon name="chevronRight" size={14} /></button>
            </div>
          )}
        </div>
      )}

      <CreateEmployeeModal open={showCreate} onClose={() => setShowCreate(false)} />
    </div>
  )
}
