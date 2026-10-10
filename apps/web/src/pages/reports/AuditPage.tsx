import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import api from '../../lib/api'
import PageHeader from '../../components/ui/PageHeader'
import Avatar from '../../components/ui/Avatar'
import Icon from '../../components/ui/Icon'
import { useToast } from '../../components/ui/Toast'
import { useReveal } from '../../lib/motion'

interface Entry { id: string; at: string; action: string; entityType: string; entityId: string; entity: string | null; user: { id: string; name: string } | null; changes: { field: string; from: unknown; to: unknown }[]; ipAddress: string | null; userAgent: string | null }

// EMPLOYEE_UPDATED -> "Employee updated"; leave_request -> "Leave request"
const human = (s: string) => { const t = s.toLowerCase().replace(/_/g, ' '); return t.charAt(0).toUpperCase() + t.slice(1) }
const fieldName = (f: string) => human(f.replace(/([a-z])([A-Z])/g, '$1_$2'))
const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v))
const LINKS: Record<string, (id: string) => string> = {
  employee: (id) => `/employees/${id}`, policy: (id) => `/policies/${id}`, grievance: (id) => `/grievances/${id}`,
  payroll_cycle: (id) => `/payroll/cycles/${id}`, holiday_calendar: () => '/holidays', announcement: () => '/announcements',
}
const TONE = (a: string) => (/ARCHIVED|REJECTED|CANCELLED|DISABLED|SELF_APPROVAL|REMOVED/.test(a) ? 'danger' : /CREATED|APPROVED|PUBLISHED|ENABLED|PAID|DISBURSED|SIGNED_IN|ADDED/.test(a) ? 'ok' : 'info')

export default function AuditPage() {
  const toast = useToast()
  const [f, setF] = useState({ from: '', to: '', userId: '', entityType: '', action: '' })
  const params = Object.fromEntries(Object.entries(f).filter(([, v]) => v))
  const { data: facets } = useQuery({ queryKey: ['audit-facets'], queryFn: async () => (await api.get('/audit/facets')).data.data as { entityTypes: string[]; actions: string[]; users: { id: string; fullName: string }[] } })
  const q = useInfiniteQuery({
    queryKey: ['audit', params],
    queryFn: async ({ pageParam }) => (await api.get('/audit', { params: { ...params, ...(pageParam && { cursor: pageParam }) } })).data.data as { items: Entry[]; nextCursor: string | null },
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  })
  const items = q.data?.pages.flatMap((p) => p.items) ?? []
  const [open, setOpen] = useState<string | null>(null)
  const root = useReveal<HTMLDivElement>(q.isLoading)

  const exportCsv = async () => {
    try {
      const r = await api.get('/audit/export', { params, responseType: 'blob' })
      const url = URL.createObjectURL(r.data)
      const a = Object.assign(document.createElement('a'), { href: url, download: `audit-log-${new Date().toISOString().slice(0, 10)}.csv` })
      a.click(); URL.revokeObjectURL(url)
    } catch { toast('Export failed', 'error') }
  }

  return (
    <div ref={root}>
      <PageHeader title="Audit log" sub="Every sensitive change: who made it, when, and what changed"
        actions={<button className="btn btn-ghost btn-sm" onClick={exportCsv}><Icon name="download" size={14} /> Export CSV</button>}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, marginTop: 14 }}>
          <label className="field"><span>From</span><input className="input" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
          <label className="field"><span>To</span><input className="input" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
          <label className="field"><span>Person</span><select className="input" value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })}><option value="">Anyone</option>{facets?.users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</select></label>
          <label className="field"><span>Area</span><select className="input" value={f.entityType} onChange={(e) => setF({ ...f, entityType: e.target.value })}><option value="">Everything</option>{facets?.entityTypes.map((t) => <option key={t} value={t}>{human(t)}</option>)}</select></label>
          <label className="field"><span>Action</span><input className="input" list="audit-actions" value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })} placeholder="e.g. approved" /><datalist id="audit-actions">{facets?.actions.map((a) => <option key={a} value={human(a)} />)}</datalist></label>
        </div>
      </PageHeader>

      <section data-card className="card" style={{ padding: 8 }}>
        {q.isLoading ? <div className="skeleton" style={{ height: 200, borderRadius: 14, margin: 8 }} /> : !items.length ? <p className="dim" style={{ padding: 16 }}>Nothing matches these filters.</p> : (
          <ul style={{ listStyle: 'none' }}>
            {items.map((e) => {
              const link = LINKS[e.entityType]?.(e.entityId)
              const expanded = open === e.id
              return (
                <li key={e.id} style={{ borderBottom: '1px solid var(--line)' }}>
                  <button onClick={() => setOpen(expanded ? null : e.id)} aria-expanded={expanded} className="row-link" style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: '12px', border: 0, background: 'none', textAlign: 'left', borderRadius: 12 }}>
                    {e.user ? <Avatar name={e.user.name} size={30} /> : <span style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--well)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="settings" size={14} /></span>}
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: 14 }}><strong style={{ fontWeight: 600 }}>{e.user?.name ?? 'System'}</strong> <span className={`pill ${TONE(e.action)}`} style={{ textTransform: 'none', margin: '0 4px' }}>{human(e.action)}</span> <span className="dim">{e.entity ?? human(e.entityType)}</span></span>
                      <span className="dim" style={{ fontSize: 12 }}>{new Date(e.at).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}{e.ipAddress ? ` · ${e.ipAddress}` : ''}</span>
                    </span>
                    <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={14} />
                  </button>
                  {expanded && (
                    <div style={{ padding: '0 12px 14px 54px', display: 'grid', gap: 8 }}>
                      {e.changes.length ? (
                        <div style={{ overflowX: 'auto' }}>
                          <table className="tbl" style={{ width: '100%', minWidth: 420 }}>
                            <thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead>
                            <tbody>{e.changes.map((c) => <tr key={c.field}><td>{fieldName(c.field)}</td><td className="dim" style={{ overflowWrap: 'anywhere' }}>{show(c.from)}</td><td style={{ overflowWrap: 'anywhere' }}>{show(c.to)}</td></tr>)}</tbody>
                          </table>
                        </div>
                      ) : <span className="dim" style={{ fontSize: 13 }}>No field details recorded.</span>}
                      <div className="dim" style={{ fontSize: 12, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                        <span>{human(e.entityType)} · {e.entityId}</span>
                        {link && <Link to={link} className="link">Open record</Link>}
                        <button className="link" onClick={() => setF({ from: '', to: '', userId: '', action: '', entityType: e.entityType })}>All {human(e.entityType).toLowerCase()} changes</button>
                        {e.userAgent && <span title={e.userAgent} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 280 }}>{e.userAgent}</span>}
                      </div>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        {q.hasNextPage && <div style={{ padding: 12, textAlign: 'center' }}><button className="btn btn-ghost btn-sm" disabled={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>{q.isFetchingNextPage ? 'Loading…' : 'Load older'}</button></div>}
      </section>
    </div>
  )
}
