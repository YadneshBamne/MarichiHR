import { useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import { useAuth } from '../../contexts/AuthContext'
import PageHeader, { SearchField, EmptyState } from '../../components/ui/PageHeader'
import Icon from '../../components/ui/Icon'
import { useToast } from '../../components/ui/Toast'
import { useReveal } from '../../lib/motion'

// Helpdesk: raise a query to HR, follow it, reply, attach screenshots. HR also gets the whole queue with search and filters, owners, priority,
// internal notes, a response clock that pauses while a ticket waits on the requester, and category management.
const STATUS: Record<string, [string, string]> = { open: ['warn', 'Open'], in_progress: ['info', 'In progress'], waiting: ['honey', 'Waiting on you'], resolved: ['ok', 'Resolved'], closed: ['mute', 'Closed'] }
const STAFF_STATUS: Record<string, string> = { open: 'Open', in_progress: 'In progress', waiting: 'Waiting on the requester', resolved: 'Resolved', closed: 'Closed' }
const PRIORITY: Record<string, [string, string]> = { low: ['mute', 'Low'], normal: ['info', 'Normal'], high: ['warn', 'High'], urgent: ['danger', 'Urgent'] }
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
const Pill = ({ map, k, staff }: { map: Record<string, [string, string]>; k: string; staff?: boolean }) => <span className={`pill ${map[k]?.[0] ?? 'mute'}`}>{staff && STAFF_STATUS[k] && map === STATUS ? STAFF_STATUS[k] : map[k]?.[1] ?? k}</span>
const span = (ms: number) => { const h = Math.round(Math.abs(ms) / 3_600_000); return h < 1 ? 'under an hour' : h < 48 ? `${h} h` : `${Math.round(h / 24)} days` }
// The response clock in words
function clock(t: any): { text: string; tone: string } | null {
  if (['resolved', 'closed'].includes(t.status)) return null
  if (t.status === 'waiting') return { text: 'Response clock paused while it waits on the requester', tone: 'mute' }
  if (!t.dueAt) return null
  const ms = new Date(t.dueAt).getTime() - Date.now()
  return ms < 0 ? { text: `Past its target by ${span(ms)}`, tone: 'danger' } : { text: `Answer due in ${span(ms)}`, tone: ms < 4 * 3_600_000 ? 'warn' : 'mute' }
}
const uploadFile = (ticketId: string, file: File, internal = false) => {
  const fd = new FormData(); fd.append('file', file); if (internal) fd.append('internal', 'true')
  return api.post(`/helpdesk/tickets/${ticketId}/attachments`, fd, { headers: { 'Content-Type': 'multipart/form-data' } })
}
const openFile = async (ticketId: string, a: any) => { const r = (await api.get(`/helpdesk/tickets/${ticketId}/attachments/${a.id}`)).data.data; window.open(r.url, '_blank', 'noopener') }

export default function HelpdeskPage() {
  const { hasRole } = useAuth()
  const staff = hasRole('hr_admin') || hasRole('system_admin')
  const [params, setParams] = useSearchParams()
  const open = params.get('ticket')
  const [view, setView] = useState<'tickets' | 'categories'>('tickets')
  const [raising, setRaising] = useState(false)
  const root = useReveal<HTMLDivElement>(view + (open ?? '') + raising)
  const go = (id: string | null) => setParams(id ? { ticket: id } : {})
  return (
    <div ref={root}>
      <PageHeader title="Helpdesk" sub={staff ? 'Every question to HR, with owners, priorities and a response clock.' : "Ask HR a question or report a problem. You'll see the answer here and get a message when HR replies."} actions={!open && view === 'tickets' ? <button className="btn btn-primary" onClick={() => { setRaising(true); go(null) }}><Icon name="plus" size={15} /> New ticket</button> : undefined}>
        {staff && !open && <div role="tablist" style={{ display: 'flex', gap: 6 }}>{([['tickets', 'Tickets'], ['categories', 'Categories']] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={view === k} className={`btn btn-sm ${view === k ? 'btn-primary' : 'btn-ghost'}`} onClick={() => { setView(k); setRaising(false) }}>{l}</button>)}</div>}
      </PageHeader>
      {raising && !open && view === 'tickets' && <Raise onDone={(id) => { setRaising(false); go(id) }} onCancel={() => setRaising(false)} />}
      {open ? <Detail id={open} staff={staff} onBack={() => go(null)} /> : view === 'categories' && staff ? <Categories /> : <TicketList staff={staff} onOpen={go} />}
    </div>
  )
}

function TicketList({ staff, onOpen }: { staff: boolean; onOpen: (id: string) => void }) {
  const [f, setF] = useState({ scope: staff ? 'all' : 'mine', status: 'active', q: '', categoryId: '', priority: '', assignee: '', overdue: false, page: 1 })
  const set = (patch: Partial<typeof f>) => setF((p) => ({ ...p, page: 1, ...patch }))
  const cats = useQuery({ queryKey: ['helpdesk-cats', 'all'], enabled: staff, queryFn: async () => (await api.get('/helpdesk/categories', { params: { all: 1 } })).data.data as any[] })
  const list = useQuery({
    queryKey: ['helpdesk', f], placeholderData: (p) => p, refetchInterval: 60_000,
    queryFn: async () => (await api.get('/helpdesk/tickets', { params: { scope: f.scope, ...(f.status && !f.overdue ? { status: f.status } : {}), ...(f.q ? { q: f.q } : {}), ...(f.categoryId ? { categoryId: f.categoryId } : {}), ...(f.priority ? { priority: f.priority } : {}), ...(f.assignee ? { assignee: f.assignee } : {}), ...(f.overdue ? { overdue: 1 } : {}), page: f.page } })).data.data as { items: any[]; total: number; page: number; pages: number; counts: Record<string, number> },
  })
  const c = list.data?.counts
  const chips: [string, string, number | undefined][] = [['active', 'Active', c ? c.open + c.in_progress + c.waiting : undefined], ['open', 'Open', c?.open], ['in_progress', 'In progress', c?.in_progress], ['waiting', 'Waiting', c?.waiting], ['resolved', 'Resolved', c?.resolved], ['closed', 'Closed', c?.closed], ['', 'All', undefined]]
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {chips.map(([k, l, n]) => <button key={l} className={`btn btn-sm ${!f.overdue && f.status === k ? 'btn-primary' : 'btn-ghost'}`} onClick={() => set({ status: k, overdue: false })}>{l}{n ? ` (${n})` : ''}</button>)}
        {staff && <button className={`btn btn-sm ${f.overdue ? 'btn-primary' : 'btn-ghost'}`} onClick={() => set({ overdue: !f.overdue })}>Overdue{c?.overdue ? ` (${c.overdue})` : ''}</button>}
        <span style={{ flex: 1 }} />
        <SearchField value={f.q} onChange={(q) => set({ q })} placeholder="Search tickets" width={220} />
      </div>
      {staff && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <select className="input" style={{ width: 'auto' }} aria-label="Whose tickets" value={f.scope} onChange={(e) => set({ scope: e.target.value })}><option value="all">All tickets</option><option value="mine">Only mine</option></select>
          <select className="input" style={{ width: 'auto' }} aria-label="Owner" value={f.assignee} onChange={(e) => set({ assignee: e.target.value })}><option value="">Any owner</option><option value="me">Mine to answer</option><option value="none">Unassigned</option></select>
          <select className="input" style={{ width: 'auto' }} aria-label="Category" value={f.categoryId} onChange={(e) => set({ categoryId: e.target.value })}><option value="">Any category</option>{cats.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
          <select className="input" style={{ width: 'auto' }} aria-label="Priority" value={f.priority} onChange={(e) => set({ priority: e.target.value })}><option value="">Any priority</option>{Object.entries(PRIORITY).map(([k, [, l]]) => <option key={k} value={k}>{l}</option>)}</select>
        </div>
      )}
      <div className="card" style={{ padding: 8 }}>
        {list.isLoading && <p style={{ padding: 16, margin: 0 }}>Loading…</p>}
        {list.data?.items.length === 0 && <EmptyState icon={<Icon name="info" size={24} />} title={f.q || f.categoryId || f.priority || f.assignee ? 'No tickets match' : 'No tickets here'} body={staff ? 'Change the filters to see more.' : 'Use New ticket to ask HR something.'} />}
        {list.data?.items.map((t) => {
          const ck = clock(t)
          return (
            <button key={t.id} type="button" onClick={() => onOpen(t.id)} className="btn btn-ghost" style={{ display: 'flex', width: '100%', justifyContent: 'space-between', gap: 12, textAlign: 'left', height: 'auto', minHeight: 60, padding: '10px 14px', borderRadius: 16, border: 0 }}>
              <span style={{ minWidth: 0 }}>
                <strong>{t.number}</strong> {t.subject}
                <span className="dim" style={{ display: 'block', fontSize: 13 }}>{t.categoryName}{t.requesterName ? ` · ${t.requesterName}` : ''}{t.assigneeName ? ` · owner ${t.assigneeName}` : staff ? ' · unassigned' : ''} · {when(t.createdAt)}{ck && ` · ${ck.text.toLowerCase()}`}</span>
              </span>
              <span style={{ display: 'flex', gap: 6, alignItems: 'center', flex: 'none' }}>{t.overdue && <span className="pill danger">Overdue</span>}<Pill map={PRIORITY} k={t.priority} /><Pill map={STATUS} k={t.status} staff={staff} /></span>
            </button>
          )
        })}
      </div>
      {list.data && list.data.pages > 1 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center' }}>
          <button className="btn btn-ghost btn-sm" disabled={f.page <= 1} onClick={() => setF({ ...f, page: f.page - 1 })}>Previous</button>
          <span className="dim" style={{ fontSize: 13 }}>Page {list.data.page} of {list.data.pages} · {list.data.total} tickets</span>
          <button className="btn btn-ghost btn-sm" disabled={f.page >= list.data.pages} onClick={() => setF({ ...f, page: f.page + 1 })}>Next</button>
        </div>
      )}
    </div>
  )
}

function FilePicker({ files, setFiles }: { files: File[]; setFiles: (f: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" multiple hidden onChange={(e) => { setFiles([...files, ...Array.from(e.target.files ?? [])].slice(0, 3)); e.target.value = '' }} />
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => input.current?.click()} disabled={files.length >= 3}><Icon name="file" size={14} /> Attach a photo or PDF</button>
      {files.map((x, i) => <span key={i} className="pill mute" style={{ textTransform: 'none' }}>{x.name} <button type="button" className="link" aria-label={`Remove ${x.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}>×</button></span>)}
    </div>
  )
}

function Raise({ onDone, onCancel }: { onDone: (id: string) => void; onCancel: () => void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const cats = useQuery({ queryKey: ['helpdesk-cats'], queryFn: async () => (await api.get('/helpdesk/categories')).data.data as any[] })
  const [f, setF] = useState({ categoryId: '', subject: '', description: '', priority: 'normal' })
  const [files, setFiles] = useState<File[]>([])
  const m = useMutation({
    mutationFn: async () => {
      const t = (await api.post('/helpdesk/tickets', { ...f, categoryId: f.categoryId || cats.data?.[0]?.id })).data.data
      let failed = 0
      for (const x of files) { try { await uploadFile(t.id, x) } catch { failed++ } }
      return { t, failed }
    },
    onSuccess: ({ t, failed }) => { toast(failed ? `${t.number} raised, but ${failed} file${failed > 1 ? 's' : ''} could not be attached` : `${t.number} raised. HR has been told.`, failed ? 'error' : undefined); qc.invalidateQueries({ queryKey: ['helpdesk'] }); onDone(t.id) },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value })
  return (
    <div className="card" style={{ padding: 20, marginBottom: 16, display: 'grid', gap: 14 }}>
      <div className="field"><label htmlFor="hd-cat">What is it about?</label>
        <select id="hd-cat" className="input" value={f.categoryId || cats.data?.[0]?.id || ''} onChange={set('categoryId')}>{cats.data?.map((c) => <option key={c.id} value={c.id}>{c.name} (we aim to answer within {c.responseHours} h)</option>)}</select></div>
      <div className="field"><label htmlFor="hd-sub">Subject</label><input id="hd-sub" className="input" value={f.subject} onChange={set('subject')} maxLength={140} placeholder="A short summary" /></div>
      <div className="field"><label htmlFor="hd-desc">Details</label><textarea id="hd-desc" className="input" rows={4} style={{ height: 'auto', padding: 14, borderRadius: 20 }} value={f.description} onChange={set('description')} maxLength={4000} placeholder="What happened, and what do you need?" /></div>
      <div className="field"><label htmlFor="hd-pri">How urgent is it?</label>
        <select id="hd-pri" className="input" value={f.priority} onChange={set('priority')}>{Object.entries(PRIORITY).map(([k, [, l]]) => <option key={k} value={k}>{l}</option>)}</select></div>
      <FilePicker files={files} setFiles={setFiles} />
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
  const me = useAuth().user
  const { data: t } = useQuery({ queryKey: ['helpdesk-ticket', id], queryFn: async () => (await api.get(`/helpdesk/tickets/${id}`)).data.data })
  const team = useQuery({ queryKey: ['helpdesk-staff'], enabled: staff, queryFn: async () => (await api.get('/helpdesk/staff')).data.data as { id: string; name: string }[] })
  const [body, setBody] = useState('')
  const [internal, setInternal] = useState(false)
  const [files, setFiles] = useState<File[]>([])
  const refresh = () => { qc.invalidateQueries({ queryKey: ['helpdesk-ticket', id] }); qc.invalidateQueries({ queryKey: ['helpdesk'] }) }
  const send = useMutation({
    mutationFn: async () => {
      if (body.trim()) await api.post(`/helpdesk/tickets/${id}/comments`, { body, internal })
      let failed = 0
      for (const x of files) { try { await uploadFile(id, x, internal) } catch { failed++ } }
      return failed
    },
    onSuccess: (failed) => { setBody(''); setInternal(false); setFiles([]); if (failed) toast(`${failed} file${failed > 1 ? 's' : ''} could not be attached`, 'error'); refresh() },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  const patch = useMutation({ mutationFn: async (b: Record<string, unknown>) => api.patch(`/helpdesk/tickets/${id}`, b), onSuccess: refresh, onError: (e) => toast(errMsg(e), 'error') })
  if (!t) return <p>Loading…</p>
  const mine = t.requesterUserId === me?.id
  const ck = clock(t)
  const isOpenFile = (a: any) => openFile(id, a).catch((e) => toast(errMsg(e), 'error'))
  return (
    <div className="card" style={{ padding: 20, display: 'grid', gap: 16 }}>
      <div><button className="btn btn-ghost btn-sm" onClick={onBack}>Back to tickets</button></div>
      <div>
        <h2 style={{ margin: 0 }}>{t.number} · {t.subject}</h2>
        <p className="dim" style={{ margin: '6px 0 0' }}>{t.categoryName}{t.requesterName ? ` · ${t.requesterName}` : ''} · {when(t.createdAt)}{t.assigneeName ? ` · owner ${t.assigneeName}` : ''}</p>
        <div style={{ display: 'flex', gap: 6, margin: '10px 0', flexWrap: 'wrap', alignItems: 'center' }}><Pill map={PRIORITY} k={t.priority} /><Pill map={STATUS} k={t.status} staff={staff} />{t.overdue && <span className="pill danger">Overdue</span>}{ck && <span className={`pill ${ck.tone}`} style={{ textTransform: 'none' }}>{ck.text}</span>}</div>
        <p style={{ whiteSpace: 'pre-wrap' }}>{t.description}</p>
        {t.attachments?.length > 0 && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{t.attachments.map((a: any) => <button key={a.id} type="button" className="btn btn-ghost btn-sm" onClick={() => isOpenFile(a)}><Icon name="file" size={14} /> {a.name}{a.internal ? ' (internal)' : ''}</button>)}</div>}
      </div>
      {staff && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <select aria-label="Status" className="input" style={{ width: 'auto' }} value={t.status} onChange={(e) => patch.mutate({ status: e.target.value })}>{Object.entries(STAFF_STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <select aria-label="Priority" className="input" style={{ width: 'auto' }} value={t.priority} onChange={(e) => patch.mutate({ priority: e.target.value })}>{Object.entries(PRIORITY).map(([k, [, l]]) => <option key={k} value={k}>{l} priority</option>)}</select>
          <select aria-label="Owner" className="input" style={{ width: 'auto' }} value={t.assigneeUserId ?? ''} onChange={(e) => patch.mutate({ assigneeUserId: e.target.value || null })}><option value="">Unassigned</option>{team.data?.map((p) => <option key={p.id} value={p.id}>{p.id === me?.id ? 'Me' : p.name}</option>)}</select>
        </div>
      )}
      {!staff && mine && (t.status === 'closed' ? <div><button className="btn btn-ghost btn-sm" onClick={() => patch.mutate({ status: 'open' })}>Reopen</button></div> : <div><button className="btn btn-ghost btn-sm" onClick={() => patch.mutate({ status: 'closed' })}>Close this ticket</button></div>)}
      <div style={{ display: 'grid', gap: 10 }}>
        {t.comments.map((c: any) => (
          <div key={c.id} style={{ padding: '12px 16px', borderRadius: 20, background: c.internal ? 'var(--honey-2)' : c.userId === me?.id ? 'var(--well)' : 'var(--card)', border: '1px solid var(--line-2)' }}>
            <div className="dim" style={{ fontSize: 13 }}>{c.name} · {when(c.at)}{c.internal ? ' · internal note' : ''}</div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{c.body}</div>
          </div>
        ))}
      </div>
      {t.status !== 'closed' && (
        <div style={{ display: 'grid', gap: 8 }}>
          <label htmlFor="hd-reply" style={{ fontWeight: 600, fontSize: 13 }}>{t.status === 'waiting' && mine ? 'HR is waiting for your reply' : 'Reply'}</label>
          <textarea id="hd-reply" className="input" rows={3} style={{ height: 'auto', padding: 14, borderRadius: 20 }} value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} />
          <FilePicker files={files} setFiles={setFiles} />
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn btn-primary" disabled={(!body.trim() && !files.length) || send.isPending} onClick={() => send.mutate()}>{send.isPending ? 'Sending…' : 'Send'}</button>
            {staff && <label style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 44 }}><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Internal (the employee won't see it)</label>}
          </div>
        </div>
      )}
    </div>
  )
}

// HR: what people can raise a ticket about, and how fast HR aims to answer
function Categories() {
  const toast = useToast()
  const qc = useQueryClient()
  const cats = useQuery({ queryKey: ['helpdesk-cats', 'all'], queryFn: async () => (await api.get('/helpdesk/categories', { params: { all: 1 } })).data.data as any[] })
  const [add, setAdd] = useState({ name: '', responseHours: 24 })
  const refresh = () => { qc.invalidateQueries({ queryKey: ['helpdesk-cats'] }) }
  const patch = useMutation({ mutationFn: async (v: { id: string; b: Record<string, unknown> }) => api.patch(`/helpdesk/categories/${v.id}`, v.b), onSuccess: () => { toast('Saved'); refresh() }, onError: (e) => toast(errMsg(e), 'error') })
  const create = useMutation({ mutationFn: async () => api.post('/helpdesk/categories', add), onSuccess: () => { toast('Category added'); setAdd({ name: '', responseHours: 24 }); refresh() }, onError: (e) => toast(errMsg(e), 'error') })
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <p className="dim" style={{ margin: 0 }}>People choose a category when they raise a ticket. The hours are how fast HR aims to answer a normal ticket; urgent is a quarter of that, high half, low double. The clock pauses while a ticket waits on the requester. A category you switch off cannot be picked any more; old tickets keep it.</p>
      {cats.data?.map((c) => <CategoryRow key={c.id} c={c} busy={patch.isPending} onSave={(b) => patch.mutate({ id: c.id, b })} />)}
      <div className="card" style={{ padding: 16, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'end' }}>
        <label className="field" style={{ flex: '1 1 220px' }}><span>New category</span><input className="input" value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} maxLength={60} placeholder="For example Benefits" /></label>
        <label className="field" style={{ width: 130 }}><span>Answer within (h)</span><input className="input" inputMode="numeric" value={add.responseHours} onChange={(e) => setAdd({ ...add, responseHours: Number(e.target.value) || 24 })} /></label>
        <button className="btn btn-primary" disabled={create.isPending || add.name.trim().length < 2} onClick={() => create.mutate()}>Add</button>
      </div>
    </div>
  )
}
function CategoryRow({ c, busy, onSave }: { c: any; busy: boolean; onSave: (b: Record<string, unknown>) => void }) {
  const [name, setName] = useState(c.name)
  const [hours, setHours] = useState(String(c.responseHours))
  const dirty = name.trim() !== c.name || Number(hours) !== c.responseHours
  return (
    <div className="card" style={{ padding: 14, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', opacity: c.active === false ? 0.6 : 1 }}>
      <input className="input" style={{ flex: '1 1 200px' }} aria-label={`Name of ${c.name}`} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
      <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input className="input" style={{ width: 80 }} inputMode="numeric" aria-label={`Hours for ${c.name}`} value={hours} onChange={(e) => setHours(e.target.value)} /> <span className="dim">hours</span></label>
      <button className="btn btn-primary btn-sm" disabled={busy || !dirty || name.trim().length < 2 || !Number(hours)} onClick={() => onSave({ name: name.trim(), responseHours: Number(hours) })}>Save</button>
      <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => onSave({ active: c.active === false })}>{c.active === false ? 'Switch on' : 'Switch off'}</button>
    </div>
  )
}
