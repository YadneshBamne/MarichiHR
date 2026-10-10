import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import { useAuth } from '../../contexts/AuthContext'
import { useOrgTree, useWorkLocations } from '../../lib/hooks/useEmployees'
import PageHeader from '../../components/ui/PageHeader'
import Modal from '../../components/ui/Modal'
import Avatar from '../../components/ui/Avatar'
import Icon from '../../components/ui/Icon'
import { useToast } from '../../components/ui/Toast'
import { useReveal } from '../../lib/motion'
import { flattenUnits } from './AnnouncementsPage'

interface Mine { id: string; title: string; category: string; version: number; effectiveFrom: string | null; requiresAcceptance: boolean; acceptedAt: string | null; dueDate: string | null; status: 'accepted' | 'pending' | 'overdue' | 'info' }
interface Managed { id: string; title: string; category: string; requiresAcceptance: boolean; version: number | null; publishedAt: string | null; hasDraft: boolean; audience: number; accepted: number; pending: number; overdue: boolean; dueDate: string | null }
interface Version { id: string; version: number; body: string; changeNote: string | null; status: string; effectiveFrom: string | null; publishedAt: string | null }
interface Detail { id: string; title: string; category: string; requiresAcceptance: boolean; acceptWithinDays: number; departmentIds: string[]; workLocationIds: string[]; current: Version | null; draft: Version | null; history: Version[]; acceptedAt: string | null; dueDate: string | null }

const CATEGORIES = ['General', 'Code of conduct', 'Leave & attendance', 'Travel & expenses', 'IT & security', 'Health & safety', 'Payroll & benefits']
const day = (d: string | null) => (d ? new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }) : '')
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
const STATUS: Record<Mine['status'], [string, string]> = { accepted: ['ok', 'Accepted'], pending: ['warn', 'To accept'], overdue: ['danger', 'Overdue'], info: ['mute', 'For information'] }
const useIsAdmin = () => { const { hasRole } = useAuth(); return hasRole('hr_admin') || hasRole('system_admin') }

export default function PoliciesPage() {
  const isAdmin = useIsAdmin()
  const [tab, setTab] = useState<'mine' | 'manage'>('mine')
  const [creating, setCreating] = useState(false)
  const root = useReveal<HTMLDivElement>(tab)
  return (
    <div ref={root}>
      <PageHeader title="Policies" sub="Handbooks and rules that apply to you"
        actions={isAdmin ? <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}><Icon name="plus" size={14} /> New policy</button> : undefined}>
        {isAdmin && (
          <div role="tablist" style={{ display: 'flex', gap: 6, marginTop: 14 }}>
            {([['mine', 'My policies'], ['manage', 'Manage']] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`btn btn-sm ${tab === k ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab(k)}>{l}</button>)}
          </div>
        )}
      </PageHeader>
      {tab === 'mine' ? <MyPolicies /> : <ManagePolicies />}
      {creating && <PolicyForm onClose={() => setCreating(false)} />}
    </div>
  )
}

function MyPolicies() {
  const { data = [], isLoading } = useQuery({ queryKey: ['policies'], queryFn: async () => (await api.get('/policies')).data.data as Mine[] })
  const groups = useMemo(() => {
    const m = new Map<string, Mine[]>()
    for (const p of data) m.set(p.category, [...(m.get(p.category) ?? []), p])
    return [...m]
  }, [data])
  const todo = data.filter((p) => p.status === 'pending' || p.status === 'overdue').length
  if (isLoading) return <div className="skeleton" style={{ height: 160, borderRadius: 22 }} />
  if (!data.length) return <section data-card className="card" style={{ padding: 28, textAlign: 'center' }}><h2 style={{ fontSize: 22 }}>No policies yet</h2><p className="dim" style={{ marginTop: 6 }}>Company policies published by HR will appear here.</p></section>
  return (
    <div style={{ display: 'grid', gap: 'var(--gap)' }}>
      {todo > 0 && <section data-card className="card" style={{ padding: '14px 18px', borderLeft: '4px solid var(--honey)' }}><strong>{todo} polic{todo === 1 ? 'y' : 'ies'}</strong> <span className="dim">waiting for you to read and accept.</span></section>}
      {groups.map(([cat, list]) => (
        <section key={cat} data-card className="card" style={{ padding: 8 }}>
          <h2 style={{ fontSize: 18, padding: '10px 12px 6px' }}>{cat}</h2>
          {list.map((p) => (
            <Link key={p.id} to={`/policies/${p.id}`} className="row-link" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px', borderRadius: 14 }}>
              <span style={{ width: 34, height: 34, borderRadius: '50%', background: 'var(--well)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="book" size={16} /></span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontWeight: 500 }}>{p.title}</span>
                <span className="dim" style={{ fontSize: 12 }}>Version {p.version}{p.effectiveFrom ? ` · effective ${day(p.effectiveFrom)}` : ''}{p.status === 'accepted' && p.acceptedAt ? ` · accepted ${day(p.acceptedAt)}` : (p.status === 'pending' || p.status === 'overdue') && p.dueDate ? ` · accept by ${day(p.dueDate)}` : ''}</span>
              </span>
              <span className={`pill ${STATUS[p.status][0]}`}>{STATUS[p.status][1]}</span>
            </Link>
          ))}
        </section>
      ))}
    </div>
  )
}

function ManagePolicies() {
  const { data = [], isLoading } = useQuery({ queryKey: ['policies-manage'], queryFn: async () => (await api.get('/policies/manage')).data.data as Managed[] })
  const navigate = useNavigate()
  if (isLoading) return <div className="skeleton" style={{ height: 160, borderRadius: 22 }} />
  if (!data.length) return <section data-card className="card" style={{ padding: 28, textAlign: 'center' }}><p className="dim">No policies yet. Use “New policy”.</p></section>
  return (
    <section data-card className="card" style={{ padding: 8, overflowX: 'auto' }}>
      <table className="tbl" style={{ width: '100%', minWidth: 620 }}>
        <thead><tr><th>Policy</th><th>Version</th><th>Accepted</th><th /></tr></thead>
        <tbody>
          {data.map((p) => (
            <tr key={p.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/policies/${p.id}`)}>
              <td><div style={{ fontWeight: 500 }}>{p.title}</div><div className="dim" style={{ fontSize: 12 }}>{p.category}</div></td>
              <td>{p.version ? `v${p.version}` : <span className="pill info">Draft only</span>} {p.version && p.hasDraft && <span className="pill info" style={{ marginLeft: 4 }}>draft</span>}</td>
              <td className="num">{p.requiresAcceptance && p.version ? <>{p.accepted}/{p.audience} {p.overdue && <span className="pill danger" style={{ marginLeft: 4 }}>overdue</span>}</> : <span className="dim">—</span>}</td>
              <td style={{ textAlign: 'right' }}><Icon name="chevronRight" size={14} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

// ─── One policy ────────────────────────────────────────────────────────────────
export function PolicyPage() {
  const { id = '' } = useParams()
  const isAdmin = useIsAdmin()
  const qc = useQueryClient()
  const toast = useToast()
  const navigate = useNavigate()
  const { data: p, isLoading, error } = useQuery({ queryKey: ['policy', id], queryFn: async () => (await api.get(`/policies/${id}`)).data.data as Detail })
  const [editing, setEditing] = useState(false)
  const [drafting, setDrafting] = useState(false)
  const [showOld, setShowOld] = useState<string | null>(null)
  const root = useReveal<HTMLDivElement>(isLoading)
  const refresh = () => { qc.invalidateQueries({ queryKey: ['policy', id] }); qc.invalidateQueries({ queryKey: ['policies'] }); qc.invalidateQueries({ queryKey: ['policies-manage'] }); qc.invalidateQueries({ queryKey: ['nav-counts'] }) }
  const act = useMutation({ mutationFn: async (f: () => Promise<any>) => f(), onSuccess: refresh, onError: (e) => toast(errMsg(e), 'error') })
  if (isLoading) return <div className="skeleton" style={{ height: 240, borderRadius: 22 }} />
  if (error || !p) return <section className="card" style={{ padding: 28 }}><h2>Policy not found</h2><Link to="/policies" className="link">Back to policies</Link></section>
  const v = p.current
  return (
    <div ref={root}>
      <PageHeader title={p.title} sub={<>{p.category}{v ? ` · version ${v.version}${v.effectiveFrom ? ` · effective ${day(v.effectiveFrom)}` : ''}` : ' · not published yet'}</>}
        actions={<Link to="/policies" className="btn btn-ghost btn-sm"><Icon name="chevronLeft" size={14} /> All policies</Link>} />
      <div className="dgrid">
        <section data-card className={`card ${isAdmin ? 'span-8' : 'span-12'}`} style={{ padding: 24 }}>
          {v ? (
            <>
              {v.changeNote && v.version > 1 && <div className="well" style={{ padding: '10px 14px', marginBottom: 16, fontSize: 13 }}><strong style={{ fontWeight: 600 }}>What changed in v{v.version}:</strong> {v.changeNote}</div>}
              <div style={{ fontSize: 15, lineHeight: 1.7, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{v.body}</div>
              {p.requiresAcceptance && (
                <div style={{ marginTop: 22, paddingTop: 16, borderTop: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  {p.acceptedAt
                    ? <span className="pill ok">You accepted version {v.version} on {day(p.acceptedAt)}</span>
                    : <>
                        <button className="btn btn-primary" disabled={act.isPending} onClick={() => act.mutate(async () => { await api.post(`/policies/${p.id}/accept`); toast('Thanks, accepted') })}><Icon name="check" size={15} /> I have read and accept this policy</button>
                        {p.dueDate && <span className="dim" style={{ fontSize: 13 }}>Please accept by {day(p.dueDate)}</span>}
                      </>}
                </div>
              )}
            </>
          ) : <p className="dim">This policy hasn’t been published yet.{isAdmin && ' Write the draft and publish it.'}</p>}
          {p.history.length > 1 && (
            <div style={{ marginTop: 22 }}>
              <h3 style={{ fontSize: 15, marginBottom: 8 }}>Earlier versions</h3>
              {p.history.filter((h) => h.status === 'superseded').map((h) => (
                <div key={h.id} style={{ borderTop: '1px solid var(--line)', padding: '8px 0' }}>
                  <button className="link" onClick={() => setShowOld(showOld === h.id ? null : h.id)}>Version {h.version} · published {day(h.publishedAt)}{h.changeNote ? ` · ${h.changeNote}` : ''}</button>
                  {showOld === h.id && <div className="dim" style={{ fontSize: 13, whiteSpace: 'pre-wrap', marginTop: 8 }}>{h.body}</div>}
                </div>
              ))}
            </div>
          )}
        </section>
        {isAdmin && (
          <aside className="span-4" style={{ display: 'grid', gap: 'var(--gap)', alignContent: 'start' }}>
            <section data-card className="card" style={{ padding: 18, display: 'grid', gap: 8 }}>
              <h3 style={{ fontSize: 16 }}>Manage</h3>
              {p.draft ? (
                <div className="well" style={{ padding: 12, fontSize: 13 }}>
                  Draft v{p.draft.version} ready{p.draft.changeNote ? `: ${p.draft.changeNote}` : ''}
                  <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => setDrafting(true)}>Edit draft</button>
                    <button className="btn btn-primary btn-sm" disabled={act.isPending} onClick={() => { if (confirm(`Publish version ${p.draft!.version}?${p.requiresAcceptance ? ' Everyone in the audience will be asked to accept it.' : ''}`)) act.mutate(async () => { await api.post(`/policies/${p.id}/publish`, {}); toast(`Version ${p.draft!.version} published`) }) }}>Publish v{p.draft.version}</button>
                  </div>
                </div>
              ) : <button className="btn btn-ghost btn-sm" onClick={() => setDrafting(true)}><Icon name="file" size={14} /> Write a new version</button>}
              <button className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}><Icon name="sliders" size={14} /> Title, category & audience</button>
              <button className="btn btn-ghost btn-sm" disabled={act.isPending} onClick={() => { if (confirm(`Archive “${p.title}”? It disappears for everyone.`)) act.mutate(async () => { await api.post(`/policies/${p.id}/archive`); toast('Archived'); navigate('/policies') }) }}>Archive</button>
            </section>
            {v && p.requiresAcceptance && <Acceptances id={p.id} />}
          </aside>
        )}
      </div>
      {editing && <PolicyForm policy={p} onClose={() => { setEditing(false); refresh() }} />}
      {drafting && <DraftForm policy={p} onClose={() => { setDrafting(false); refresh() }} />}
    </div>
  )
}

function Acceptances({ id }: { id: string }) {
  const toast = useToast()
  const { data = [], refetch } = useQuery({ queryKey: ['policy-acceptances', id], queryFn: async () => (await api.get(`/policies/${id}/acceptances`)).data.data as { userId: string; name: string; acceptedAt: string | null }[] })
  const remind = useMutation({ mutationFn: () => api.post(`/policies/${id}/remind`), onSuccess: (r) => { toast(`Reminder sent to ${r.data.data.reminded}`); refetch() }, onError: (e) => toast(errMsg(e), 'error') })
  const pending = data.filter((x) => !x.acceptedAt).length
  return (
    <section data-card className="card" style={{ padding: 18 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <h3 style={{ fontSize: 16, flex: 1 }}>Accepted</h3>
        <span className="display num" style={{ fontSize: 26 }}>{data.length - pending}/{data.length}</span>
      </div>
      {pending > 0 && <button className="btn btn-ghost btn-sm" style={{ marginTop: 8, width: '100%' }} disabled={remind.isPending} onClick={() => remind.mutate()}><Icon name="bell" size={14} /> Remind {pending} who haven’t</button>}
      <ul style={{ listStyle: 'none', display: 'grid', gap: 6, marginTop: 12, maxHeight: 320, overflowY: 'auto' }}>
        {data.map((x) => <li key={x.userId} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}><Avatar name={x.name} size={24} /><span style={{ flex: 1 }}>{x.name}</span>{x.acceptedAt ? <span className="pill ok">{day(x.acceptedAt)}</span> : <span className="pill mute">pending</span>}</li>)}
      </ul>
    </section>
  )
}

function PolicyForm({ policy, onClose }: { policy?: Detail; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const navigate = useNavigate()
  const { data: tree } = useOrgTree()
  const { data: locations = [] } = useWorkLocations()
  const units = useMemo(() => flattenUnits(tree), [tree])
  const [f, setF] = useState({
    title: policy?.title ?? '', category: policy?.category ?? 'General', body: '', changeNote: '',
    requiresAcceptance: policy?.requiresAcceptance ?? true, acceptWithinDays: policy?.acceptWithinDays ?? 7,
    departmentIds: policy?.departmentIds ?? [], workLocationIds: policy?.workLocationIds ?? [],
  })
  const [busy, setBusy] = useState(false)
  const toggle = (k: 'departmentIds' | 'workLocationIds', id: string) => setF({ ...f, [k]: f[k].includes(id) ? f[k].filter((x) => x !== id) : [...f[k], id] })
  const save = async () => {
    setBusy(true)
    try {
      const meta = { title: f.title.trim(), category: f.category, requiresAcceptance: f.requiresAcceptance, acceptWithinDays: Number(f.acceptWithinDays) || 7, departmentIds: f.departmentIds, workLocationIds: f.workLocationIds }
      if (policy) { await api.patch(`/policies/${policy.id}`, meta); toast('Saved') }
      else { const r = await api.post('/policies', { ...meta, body: f.body.trim() }); toast('Draft created. Review it, then publish.'); navigate(`/policies/${r.data.data.id}`) }
      qc.invalidateQueries({ queryKey: ['policies-manage'] })
      onClose()
    } catch (e) { toast(errMsg(e), 'error') } finally { setBusy(false) }
  }
  return (
    <Modal open onClose={onClose} title={policy ? 'Policy details' : 'New policy'} width={680}>
      <div style={{ display: 'grid', gap: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
          <label className="field"><span>Title</span><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={140} placeholder="Code of conduct" /></label>
          <label className="field"><span>Category</span><input className="input" list="policy-cats" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} maxLength={60} /><datalist id="policy-cats">{CATEGORIES.map((c) => <option key={c} value={c} />)}</datalist></label>
        </div>
        {!policy && <label className="field"><span>Policy text</span><textarea className="input" rows={10} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} style={{ height: 'auto', padding: 12 }} placeholder="Paste or write the policy. It's saved as a draft until you publish it." /></label>}
        <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 8 }}>
          <legend className="dim" style={{ fontSize: 12, fontWeight: 500, marginBottom: 6 }}>Applies to: {!f.departmentIds.length && !f.workLocationIds.length ? 'everyone' : 'only the selected departments and/or offices'}</legend>
          {units.length > 0 && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{units.map((u) => <button type="button" key={u.id} className="chip" aria-pressed={f.departmentIds.includes(u.id)} onClick={() => toggle('departmentIds', u.id)} style={f.departmentIds.includes(u.id) ? { background: 'var(--night)', color: 'var(--night-ink)' } : undefined}>{u.name}</button>)}</div>}
          {(locations as any[]).length > 0 && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{(locations as any[]).map((l) => <button type="button" key={l.id} className="chip" aria-pressed={f.workLocationIds.includes(l.id)} onClick={() => toggle('workLocationIds', l.id)} style={f.workLocationIds.includes(l.id) ? { background: 'var(--night)', color: 'var(--night-ink)' } : undefined}><Icon name="pin" size={12} /> {l.name}</button>)}</div>}
        </fieldset>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={f.requiresAcceptance} onChange={(e) => setF({ ...f, requiresAcceptance: e.target.checked })} /> People must read and accept it</label>
          {f.requiresAcceptance && <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>within <input className="input" type="number" min={1} max={365} value={f.acceptWithinDays} onChange={(e) => setF({ ...f, acceptWithinDays: Number(e.target.value) })} style={{ width: 72, height: 32 }} /> days</label>}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || f.title.trim().length < 2 || (!policy && !f.body.trim())} onClick={save}>{policy ? 'Save' : 'Create draft'}</button>
        </div>
      </div>
    </Modal>
  )
}

function DraftForm({ policy, onClose }: { policy: Detail; onClose: () => void }) {
  const toast = useToast()
  const base = policy.draft ?? policy.current
  const [f, setF] = useState({ body: base?.body ?? '', changeNote: policy.draft?.changeNote ?? '' })
  const [busy, setBusy] = useState(false)
  const next = policy.draft?.version ?? (policy.current?.version ?? 0) + 1
  const save = async () => {
    setBusy(true)
    try { await api.put(`/policies/${policy.id}/draft`, { body: f.body.trim(), ...(f.changeNote.trim() && { changeNote: f.changeNote.trim() }) }); toast(`Draft v${next} saved`); onClose() }
    catch (e) { toast(errMsg(e), 'error') } finally { setBusy(false) }
  }
  return (
    <Modal open onClose={onClose} title={`Draft version ${next}`} width={720}>
      <div style={{ display: 'grid', gap: 12 }}>
        <label className="field"><span>Policy text</span><textarea className="input" rows={14} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} style={{ height: 'auto', padding: 12 }} /></label>
        {next > 1 && <label className="field"><span>What changed (shown to employees)</span><input className="input" value={f.changeNote} onChange={(e) => setF({ ...f, changeNote: e.target.value })} maxLength={500} placeholder="e.g. Work-from-home now 2 days a week" /></label>}
        <p className="muted" style={{ fontSize: 12 }}>Saving keeps it as a draft; nobody sees it until you publish.</p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !f.body.trim()} onClick={save}>Save draft</button>
        </div>
      </div>
    </Modal>
  )
}
