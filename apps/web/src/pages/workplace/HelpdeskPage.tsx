import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import { useAuth } from '../../contexts/AuthContext'
import PageHeader from '../../components/ui/PageHeader'
import { useToast } from '../../components/ui/Toast'
import { useReveal } from '../../lib/motion'

const STATUS: Record<string, [string, string]> = { open: ['warn', 'Open'], in_progress: ['info', 'In progress'], waiting: ['honey', 'Waiting on you'], resolved: ['ok', 'Resolved'], closed: ['mute', 'Closed'] }
const PRIORITY: Record<string, [string, string]> = { low: ['mute', 'Low'], normal: ['info', 'Normal'], high: ['warn', 'High'], urgent: ['danger', 'Urgent'] }
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
const Pill = ({ map, k }: { map: Record<string, [string, string]>; k: string }) => <span className={`pill ${map[k]?.[0] ?? 'mute'}`}>{map[k]?.[1] ?? k}</span>

// Helpdesk: raise a query to HR, follow it, reply. HR admins also get the whole queue, owners, priority and internal notes.
export default function HelpdeskPage() {
  const { hasRole } = useAuth()
  const staff = hasRole('hr_admin') || hasRole('system_admin')
  const [scope, setScope] = useState<'mine' | 'all'>(staff ? 'all' : 'mine')
  const [open, setOpen] = useState<string | null>(null)
  const [raising, setRaising] = useState(false)
  const root = useReveal<HTMLDivElement>(scope + (open ?? ''))
  const list = useQuery({ queryKey: ['helpdesk', scope], queryFn: async () => (await api.get('/helpdesk/tickets', { params: { scope } })).data.data as any[] })
  return (
    <div ref={root}>
      <PageHeader title="Helpdesk" sub="Ask HR a question or report a problem. You'll see the answer here." actions={<button className="btn btn-primary" onClick={() => { setRaising(true); setOpen(null) }}>New ticket</button>}>
        {staff && (
          <div role="tablist" style={{ display: 'flex', gap: 6, marginTop: 14 }}>
            {(['all', 'mine'] as const).map((k) => <button key={k} role="tab" aria-selected={scope === k} className={`btn btn-sm ${scope === k ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setScope(k)}>{k === 'all' ? 'All tickets' : 'My tickets'}</button>)}
          </div>
        )}
      </PageHeader>
      {raising && <Raise onDone={(id) => { setRaising(false); setOpen(id); list.refetch() }} onCancel={() => setRaising(false)} />}
      {open ? <Detail id={open} staff={staff} onBack={() => setOpen(null)} /> : (
        <div className="card" style={{ padding: 8 }}>
          {list.isLoading && <p style={{ padding: 16 }}>Loading…</p>}
          {list.data?.length === 0 && <p style={{ padding: 16, margin: 0 }}>No tickets yet.</p>}
          {list.data?.map((t) => (
            <button key={t.id} type="button" onClick={() => setOpen(t.id)} className="btn btn-ghost" style={{ display: 'flex', width: '100%', justifyContent: 'space-between', gap: 12, textAlign: 'left', height: 'auto', minHeight: 56, padding: '10px 14px', borderRadius: 16, border: 0 }}>
              <span style={{ minWidth: 0 }}>
                <strong>{t.number}</strong> {t.subject}
                <span style={{ display: 'block', fontSize: 13, opacity: 0.7 }}>{t.categoryName}{t.requesterName ? ` · ${t.requesterName}` : ''} · {when(t.createdAt)}</span>
              </span>
              <span style={{ display: 'flex', gap: 6, alignItems: 'center', flex: 'none' }}>
                {t.overdue && <span className="pill danger">Overdue</span>}<Pill map={PRIORITY} k={t.priority} /><Pill map={STATUS} k={t.status} />
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function Raise({ onDone, onCancel }: { onDone: (id: string) => void; onCancel: () => void }) {
  const toast = useToast()
  const cats = useQuery({ queryKey: ['helpdesk-cats'], queryFn: async () => (await api.get('/helpdesk/categories')).data.data as any[] })
  const [f, setF] = useState({ categoryId: '', subject: '', description: '', priority: 'normal' })
  const m = useMutation({ mutationFn: async () => (await api.post('/helpdesk/tickets', { ...f, categoryId: f.categoryId || cats.data?.[0]?.id })).data.data, onSuccess: (t) => { toast(`${t.number} raised`); onDone(t.id) }, onError: (e) => toast(errMsg(e), 'error') })
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value })
  return (
    <div className="card" style={{ padding: 20, marginBottom: 16, display: 'grid', gap: 14 }}>
      <div className="field"><label htmlFor="hd-cat">What is it about?</label>
        <select id="hd-cat" className="input" value={f.categoryId || cats.data?.[0]?.id || ''} onChange={set('categoryId')}>{cats.data?.map((c) => <option key={c.id} value={c.id}>{c.name} (answered within {c.responseHours}h)</option>)}</select></div>
      <div className="field"><label htmlFor="hd-sub">Subject</label><input id="hd-sub" className="input" value={f.subject} onChange={set('subject')} maxLength={140} /></div>
      <div className="field"><label htmlFor="hd-desc">Details</label><textarea id="hd-desc" className="input" rows={4} style={{ height: 'auto', padding: 14, borderRadius: 20 }} value={f.description} onChange={set('description')} maxLength={4000} /></div>
      <div className="field"><label htmlFor="hd-pri">Priority</label>
        <select id="hd-pri" className="input" value={f.priority} onChange={set('priority')}>{Object.entries(PRIORITY).map(([k, [, l]]) => <option key={k} value={k}>{l}</option>)}</select></div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-primary" disabled={m.isPending || f.subject.trim().length < 3 || f.description.trim().length < 3} onClick={() => m.mutate()}>{m.isPending ? 'Sending…' : 'Send to HR'}</button>
        <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

function Detail({ id, staff, onBack }: { id: string; staff: boolean; onBack: () => void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const { data: t } = useQuery({ queryKey: ['helpdesk-ticket', id], queryFn: async () => (await api.get(`/helpdesk/tickets/${id}`)).data.data })
  const [body, setBody] = useState('')
  const [internal, setInternal] = useState(false)
  const refresh = () => { qc.invalidateQueries({ queryKey: ['helpdesk-ticket', id] }); qc.invalidateQueries({ queryKey: ['helpdesk'] }) }
  const send = useMutation({ mutationFn: async () => api.post(`/helpdesk/tickets/${id}/comments`, { body, internal }), onSuccess: () => { setBody(''); setInternal(false); refresh() }, onError: (e) => toast(errMsg(e), 'error') })
  const patch = useMutation({ mutationFn: async (b: Record<string, unknown>) => api.patch(`/helpdesk/tickets/${id}`, b), onSuccess: refresh, onError: (e) => toast(errMsg(e), 'error') })
  const me = useAuth().user
  if (!t) return <p>Loading…</p>
  const mine = t.requesterUserId === me?.id
  return (
    <div className="card" style={{ padding: 20, display: 'grid', gap: 16 }}>
      <div><button className="btn btn-ghost btn-sm" onClick={onBack}>Back</button></div>
      <div>
        <h2 style={{ margin: 0 }}>{t.number} · {t.subject}</h2>
        <p style={{ margin: '6px 0 0', opacity: 0.7 }}>{t.categoryName}{t.requesterName ? ` · ${t.requesterName}` : ''} · {when(t.createdAt)}</p>
        <div style={{ display: 'flex', gap: 6, margin: '10px 0' }}><Pill map={PRIORITY} k={t.priority} /><Pill map={STATUS} k={t.status} /></div>
        <p style={{ whiteSpace: 'pre-wrap' }}>{t.description}</p>
      </div>
      {staff && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <select aria-label="Status" className="input" style={{ width: 'auto' }} value={t.status} onChange={(e) => patch.mutate({ status: e.target.value })}>{Object.entries(STATUS).map(([k, [, l]]) => <option key={k} value={k}>{l}</option>)}</select>
          <select aria-label="Priority" className="input" style={{ width: 'auto' }} value={t.priority} onChange={(e) => patch.mutate({ priority: e.target.value })}>{Object.entries(PRIORITY).map(([k, [, l]]) => <option key={k} value={k}>{l}</option>)}</select>
          <button className="btn btn-ghost btn-sm" disabled={t.assigneeUserId === me?.id} onClick={() => patch.mutate({ assigneeUserId: me?.id })}>{t.assigneeUserId === me?.id ? 'Assigned to you' : 'Assign to me'}</button>
        </div>
      )}
      {!staff && mine && (t.status === 'closed' ? <div><button className="btn btn-ghost btn-sm" onClick={() => patch.mutate({ status: 'open' })}>Reopen</button></div> : <div><button className="btn btn-ghost btn-sm" onClick={() => patch.mutate({ status: 'closed' })}>Close this ticket</button></div>)}
      <div style={{ display: 'grid', gap: 10 }}>
        {t.comments.map((c: any) => (
          <div key={c.id} style={{ padding: '12px 16px', borderRadius: 20, background: c.internal ? '#fdf1c9' : c.userId === me?.id ? '#f4f1e8' : '#fff', border: '1.5px solid var(--line-2)' }}>
            <div style={{ fontSize: 13, opacity: 0.7 }}>{c.name} · {when(c.at)}{c.internal ? ' · internal note' : ''}</div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{c.body}</div>
          </div>
        ))}
      </div>
      {t.status !== 'closed' && (
        <div style={{ display: 'grid', gap: 8 }}>
          <label htmlFor="hd-reply" style={{ fontWeight: 600, fontSize: 13 }}>Reply</label>
          <textarea id="hd-reply" className="input" rows={3} style={{ height: 'auto', padding: 14, borderRadius: 20 }} value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} />
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <button className="btn btn-primary" disabled={!body.trim() || send.isPending} onClick={() => send.mutate()}>Send</button>
            {staff && <label style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 44 }}><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Internal note (the employee won't see it)</label>}
          </div>
        </div>
      )}
    </div>
  )
}
