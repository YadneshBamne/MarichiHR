import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import { useAuth } from '../../contexts/AuthContext'
import PageHeader from '../../components/ui/PageHeader'
import Modal from '../../components/ui/Modal'
import Icon from '../../components/ui/Icon'
import { useToast } from '../../components/ui/Toast'
import { useReveal } from '../../lib/motion'
import EmployeeFormBuilder from './EmployeeFormBuilder'
import { useMasters, type MasterListData, type MasterValue } from '../../lib/hooks/useMasters'

// One place for every list the rest of the product picks from. Departments, positions, locations and expense
// categories are edited here; the others link to the screen that already manages them.
interface Unit { id: string; name: string; type: string; parentId: string | null; costCenter: string | null; headcount: number }
interface Overview { units: Unit[]; counts: Record<string, number> }
type Tab = 'overview' | 'lists' | 'form' | 'departments' | 'positions' | 'locations' | 'expenses'
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'

export default function MastersPage() {
  const { hasApp } = useAuth()
  const [tab, setTab] = useState<Tab>('overview')
  const { data: o } = useQuery({ queryKey: ['masters'], queryFn: async () => (await api.get('/employees/masters')).data.data as Overview })
  const root = useReveal<HTMLDivElement>(tab)
  const has = hasApp
  const c = o?.counts ?? {}
  const { lists } = useMasters()
  const listCount = lists.length || undefined
  const cards: { label: string; n?: number; sub: string; go: Tab | string; app?: string }[] = [
    { label: 'Dropdown lists', n: listCount, sub: 'Gender, relationship, documents, banks, exit reasons and every other choice', go: 'lists' },
    { label: 'Employee form', sub: 'Which details are shown, required or hidden, and your own custom fields', go: 'form' },
    { label: 'Departments', n: c.departments, sub: 'Org structure, cost centres', go: 'departments' },
    { label: 'Job positions', n: c.positions, sub: 'Titles and grade per department', go: 'positions' },
    { label: 'Work locations', n: c.locations, sub: 'Offices, sites and clock-in geofences', go: 'locations' },
    { label: 'Expense categories', n: c.expenseCats, sub: 'Limits and receipt rules', go: 'expenses', app: 'expenses' },
    { label: 'Leave types', n: c.leaveTypes, sub: 'Accrual, carry-forward, approval', go: '/leave-types', app: 'leave' },
    { label: 'Holiday calendars', n: c.calendars, sub: 'Public holidays by location', go: '/holidays' },
    { label: 'Salary structures & grades', n: (c.structures ?? 0) + (c.grades ?? 0), sub: `${c.structures ?? 0} structures · ${c.grades ?? 0} grade bands`, go: '/compensation', app: 'payroll' },
    { label: 'Incentive types', n: c.incentiveTypes, sub: 'Awards paid through payroll', go: '/incentives', app: 'payroll' },
    { label: 'Tax & statutory rates', sub: 'PAYE, NAPSA, NHIMA, TDS with sources', go: '/tax', app: 'payroll' },
    { label: 'Employee ID series', sub: 'Prefix and digits for new IDs', go: '/employees/import' },
  ]
  return (
    <div ref={root}>
      <PageHeader title="Masters" sub="Every list your people, payroll and policies are built on">
        <div style={{ display: 'flex', gap: 6, marginTop: 14, flexWrap: 'wrap' }}>
          {([['overview', 'All masters'], ['lists', 'Dropdown lists'], ['form', 'Employee form'], ['departments', 'Departments'], ['positions', 'Job positions'], ['locations', 'Work locations'], ...(has('expenses') ? [['expenses', 'Expense categories']] : [])] as [Tab, string][]).map(([k, l]) => <button key={k} className={`btn btn-sm ${tab === k ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab(k)}>{l}</button>)}
        </div>
      </PageHeader>
      {tab === 'overview' && (
        <div className="dgrid">
          {cards.filter((k) => !k.app || has(k.app)).map((k) => {
            const body = <><div style={{ display: 'flex', justifyContent: 'space-between' }}><strong>{k.label}</strong>{k.n != null && <span style={{ fontFamily: 'var(--font-display)', fontSize: 22 }}>{k.n}</span>}</div><span className="dim" style={{ fontSize: 13 }}>{k.sub}</span><span className="link" style={{ fontSize: 12, marginTop: 'auto' }}>{k.go.startsWith('/') ? 'Open ↗' : 'Edit'}</span></>
            const style = { padding: 18, display: 'flex', flexDirection: 'column' as const, gap: 6, textAlign: 'left' as const, minHeight: 120 }
            return k.go.startsWith('/')
              ? <Link key={k.label} to={k.go} data-card className="card span-4 row-link" style={style}>{body}</Link>
              : <button key={k.label} data-card className="card span-4 row-link" style={{ ...style, border: 0, cursor: 'pointer', font: 'inherit', color: 'inherit' }} onClick={() => setTab(k.go as Tab)}>{body}</button>
          })}
        </div>
      )}
      {tab === 'lists' && <ListsEditor />}
      {tab === 'form' && <EmployeeFormBuilder />}
      {tab === 'departments' && <Departments units={o?.units ?? []} />}
      {tab === 'positions' && <Positions units={o?.units ?? []} />}
      {tab === 'locations' && <Locations />}
      {tab === 'expenses' && <ExpenseCategories />}
    </div>
  )
}

function useSave(keys: string[][]) {
  const qc = useQueryClient()
  const toast = useToast()
  return useMutation({
    mutationFn: async (f: () => Promise<unknown>) => f(),
    onSuccess: () => { toast('Saved'); keys.forEach((k) => qc.invalidateQueries({ queryKey: k })) },
    onError: (e) => toast(errMsg(e), 'error'),
  })
}

function Departments({ units }: { units: Unit[] }) {
  const save = useSave([['masters'], ['unit-tree'], ['org-tree']])
  const [edit, setEdit] = useState<Partial<Unit> | null>(null)
  const kids = new Map<string | null, Unit[]>()
  units.forEach((u) => kids.set(u.parentId, [...(kids.get(u.parentId) ?? []), u]))
  const ids = new Set(units.map((u) => u.id))
  const roots = units.filter((u) => !u.parentId || !ids.has(u.parentId))
  const rows: (Unit & { depth: number })[] = []
  const walk = (u: Unit, depth: number) => { rows.push({ ...u, depth }); (kids.get(u.id) ?? []).sort((a, b) => a.name.localeCompare(b.name)).forEach((k) => walk(k, depth + 1)) }
  roots.forEach((r) => walk(r, 0))
  const below = (id: string): Set<string> => { const s = new Set<string>([id]); const st = [id]; while (st.length) (kids.get(st.pop()!) ?? []).forEach((k) => { s.add(k.id); st.push(k.id) }); return s }
  const submit = () => save.mutate(async () => {
    const body: any = { name: edit!.name, type: edit!.type, costCenter: edit!.costCenter || undefined, ...(edit!.parentId ? { parentId: edit!.parentId } : {}) }
    if (edit!.id) await api.patch(`/employees/org-units/${edit!.id}`, body)
    else await api.post('/employees/org-units', body)
    setEdit(null)
  })
  return (
    <section data-card className="card" style={{ padding: 8, overflowX: 'auto' }}>
      <div style={{ padding: 10 }}><button className="btn btn-primary btn-sm" onClick={() => setEdit({ name: '', type: 'department', parentId: roots[0]?.id ?? null })}><Icon name="plus" size={14} /> Add department</button></div>
      <table className="tbl" style={{ width: '100%', minWidth: 560 }}>
        <thead><tr><th>Name</th><th>Type</th><th>Cost centre</th><th style={{ textAlign: 'right' }}>People</th><th /></tr></thead>
        <tbody>{rows.map((u) => (
          <tr key={u.id}>
            <td style={{ paddingLeft: 12 + u.depth * 20 }}>{u.depth > 0 && <span className="dim">└ </span>}<strong style={{ fontWeight: u.depth ? 500 : 600 }}>{u.name}</strong></td>
            <td className="dim" style={{ textTransform: 'capitalize' }}>{u.type}</td>
            <td>{u.costCenter ?? '—'}</td>
            <td style={{ textAlign: 'right' }}>{u.headcount}</td>
            <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setEdit({ name: '', type: 'team', parentId: u.id })}>Add under</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setEdit(u)}>Edit</button>
              {u.parentId && <button className="btn btn-ghost btn-sm" onClick={() => { const reason = prompt(`Archive ${u.name}? Reason:`); if (reason) save.mutate(() => api.post(`/employees/org-units/${u.id}/archive`, { reason })) }}>Archive</button>}
            </td>
          </tr>))}</tbody>
      </table>
      {edit && (
        <Modal open onClose={() => setEdit(null)} title={edit.id ? 'Edit department' : 'New department'}>
          <form onSubmit={(e) => { e.preventDefault(); submit() }} style={{ display: 'grid', gap: 12 }}>
            <label className="field"><span>Name</span><input className="input" required value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
            <label className="field"><span>Type</span><select className="input" value={edit.type} onChange={(e) => setEdit({ ...edit, type: e.target.value })}>{['entity', 'division', 'department', 'team', 'location'].map((t) => <option key={t} value={t}>{t}</option>)}</select></label>
            {(edit.parentId || !edit.id) && <label className="field"><span>Part of</span><select className="input" value={edit.parentId ?? ''} onChange={(e) => setEdit({ ...edit, parentId: e.target.value || null })}>{rows.filter((r) => !edit.id || !below(edit.id).has(r.id)).map((r) => <option key={r.id} value={r.id}>{'  '.repeat(r.depth)}{r.name}</option>)}</select></label>}
            <label className="field"><span>Cost centre (optional)</span><input className="input" value={edit.costCenter ?? ''} onChange={(e) => setEdit({ ...edit, costCenter: e.target.value })} /></label>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><button type="button" className="btn btn-ghost" onClick={() => setEdit(null)}>Cancel</button><button className="btn btn-primary" disabled={save.isPending}>Save</button></div>
          </form>
        </Modal>
      )}
    </section>
  )
}

function Positions({ units }: { units: Unit[] }) {
  const save = useSave([['masters'], ['job-positions']])
  const { data = [] } = useQuery({ queryKey: ['job-positions'], queryFn: async () => (await api.get('/employees/job-positions')).data.data as any[] })
  const [edit, setEdit] = useState<any>(null)
  const submit = () => save.mutate(async () => {
    const body = { title: edit.title, orgUnitId: edit.orgUnitId, code: edit.code || undefined, gradeBand: edit.gradeBand || undefined, description: edit.description || undefined }
    if (edit.id) await api.patch(`/employees/job-positions/${edit.id}`, body)
    else await api.post('/employees/job-positions', body)
    setEdit(null)
  })
  return (
    <section data-card className="card" style={{ padding: 8, overflowX: 'auto' }}>
      <div style={{ padding: 10 }}><button className="btn btn-primary btn-sm" onClick={() => setEdit({ title: '', orgUnitId: units[0]?.id ?? '' })}><Icon name="plus" size={14} /> Add position</button></div>
      {!data.length ? <p className="dim" style={{ padding: 16 }}>No positions yet.</p> : (
        <table className="tbl" style={{ width: '100%', minWidth: 560 }}>
          <thead><tr><th>Title</th><th>Department</th><th>Code</th><th>Grade</th><th style={{ textAlign: 'right' }}>People</th><th /></tr></thead>
          <tbody>{data.map((p) => (
            <tr key={p.id}>
              <td><strong style={{ fontWeight: 600 }}>{p.title}</strong></td><td>{p.orgUnit?.name}</td><td>{p.code ?? '—'}</td><td>{p.gradeBand ?? '—'}</td><td style={{ textAlign: 'right' }}>{p._count?.employees ?? 0}</td>
              <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}><button className="btn btn-ghost btn-sm" onClick={() => setEdit(p)}>Edit</button><button className="btn btn-ghost btn-sm" onClick={() => confirm(`Archive ${p.title}?`) && save.mutate(() => api.post(`/employees/job-positions/${p.id}/archive`))}>Archive</button></td>
            </tr>))}</tbody>
        </table>
      )}
      {edit && (
        <Modal open onClose={() => setEdit(null)} title={edit.id ? 'Edit position' : 'New position'}>
          <form onSubmit={(e) => { e.preventDefault(); submit() }} style={{ display: 'grid', gap: 12 }}>
            <label className="field"><span>Title</span><input className="input" required value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></label>
            <label className="field"><span>Department</span><select className="input" required value={edit.orgUnitId} onChange={(e) => setEdit({ ...edit, orgUnitId: e.target.value })}>{units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <label className="field"><span>Code</span><input className="input" value={edit.code ?? ''} onChange={(e) => setEdit({ ...edit, code: e.target.value })} /></label>
              <label className="field"><span>Grade band</span><input className="input" value={edit.gradeBand ?? ''} placeholder="e.g. ZM-E1" onChange={(e) => setEdit({ ...edit, gradeBand: e.target.value })} /></label>
            </div>
            <label className="field"><span>Description</span><textarea className="input" rows={3} value={edit.description ?? ''} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></label>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><button type="button" className="btn btn-ghost" onClick={() => setEdit(null)}>Cancel</button><button className="btn btn-primary" disabled={save.isPending}>Save</button></div>
          </form>
        </Modal>
      )}
    </section>
  )
}

function Locations() {
  const save = useSave([['masters'], ['work-locations']])
  const { data = [] } = useQuery({ queryKey: ['work-locations'], queryFn: async () => (await api.get('/employees/work-locations')).data.data as any[] })
  const [edit, setEdit] = useState<any>(null)
  const num = (v: any) => (v === '' || v == null ? undefined : Number(v))
  const submit = () => save.mutate(async () => {
    const body = { name: edit.name, address: edit.address || undefined, city: edit.city || undefined, countryCode: edit.countryCode ? String(edit.countryCode).toUpperCase() : undefined, latitude: num(edit.latitude), longitude: num(edit.longitude), geoFenceRadiusMeters: num(edit.geoFenceRadiusMeters) }
    if (edit.id) await api.patch(`/employees/work-locations/${edit.id}`, body)
    else await api.post('/employees/work-locations', body)
    setEdit(null)
  })
  return (
    <section data-card className="card" style={{ padding: 8, overflowX: 'auto' }}>
      <div style={{ padding: 10 }}><button className="btn btn-primary btn-sm" onClick={() => setEdit({ name: '' })}><Icon name="plus" size={14} /> Add location</button></div>
      {!data.length ? <p className="dim" style={{ padding: 16 }}>No locations yet.</p> : (
        <table className="tbl" style={{ width: '100%', minWidth: 560 }}>
          <thead><tr><th>Name</th><th>City</th><th>Country</th><th>Clock-in geofence</th><th /></tr></thead>
          <tbody>{data.map((l) => (
            <tr key={l.id}>
              <td><strong style={{ fontWeight: 600 }}>{l.name}</strong>{l.address && <div className="dim" style={{ fontSize: 12 }}>{l.address}</div>}</td><td>{l.city ?? '—'}</td><td>{l.countryCode ?? '—'}</td>
              <td>{l.latitude != null && l.geoFenceRadiusMeters ? `${l.geoFenceRadiusMeters} m` : <span className="dim">off</span>}</td>
              <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}><button className="btn btn-ghost btn-sm" onClick={() => setEdit(l)}>Edit</button><button className="btn btn-ghost btn-sm" onClick={() => confirm(`Archive ${l.name}?`) && save.mutate(() => api.post(`/employees/work-locations/${l.id}/archive`))}>Archive</button></td>
            </tr>))}</tbody>
        </table>
      )}
      {edit && (
        <Modal open onClose={() => setEdit(null)} title={edit.id ? 'Edit location' : 'New location'}>
          <form onSubmit={(e) => { e.preventDefault(); submit() }} style={{ display: 'grid', gap: 12 }}>
            <label className="field"><span>Name</span><input className="input" required value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
            <label className="field"><span>Address</span><input className="input" value={edit.address ?? ''} onChange={(e) => setEdit({ ...edit, address: e.target.value })} /></label>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
              <label className="field"><span>City</span><input className="input" value={edit.city ?? ''} onChange={(e) => setEdit({ ...edit, city: e.target.value })} /></label>
              <label className="field"><span>Country (2 letters)</span><input className="input" maxLength={2} value={edit.countryCode ?? ''} onChange={(e) => setEdit({ ...edit, countryCode: e.target.value })} /></label>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
              <label className="field"><span>Latitude</span><input className="input" type="number" step="any" value={edit.latitude ?? ''} onChange={(e) => setEdit({ ...edit, latitude: e.target.value })} /></label>
              <label className="field"><span>Longitude</span><input className="input" type="number" step="any" value={edit.longitude ?? ''} onChange={(e) => setEdit({ ...edit, longitude: e.target.value })} /></label>
              <label className="field"><span>Radius (m)</span><input className="input" type="number" min={1} value={edit.geoFenceRadiusMeters ?? ''} onChange={(e) => setEdit({ ...edit, geoFenceRadiusMeters: e.target.value })} /></label>
            </div>
            <span className="dim" style={{ fontSize: 12 }}>With a position and radius, clock-ins from this location are checked against the geofence.</span>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><button type="button" className="btn btn-ghost" onClick={() => setEdit(null)}>Cancel</button><button className="btn btn-primary" disabled={save.isPending}>Save</button></div>
          </form>
        </Modal>
      )}
    </section>
  )
}

function ExpenseCategories() {
  const save = useSave([['masters'], ['expense-categories-all']])
  const { data = [] } = useQuery({ queryKey: ['expense-categories-all'], queryFn: async () => (await api.get('/expenses/config/categories')).data.data as any[] })
  const [edit, setEdit] = useState<any>(null)
  const num = (v: any) => (v === '' || v == null ? null : Number(v))
  const submit = () => save.mutate(async () => {
    const common = { name: edit.name, maxAmount: num(edit.maxAmount), enforceLimit: !!edit.enforceLimit, receiptRequiredAbove: num(edit.receiptRequiredAbove) }
    if (edit.id) await api.patch(`/expenses/config/categories/${edit.id}`, common)
    else await api.post('/expenses/config/categories', { ...common, code: edit.code })
    setEdit(null)
  })
  return (
    <section data-card className="card" style={{ padding: 8, overflowX: 'auto' }}>
      <div style={{ padding: 10 }}><button className="btn btn-primary btn-sm" onClick={() => setEdit({ name: '', code: '' })}><Icon name="plus" size={14} /> Add category</button></div>
      <table className="tbl" style={{ width: '100%', minWidth: 560 }}>
        <thead><tr><th>Category</th><th>Code</th><th style={{ textAlign: 'right' }}>Limit per claim</th><th style={{ textAlign: 'right' }}>Receipt above</th><th>Status</th><th /></tr></thead>
        <tbody>{[...data].sort((a, b) => Number(b.active) - Number(a.active)).map((c) => (
          <tr key={c.id} style={{ opacity: c.active ? 1 : 0.55 }}>
            <td><strong style={{ fontWeight: 600 }}>{c.name}</strong></td><td>{c.code}</td>
            <td style={{ textAlign: 'right' }}>{c.maxAmount != null ? `${Number(c.maxAmount).toLocaleString()}${c.enforceLimit ? ' (hard)' : ''}` : '—'}</td>
            <td style={{ textAlign: 'right' }}>{c.receiptRequiredAbove != null ? Number(c.receiptRequiredAbove).toLocaleString() : '—'}</td>
            <td><span className={`pill ${c.active ? 'ok' : 'mute'}`}>{c.active ? 'active' : 'archived'}</span></td>
            <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}><button className="btn btn-ghost btn-sm" onClick={() => setEdit(c)}>Edit</button><button className="btn btn-ghost btn-sm" onClick={() => save.mutate(() => api.patch(`/expenses/config/categories/${c.id}`, { active: !c.active }))}>{c.active ? 'Archive' : 'Restore'}</button></td>
          </tr>))}</tbody>
      </table>
      {edit && (
        <Modal open onClose={() => setEdit(null)} title={edit.id ? 'Edit category' : 'New category'}>
          <form onSubmit={(e) => { e.preventDefault(); submit() }} style={{ display: 'grid', gap: 12 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
              <label className="field"><span>Name</span><input className="input" required value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
              <label className="field"><span>Code</span><input className="input" required disabled={!!edit.id} value={edit.code} onChange={(e) => setEdit({ ...edit, code: e.target.value.toUpperCase() })} /></label>
              <label className="field"><span>Limit per claim</span><input className="input" type="number" min={0} value={edit.maxAmount ?? ''} onChange={(e) => setEdit({ ...edit, maxAmount: e.target.value })} /></label>
              <label className="field"><span>Receipt required above</span><input className="input" type="number" min={0} value={edit.receiptRequiredAbove ?? ''} onChange={(e) => setEdit({ ...edit, receiptRequiredAbove: e.target.value })} /></label>
            </div>
            <label style={{ display: 'flex', gap: 8, fontSize: 14 }}><input type="checkbox" checked={!!edit.enforceLimit} onChange={(e) => setEdit({ ...edit, enforceLimit: e.target.checked })} /> Block claims over the limit (otherwise they are flagged)</label>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><button type="button" className="btn btn-ghost" onClick={() => setEdit(null)}>Cancel</button><button className="btn btn-primary" disabled={save.isPending}>Save</button></div>
          </form>
        </Modal>
      )}
    </section>
  )
}

// Every company-editable dropdown list: pick a list, then add, rename, retire/restore or move values
function ListsEditor() {
  const qc = useQueryClient()
  const toast = useToast()
  const { lists, isLoading } = useMasters(true)
  const [key, setKey] = useState('gender')
  const [adding, setAdding] = useState('')
  const [editing, setEditing] = useState<{ id: string; label: string } | null>(null)
  const list = lists.find((l) => l.key === key)
  const refresh = () => qc.invalidateQueries({ queryKey: ['masters'] })
  const act = useMutation({ mutationFn: async (f: () => Promise<unknown>) => f(), onSuccess: refresh, onError: (e) => toast(errMsg(e), 'error') })
  const groups = [...new Set(lists.map((l) => l.group))]
  const move = (v: MasterValue, dir: -1 | 1) => {
    const ids = list!.values.map((x) => x.id)
    const i = ids.indexOf(v.id), j = i + dir
    if (j < 0 || j >= ids.length) return
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    act.mutate(() => api.put(`/masters/${key}/order`, { ids }))
  }
  if (isLoading) return <div className="skeleton" style={{ height: 240, borderRadius: 18 }} />
  return (
    <div className="lists-editor" style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 240px) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
      <style>{'@media (max-width: 720px) { .lists-editor { grid-template-columns: 1fr !important } }'}</style>
      <nav data-card className="card" style={{ padding: 10, display: 'grid', gap: 10 }} aria-label="Lists">
        {groups.map((g) => (
          <div key={g} style={{ display: 'grid', gap: 2 }}>
            <span className="dim" style={{ fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', padding: '4px 8px' }}>{g}</span>
            {lists.filter((l: MasterListData) => l.group === g).map((l) => (
              <button key={l.key} className="row-link" aria-current={l.key === key} onClick={() => { setKey(l.key); setEditing(null); setAdding('') }}
                style={{ textAlign: 'left', border: 0, borderRadius: 10, padding: '6px 8px', font: 'inherit', fontSize: 13, cursor: 'pointer', background: l.key === key ? 'var(--night)' : 'transparent', color: l.key === key ? 'var(--night-ink)' : 'inherit', display: 'flex', justifyContent: 'space-between' }}>
                <span>{l.name}</span><span style={{ opacity: 0.6 }}>{l.values.filter((v) => v.active).length}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>
      {list && (
        <section data-card className="card" style={{ padding: 18, display: 'grid', gap: 12, minWidth: 0 }}>
          <div><h3 style={{ fontSize: 17 }}>{list.name}</h3>{list.description && <p className="dim" style={{ fontSize: 13 }}>{list.description}</p>}</div>
          <form onSubmit={(e) => { e.preventDefault(); if (adding.trim()) act.mutate(async () => { await api.post(`/masters/${key}`, { label: adding.trim() }); setAdding(''); toast('Added') }) }} style={{ display: 'flex', gap: 8 }}>
            <input id="master-add" className="input" placeholder={`Add to ${list.name.toLowerCase()}…`} value={adding} maxLength={80} onChange={(e) => setAdding(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
            <button className="btn btn-primary btn-sm" disabled={!adding.trim() || act.isPending}><Icon name="plus" size={14} /> Add</button>
          </form>
          {!list.values.length ? <p className="dim" style={{ fontSize: 13 }}>Nothing here yet. Add your first value above.</p> : (
            <div style={{ overflowX: 'auto' }}>
              <table className="tbl" style={{ width: '100%', minWidth: 460 }}>
                <thead><tr><th>Label</th><th>Code</th><th>Status</th><th /></tr></thead>
                <tbody>{list.values.map((v, i) => (
                  <tr key={v.id} style={{ opacity: v.active ? 1 : 0.55 }}>
                    <td>{editing?.id === v.id ? (
                      <form onSubmit={(e) => { e.preventDefault(); act.mutate(async () => { await api.patch(`/masters/${key}/${v.id}`, { label: editing.label.trim() }); setEditing(null); toast('Renamed') }) }} style={{ display: 'flex', gap: 6 }}>
                        <input className="input" autoFocus value={editing.label} maxLength={80} onChange={(e) => setEditing({ ...editing, label: e.target.value })} style={{ height: 32, minWidth: 0 }} />
                        <button className="btn btn-primary btn-sm" disabled={!editing.label.trim()}>Save</button>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>Cancel</button>
                      </form>
                    ) : <strong style={{ fontWeight: 600 }}>{v.label}</strong>}</td>
                    <td className="dim" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{v.code}{v.isSystem && <span title="Shipped with MarichiHR: the label can change, the code stays"> · default</span>}</td>
                    <td><span className={`pill ${v.active ? 'ok' : 'mute'}`}>{v.active ? 'active' : 'retired'}</span></td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button className="btn btn-ghost btn-sm" aria-label="Move up" disabled={i === 0} onClick={() => move(v, -1)}>↑</button>
                      <button className="btn btn-ghost btn-sm" aria-label="Move down" disabled={i === list.values.length - 1} onClick={() => move(v, 1)}>↓</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setEditing({ id: v.id, label: v.label })}>Rename</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => act.mutate(() => api.patch(`/masters/${key}/${v.id}`, { active: !v.active }))}>{v.active ? 'Retire' : 'Restore'}</button>
                    </td>
                  </tr>))}</tbody>
              </table>
            </div>
          )}
          <p className="dim" style={{ fontSize: 12 }}>Retired values stay on the records that already use them but can't be picked for new ones. Codes never change, so reports and integrations keep working after a rename.</p>
        </section>
      )}
    </div>
  )
}
