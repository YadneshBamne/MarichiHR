import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import { useAuth } from '../../contexts/AuthContext'
import PageHeader from '../../components/ui/PageHeader'
import Icon from '../../components/ui/Icon'
import { useToast } from '../../components/ui/Toast'
import { useReveal } from '../../lib/motion'

const CATEGORIES = ['Harassment', 'Discrimination', 'Pay & benefits', 'Workplace safety', 'Manager or team conflict', 'Policy violation', 'Facilities', 'Other']
const SEVERITY: Record<string, [string, string]> = { low: ['mute', 'Low'], medium: ['info', 'Medium'], high: ['warn', 'High'], critical: ['danger', 'Critical'] }
const STATUS: Record<string, [string, string]> = { open: ['warn', 'Open'], in_review: ['info', 'In review'], resolved: ['ok', 'Resolved'], closed: ['mute', 'Closed'] }
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
const Pill = ({ map, k }: { map: Record<string, [string, string]>; k: string }) => <span className={`pill ${map[k]?.[0] ?? 'mute'}`}>{map[k]?.[1] ?? k}</span>

type Tab = 'queue' | 'raise' | 'mine' | 'anonymous'

export default function GrievancesPage() {
  const { hasRole } = useAuth()
  const isHR = hasRole('hr_admin')
  const [tab, setTab] = useState<Tab>(isHR ? 'queue' : 'raise')
  const root = useReveal<HTMLDivElement>(tab)
  const tabs: [Tab, string][] = [...(isHR ? [['queue', 'Case queue'] as [Tab, string]] : []), ['raise', 'Raise a concern'], ['mine', 'My cases'], ['anonymous', 'Anonymous case']]
  return (
    <div ref={root}>
      <PageHeader title="Grievances" sub="A confidential way to raise a concern. Only HR can read cases, never your manager.">
        <div role="tablist" style={{ display: 'flex', gap: 6, marginTop: 14, flexWrap: 'wrap' }}>
          {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`btn btn-sm ${tab === k ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab(k)}>{l}</button>)}
        </div>
      </PageHeader>
      {tab === 'queue' && <Queue />}
      {tab === 'raise' && <Raise onRaised={() => setTab('mine')} />}
      {tab === 'mine' && <MyCases />}
      {tab === 'anonymous' && <AnonymousCase />}
    </div>
  )
}

function Raise({ onRaised }: { onRaised: () => void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const [f, setF] = useState({ category: '', subject: '', description: '', severity: 'medium', anonymous: false })
  const [done, setDone] = useState<{ ticketNo: string; caseKey: string | null } | null>(null)
  const raise = useMutation({
    mutationFn: async () => (await api.post('/grievances', f)).data.data,
    onSuccess: (d) => { setDone({ ticketNo: d.ticketNo, caseKey: d.caseKey }); qc.invalidateQueries({ queryKey: ['grievances-mine'] }) },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  if (done) {
    return (
      <section data-card className="card" style={{ padding: 24, display: 'grid', gap: 12 }}>
        <h2 style={{ fontSize: 24 }}>Case {done.ticketNo} filed</h2>
        {done.caseKey ? (
          <>
            <p>This case is anonymous: we don’t store who you are. To follow it up or reply, you’ll need this case key. <strong>Save it now; it can’t be shown again or recovered.</strong></p>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <code style={{ fontSize: 20, letterSpacing: 1, background: 'var(--well)', padding: '10px 14px', borderRadius: 12 }}>{done.caseKey}</code>
              <button className="btn btn-ghost btn-sm" onClick={() => { navigator.clipboard?.writeText(done.caseKey!); toast('Case key copied') }}>Copy</button>
            </div>
            <p className="dim" style={{ fontSize: 13 }}>Check its progress any time under “Anonymous case”.</p>
          </>
        ) : <p>HR has been notified. You’ll get a notification when they reply or the status changes. Follow it under “My cases”.</p>}
        <div style={{ display: 'flex', gap: 8 }}>
          {!done.caseKey && <button className="btn btn-primary btn-sm" onClick={onRaised}>Go to my cases</button>}
          <button className="btn btn-ghost btn-sm" onClick={() => { setDone(null); setF({ category: '', subject: '', description: '', severity: 'medium', anonymous: false }) }}>Raise another</button>
        </div>
      </section>
    )
  }
  return (
    <section data-card className="card" style={{ padding: 24, display: 'grid', gap: 12, maxWidth: 760 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        <label className="field"><span>What is it about?</span>
          <select className="input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option value="">Choose…</option>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select>
        </label>
        <label className="field"><span>How serious is it?</span>
          <select className="input" value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}>
            <option value="low">Low: an annoyance (HR aims to respond within 14 days)</option>
            <option value="medium">Medium: affecting my work (7 days)</option>
            <option value="high">High: serious, needs quick action (5 days)</option>
            <option value="critical">Critical: safety or harassment (2 days)</option>
          </select>
        </label>
      </div>
      <label className="field"><span>Subject</span><input className="input" value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} maxLength={140} /></label>
      <label className="field"><span>What happened? Include dates, places and anyone involved.</span><textarea className="input" rows={8} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} style={{ height: 'auto', padding: 12 }} maxLength={10000} /></label>
      <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13, background: 'var(--well)', padding: 12, borderRadius: 14 }}>
        <input type="checkbox" checked={f.anonymous} onChange={(e) => setF({ ...f, anonymous: e.target.checked })} style={{ marginTop: 3 }} />
        <span><strong>Raise it anonymously.</strong> Your name isn’t stored anywhere, not even for HR. You’ll get a case key to follow up instead. HR may find it harder to investigate without being able to talk to you.</span>
      </label>
      <div><button className="btn btn-primary" disabled={raise.isPending || !f.category || f.subject.trim().length < 3 || f.description.trim().length < 10} onClick={() => raise.mutate()}>{raise.isPending ? 'Filing…' : 'Submit to HR'}</button></div>
    </section>
  )
}

function MyCases() {
  const { data = [], isLoading } = useQuery({ queryKey: ['grievances-mine'], queryFn: async () => (await api.get('/grievances/mine')).data.data as any[] })
  if (isLoading) return <div className="skeleton" style={{ height: 120, borderRadius: 22 }} />
  if (!data.length) return <section data-card className="card" style={{ padding: 24 }}><p className="dim">You haven’t raised any cases under your name. Anonymous cases are under “Anonymous case”.</p></section>
  return (
    <section data-card className="card" style={{ padding: 8 }}>
      {data.map((g) => (
        <Link key={g.id} to={`/grievances/mine/${g.id}`} className="row-link" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 12, borderRadius: 14 }}>
          <span className="num dim" style={{ fontSize: 12, width: 74 }}>{g.ticketNo}</span>
          <span style={{ flex: 1, minWidth: 0 }}><span style={{ display: 'block', fontWeight: 500 }}>{g.subject}</span><span className="dim" style={{ fontSize: 12 }}>{g.category} · {when(g.createdAt)}</span></span>
          <Pill map={STATUS} k={g.status} />
        </Link>
      ))}
    </section>
  )
}

function AnonymousCase() {
  const toast = useToast()
  const [key, setKey] = useState('')
  const [c, setC] = useState<any>(null)
  const look = useMutation({ mutationFn: async (k: string) => (await api.post('/grievances/anonymous/view', { caseKey: k })).data.data, onSuccess: setC, onError: (e) => toast(errMsg(e), 'error') })
  const reply = useMutation({ mutationFn: (body: string) => api.post('/grievances/anonymous/messages', { caseKey: key, body }), onSuccess: () => { toast('Sent to HR'); look.mutate(key) }, onError: (e) => toast(errMsg(e), 'error') })
  return (
    <div style={{ display: 'grid', gap: 'var(--gap)' }}>
      <section data-card className="card" style={{ padding: 20, display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label className="field" style={{ flex: '1 1 260px' }}><span>Case key</span><input className="input" value={key} onChange={(e) => setKey(e.target.value.toUpperCase())} placeholder="XXXXXXXX-XXXXXXXX-XXXXXXXX" autoComplete="off" spellCheck={false} /></label>
        <button className="btn btn-primary" disabled={look.isPending || key.trim().length < 10} onClick={() => look.mutate(key)}>Open case</button>
      </section>
      {c && <RaiserCase c={c} onReply={(b) => reply.mutate(b)} sending={reply.isPending} />}
    </div>
  )
}

export function MyCasePage() {
  const { id = '' } = useParams()
  const toast = useToast()
  const { data: c, refetch, isLoading } = useQuery({ queryKey: ['grievance-mine', id], queryFn: async () => (await api.get(`/grievances/mine/${id}`)).data.data })
  const reply = useMutation({ mutationFn: (body: string) => api.post(`/grievances/mine/${id}/messages`, { body }), onSuccess: () => { toast('Sent to HR'); refetch() }, onError: (e) => toast(errMsg(e), 'error') })
  const root = useReveal<HTMLDivElement>(isLoading)
  if (isLoading) return <div className="skeleton" style={{ height: 200, borderRadius: 22 }} />
  if (!c) return <section className="card" style={{ padding: 24 }}>Case not found. <Link className="link" to="/grievances">Back</Link></section>
  return (
    <div ref={root}>
      <PageHeader title={`Case ${c.ticketNo}`} sub={c.subject} actions={<Link to="/grievances" className="btn btn-ghost btn-sm"><Icon name="chevronLeft" size={14} /> Grievances</Link>} />
      <RaiserCase c={c} onReply={(b) => reply.mutate(b)} sending={reply.isPending} />
    </div>
  )
}

function RaiserCase({ c, onReply, sending }: { c: any; onReply: (b: string) => void; sending: boolean }) {
  const [msg, setMsg] = useState('')
  return (
    <section data-card className="card" style={{ padding: 22, display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <span className="num dim" style={{ fontSize: 12 }}>{c.ticketNo}</span><Pill map={STATUS} k={c.status} /><Pill map={SEVERITY} k={c.severity} /><span className="pill mute">{c.category}</span>{c.anonymous && <span className="pill night">Anonymous</span>}
      </div>
      <div><h2 style={{ fontSize: 20 }}>{c.subject}</h2><p style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>{c.description}</p></div>
      {c.resolution && <div className="well" style={{ padding: 12 }}><strong>Outcome:</strong> {c.resolution}</div>}
      <Thread messages={c.messages.map((m: any) => ({ ...m, mine: m.from === 'you' }))} />
      {c.status !== 'closed' && (
        <div style={{ display: 'grid', gap: 8 }}>
          <textarea className="input" rows={3} value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Add information or reply to HR…" style={{ height: 'auto', padding: 12 }} maxLength={5000} />
          <div><button className="btn btn-primary btn-sm" disabled={sending || !msg.trim()} onClick={() => { onReply(msg.trim()); setMsg('') }}>Send</button></div>
        </div>
      )}
    </section>
  )
}

function Thread({ messages }: { messages: { id: string; from: string; body: string; createdAt: string; mine?: boolean; internal?: boolean }[] }) {
  if (!messages.length) return <p className="dim" style={{ fontSize: 13 }}>No messages yet.</p>
  return (
    <ul style={{ listStyle: 'none', display: 'grid', gap: 8 }}>
      {messages.map((m) => (
        <li key={m.id} style={{ justifySelf: m.mine ? 'end' : 'start', maxWidth: '85%', background: m.internal ? 'var(--honey-2)' : m.mine ? 'var(--night)' : 'var(--well)', color: m.mine && !m.internal ? 'var(--night-ink)' : 'var(--ink)', padding: '10px 14px', borderRadius: 16 }}>
          <div style={{ fontSize: 11, opacity: 0.75, marginBottom: 2 }}>{m.internal ? 'Internal note · ' : ''}{m.from} · {when(m.createdAt)}</div>
          <div style={{ whiteSpace: 'pre-wrap', fontSize: 14 }}>{m.body}</div>
        </li>
      ))}
    </ul>
  )
}

// ─── HR ───────────────────────────────────────────────────────────────────────
function Queue() {
  const navigate = useNavigate()
  const [status, setStatus] = useState('active')
  const { data = [], isLoading } = useQuery({ queryKey: ['grievances', status], queryFn: async () => (await api.get('/grievances', { params: status === 'all' ? {} : { status } })).data.data as any[] })
  return (
    <section data-card className="card" style={{ padding: 8, overflowX: 'auto' }}>
      <div style={{ display: 'flex', gap: 6, padding: 8, flexWrap: 'wrap' }}>
        {[['active', 'Open & in review'], ['resolved', 'Resolved'], ['closed', 'Closed'], ['all', 'All']].map(([k, l]) => <button key={k} className={`chip`} aria-pressed={status === k} onClick={() => setStatus(k)} style={status === k ? { background: 'var(--night)', color: 'var(--night-ink)' } : undefined}>{l}</button>)}
      </div>
      {isLoading ? <div className="skeleton" style={{ height: 120, borderRadius: 14, margin: 8 }} /> : !data.length ? <p className="dim" style={{ padding: 16 }}>No cases here.</p> : (
        <table className="tbl" style={{ width: '100%', minWidth: 720 }}>
          <thead><tr><th>Case</th><th>Severity</th><th>Status</th><th>Raised by</th><th>Handler</th><th>Due</th></tr></thead>
          <tbody>
            {data.map((g) => (
              <tr key={g.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/grievances/${g.id}`)}>
                <td><div style={{ fontWeight: 500 }}>{g.subject}</div><div className="dim" style={{ fontSize: 12 }}>{g.ticketNo} · {g.category}</div></td>
                <td><Pill map={SEVERITY} k={g.severity} /></td>
                <td><Pill map={STATUS} k={g.status} /></td>
                <td>{g.anonymous ? <span className="pill night">Anonymous</span> : g.raisedBy}</td>
                <td>{g.assignedTo ?? <span className="dim">Unassigned</span>}</td>
                <td className="num">{g.overdue ? <span className="pill danger">Overdue</span> : new Date(g.dueAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

export function HandlerCasePage() {
  const { id = '' } = useParams()
  const toast = useToast()
  const qc = useQueryClient()
  const { data: c, isLoading, refetch } = useQuery({ queryKey: ['grievance', id], queryFn: async () => (await api.get(`/grievances/${id}`)).data.data })
  const { data: handlers = [] } = useQuery({ queryKey: ['grievance-handlers'], queryFn: async () => (await api.get('/grievances/handlers')).data.data as { id: string; fullName: string }[] })
  const [msg, setMsg] = useState('')
  const [internal, setInternal] = useState(false)
  const [edit, setEdit] = useState<{ status?: string; severity?: string; assignedToUserId?: string | null; resolution?: string }>({})
  const done = () => { refetch(); qc.invalidateQueries({ queryKey: ['grievances'] }) }
  const reply = useMutation({ mutationFn: () => api.post(`/grievances/${id}/messages`, { body: msg.trim(), internal }), onSuccess: () => { setMsg(''); toast(internal ? 'Note added' : 'Reply sent'); done() }, onError: (e) => toast(errMsg(e), 'error') })
  const save = useMutation({ mutationFn: () => api.patch(`/grievances/${id}`, edit), onSuccess: () => { setEdit({}); toast('Case updated'); done() }, onError: (e) => toast(errMsg(e), 'error') })
  const root = useReveal<HTMLDivElement>(isLoading)
  if (isLoading) return <div className="skeleton" style={{ height: 240, borderRadius: 22 }} />
  if (!c) return <section className="card" style={{ padding: 24 }}>Case not found. <Link className="link" to="/grievances">Back</Link></section>
  const v = { status: edit.status ?? c.status, severity: edit.severity ?? c.severity, assignedToUserId: edit.assignedToUserId !== undefined ? edit.assignedToUserId : c.assignedToUserId, resolution: edit.resolution ?? c.resolution ?? '' }
  return (
    <div ref={root}>
      <PageHeader title={`Case ${c.ticketNo}`} sub={c.subject} actions={<Link to="/grievances" className="btn btn-ghost btn-sm"><Icon name="chevronLeft" size={14} /> Case queue</Link>} />
      <div className="dgrid">
        <section data-card className="card span-8" style={{ padding: 22, display: 'grid', gap: 14 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <Pill map={STATUS} k={c.status} /><Pill map={SEVERITY} k={c.severity} /><span className="pill mute">{c.category}</span>
            {c.anonymous ? <span className="pill night">Anonymous</span> : <span className="pill mute" style={{ textTransform: 'none' }}>Raised by {c.raisedBy}</span>}
            <span className="dim" style={{ fontSize: 12 }}>{when(c.createdAt)} · due {new Date(c.dueAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span>
          </div>
          <p style={{ whiteSpace: 'pre-wrap' }}>{c.description}</p>
          <Thread messages={c.messages.map((m: any) => ({ ...m, mine: m.role === 'handler' }))} />
          <div style={{ display: 'grid', gap: 8 }}>
            <textarea className="input" rows={3} value={msg} onChange={(e) => setMsg(e.target.value)} placeholder={internal ? 'Internal note (only HR sees it)…' : c.anonymous ? 'Reply to the anonymous raiser…' : 'Reply to the raiser…'} style={{ height: 'auto', padding: 12, background: internal ? 'var(--honey-2)' : undefined }} maxLength={5000} />
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <button className="btn btn-primary btn-sm" disabled={reply.isPending || !msg.trim()} onClick={() => reply.mutate()}>{internal ? 'Add note' : 'Send reply'}</button>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Internal note</label>
            </div>
          </div>
        </section>
        <aside data-card className="card span-4" style={{ padding: 18, display: 'grid', gap: 10, alignContent: 'start' }}>
          <h3 style={{ fontSize: 16 }}>Handle the case</h3>
          <label className="field"><span>Status</span><select className="input" value={v.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}>{Object.entries(STATUS).map(([k, [, l]]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label className="field"><span>Severity</span><select className="input" value={v.severity} onChange={(e) => setEdit({ ...edit, severity: e.target.value })}>{Object.entries(SEVERITY).map(([k, [, l]]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label className="field"><span>Handler</span><select className="input" value={v.assignedToUserId ?? ''} onChange={(e) => setEdit({ ...edit, assignedToUserId: e.target.value || null })}><option value="">Unassigned</option>{handlers.map((h) => <option key={h.id} value={h.id}>{h.fullName}</option>)}</select></label>
          <label className="field"><span>Resolution (shown to the raiser)</span><textarea className="input" rows={4} value={v.resolution} onChange={(e) => setEdit({ ...edit, resolution: e.target.value })} style={{ height: 'auto', padding: 10 }} maxLength={5000} /></label>
          <button className="btn btn-primary btn-sm" disabled={save.isPending || !Object.keys(edit).length} onClick={() => save.mutate()}>Save changes</button>
        </aside>
      </div>
    </div>
  )
}
