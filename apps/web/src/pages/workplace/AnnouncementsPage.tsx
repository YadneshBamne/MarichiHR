import { useEffect, useMemo, useRef, useState } from 'react'
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

interface Item { id: string; title: string; body: string; pinned: boolean; requiresAck: boolean; publishAt: string; expiresAt: string | null; author: string; authorAvatar: string | null; read: boolean; acknowledged: boolean }
interface Managed { id: string; title: string; body: string; pinned: boolean; requiresAck: boolean; publishAt: string; expiresAt: string | null; departmentIds: string[]; workLocationIds: string[]; status: 'live' | 'scheduled' | 'expired'; audience: number; read: number; acknowledged: number }

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0)

export function flattenUnits(tree: any): { id: string; name: string; depth: number }[] {
  const out: { id: string; name: string; depth: number }[] = []
  const walk = (nodes: any[], depth: number) => (nodes ?? []).forEach((n) => { out.push({ id: n.id, name: n.name, depth }); walk(n.children ?? [], depth + 1) })
  walk(Array.isArray(tree) ? tree : tree ? [tree] : [], 0)
  return out
}

export default function AnnouncementsPage() {
  const { hasRole } = useAuth()
  const canManage = hasRole('hr_admin') || hasRole('system_admin')
  const [tab, setTab] = useState<'feed' | 'manage'>('feed')
  const [editing, setEditing] = useState<Managed | 'new' | null>(null)
  const [readersOf, setReadersOf] = useState<Managed | null>(null)
  const root = useReveal<HTMLDivElement>(tab)
  return (
    <div ref={root}>
      <PageHeader title="Announcements" sub="Company news and updates"
        actions={canManage ? <button className="btn btn-primary btn-sm" onClick={() => setEditing('new')}><Icon name="plus" size={14} /> New announcement</button> : undefined}>
        {canManage && (
          <div role="tablist" style={{ display: 'flex', gap: 6, marginTop: 14 }}>
            {([['feed', 'Feed'], ['manage', 'Manage']] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`btn btn-sm ${tab === k ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab(k)}>{l}</button>)}
          </div>
        )}
      </PageHeader>
      {tab === 'feed' ? <Feed /> : <Manage onEdit={setEditing} onReaders={setReadersOf} />}
      {editing && <Editor item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {readersOf && <Readers item={readersOf} onClose={() => setReadersOf(null)} />}
    </div>
  )
}

function Feed() {
  const qc = useQueryClient()
  const toast = useToast()
  const { data: items = [], isLoading } = useQuery({ queryKey: ['announcements'], queryFn: async () => (await api.get('/announcements')).data.data as Item[] })
  const mark = useMutation({
    mutationFn: ({ id, acknowledge }: { id: string; acknowledge?: boolean }) => api.post(`/announcements/${id}/read`, acknowledge ? { acknowledge } : {}),
    onSuccess: (_r, v) => { qc.invalidateQueries({ queryKey: ['announcements'] }); qc.invalidateQueries({ queryKey: ['nav-counts'] }); if (v.acknowledge) toast('Thanks, acknowledged') },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  // Seen = read: unread ones are marked once the feed has been on screen for a moment
  const marked = useRef(new Set<string>())
  useEffect(() => {
    const unread = items.filter((a) => !a.read && !marked.current.has(a.id))
    if (!unread.length) return
    const t = setTimeout(() => unread.forEach((a) => { marked.current.add(a.id); mark.mutate({ id: a.id }) }), 1200)
    return () => clearTimeout(t)
  }, [items]) // eslint-disable-line react-hooks/exhaustive-deps

  if (isLoading) return <div className="skeleton" style={{ height: 160, borderRadius: 22 }} />
  if (!items.length) return <section data-card className="card" style={{ padding: 28, textAlign: 'center' }}><h2 style={{ fontSize: 22 }}>Nothing new</h2><p className="dim" style={{ marginTop: 6 }}>Company announcements will appear here.</p></section>
  return (
    <div style={{ display: 'grid', gap: 'var(--gap)' }}>
      {items.map((a) => (
        <article key={a.id} data-card className="card" style={{ padding: 20, borderLeft: a.pinned ? '4px solid var(--honey)' : undefined }}>
          <header style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <Avatar name={a.author} src={a.authorAvatar} size={34} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 500 }}>{a.author}</div>
              <div className="dim" style={{ fontSize: 12 }}>{when(a.publishAt)}{a.expiresAt ? ` · until ${when(a.expiresAt)}` : ''}</div>
            </div>
            {a.pinned && <span className="pill honey">Pinned</span>}
            {!a.read && <span className="pill info">New</span>}
          </header>
          <h2 style={{ fontSize: 22, marginBottom: 8 }}>{a.title}</h2>
          <div style={{ fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{a.body}</div>
          {a.requiresAck && (
            <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 10 }}>
              {a.acknowledged
                ? <span className="pill ok">You acknowledged this</span>
                : <button className="btn btn-primary btn-sm" disabled={mark.isPending} onClick={() => mark.mutate({ id: a.id, acknowledge: true })}><Icon name="check" size={14} /> I have read and understood</button>}
            </div>
          )}
        </article>
      ))}
    </div>
  )
}

function Manage({ onEdit, onReaders }: { onEdit: (m: Managed) => void; onReaders: (m: Managed) => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const { data: rows = [], isLoading } = useQuery({ queryKey: ['announcements-manage'], queryFn: async () => (await api.get('/announcements/manage')).data.data as Managed[] })
  const archive = useMutation({
    mutationFn: (id: string) => api.post(`/announcements/${id}/archive`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['announcements'] }); qc.invalidateQueries({ queryKey: ['announcements-manage'] }); toast('Archived') },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  if (isLoading) return <div className="skeleton" style={{ height: 160, borderRadius: 22 }} />
  if (!rows.length) return <section data-card className="card" style={{ padding: 28, textAlign: 'center' }}><p className="dim">No announcements yet. Use “New announcement”.</p></section>
  return (
    <section data-card className="card" style={{ padding: 8, overflowX: 'auto' }}>
      <table className="tbl" style={{ width: '100%', minWidth: 640 }}>
        <thead><tr><th>Announcement</th><th>Status</th><th>Reach</th><th>Read</th><th /></tr></thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.id}>
              <td style={{ maxWidth: 320 }}><div style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.pinned && <span className="pill honey" style={{ marginRight: 6 }}>Pinned</span>}{m.title}</div><div className="dim" style={{ fontSize: 12 }}>{when(m.publishAt)}{m.expiresAt ? ` → ${when(m.expiresAt)}` : ''}</div></td>
              <td><span className={`pill ${m.status === 'live' ? 'ok' : m.status === 'scheduled' ? 'info' : 'mute'}`}>{m.status}</span></td>
              <td className="num">{m.audience} {m.departmentIds.length || m.workLocationIds.length ? <span className="dim" style={{ fontSize: 11 }}>(targeted)</span> : <span className="dim" style={{ fontSize: 11 }}>(everyone)</span>}</td>
              <td className="num">{pct(m.read, m.audience)}%{m.requiresAck && <div className="dim" style={{ fontSize: 11 }}>{pct(m.acknowledged, m.audience)}% acknowledged</div>}</td>
              <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                <button className="btn btn-ghost btn-sm" onClick={() => onReaders(m)}>Who read it</button>
                <button className="btn btn-ghost btn-sm" onClick={() => onEdit(m)}>Edit</button>
                <button className="btn btn-ghost btn-sm" disabled={archive.isPending} onClick={() => { if (confirm(`Archive “${m.title}”? It disappears for everyone.`)) archive.mutate(m.id) }}>Archive</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

const toLocalInput = (iso: string | null) => { if (!iso) return ''; const d = new Date(iso); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16) }

function Editor({ item, onClose }: { item: Managed | null; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const { data: tree } = useOrgTree()
  const { data: locations = [] } = useWorkLocations()
  const units = useMemo(() => flattenUnits(tree), [tree])
  const [f, setF] = useState({
    title: item?.title ?? '', body: item?.body ?? '', pinned: item?.pinned ?? false, requiresAck: item?.requiresAck ?? false,
    departmentIds: item?.departmentIds ?? [], workLocationIds: item?.workLocationIds ?? [],
    schedule: !!item && item.status === 'scheduled', publishAt: item && item.status === 'scheduled' ? toLocalInput(item.publishAt) : '', expiresAt: toLocalInput(item?.expiresAt ?? null),
  })
  const [busy, setBusy] = useState(false)
  const toggle = (k: 'departmentIds' | 'workLocationIds', id: string) => setF({ ...f, [k]: f[k].includes(id) ? f[k].filter((x) => x !== id) : [...f[k], id] })
  const save = async () => {
    setBusy(true)
    try {
      const body: Record<string, unknown> = {
        title: f.title.trim(), body: f.body.trim(), pinned: f.pinned, requiresAck: f.requiresAck, departmentIds: f.departmentIds, workLocationIds: f.workLocationIds,
        expiresAt: f.expiresAt ? new Date(f.expiresAt).toISOString() : null,
      }
      if (f.schedule && f.publishAt && (!item || item.status === 'scheduled')) body.publishAt = new Date(f.publishAt).toISOString()
      if (item) await api.patch(`/announcements/${item.id}`, body)
      else await api.post('/announcements', body)
      qc.invalidateQueries({ queryKey: ['announcements'] }); qc.invalidateQueries({ queryKey: ['announcements-manage'] })
      toast(item ? 'Saved' : f.schedule && f.publishAt ? 'Scheduled' : 'Published. Everyone in the audience gets a notification.')
      onClose()
    } catch (e) { toast(errMsg(e), 'error') } finally { setBusy(false) }
  }
  const everyone = !f.departmentIds.length && !f.workLocationIds.length
  return (
    <Modal open onClose={onClose} title={item ? 'Edit announcement' : 'New announcement'} width={640}>
      <div style={{ display: 'grid', gap: 12 }}>
        <label className="field"><span>Title</span><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={140} /></label>
        <label className="field"><span>Message</span><textarea className="input" rows={6} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} style={{ height: 'auto', padding: 12 }} maxLength={10000} /></label>
        <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 8 }}>
          <legend className="dim" style={{ fontSize: 12, fontWeight: 500, marginBottom: 6 }}>Who sees it: {everyone ? 'everyone' : 'only the selected departments and/or offices'}</legend>
          {units.length > 0 && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{units.map((u) => <button type="button" key={u.id} className={`chip${f.departmentIds.includes(u.id) ? ' on' : ''}`} aria-pressed={f.departmentIds.includes(u.id)} onClick={() => toggle('departmentIds', u.id)} style={f.departmentIds.includes(u.id) ? { background: 'var(--night)', color: 'var(--night-ink)' } : undefined}>{u.name}</button>)}</div>}
          {(locations as any[]).length > 0 && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{(locations as any[]).map((l) => <button type="button" key={l.id} className="chip" aria-pressed={f.workLocationIds.includes(l.id)} onClick={() => toggle('workLocationIds', l.id)} style={f.workLocationIds.includes(l.id) ? { background: 'var(--night)', color: 'var(--night-ink)' } : undefined}><Icon name="pin" size={12} /> {l.name}</button>)}</div>}
        </fieldset>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 13 }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={f.pinned} onChange={(e) => setF({ ...f, pinned: e.target.checked })} /> Pin to the top</label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={f.requiresAck} onChange={(e) => setF({ ...f, requiresAck: e.target.checked })} /> Ask people to acknowledge</label>
          {(!item || item.status === 'scheduled') && <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={f.schedule} onChange={(e) => setF({ ...f, schedule: e.target.checked })} /> Schedule for later</label>}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          {f.schedule && (!item || item.status === 'scheduled') && <label className="field"><span>Publish at</span><input className="input" type="datetime-local" value={f.publishAt} onChange={(e) => setF({ ...f, publishAt: e.target.value })} /></label>}
          <label className="field"><span>Hide after (optional)</span><input className="input" type="datetime-local" value={f.expiresAt} onChange={(e) => setF({ ...f, expiresAt: e.target.value })} /></label>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || f.title.trim().length < 2 || !f.body.trim() || (f.schedule && !f.publishAt && (!item || item.status === 'scheduled'))} onClick={save}>{item ? 'Save' : f.schedule ? 'Schedule' : 'Publish'}</button>
        </div>
      </div>
    </Modal>
  )
}

function Readers({ item, onClose }: { item: Managed; onClose: () => void }) {
  const { data = [], isLoading } = useQuery({ queryKey: ['announcement-readers', item.id], queryFn: async () => (await api.get(`/announcements/${item.id}/readers`)).data.data as { userId: string; name: string; readAt: string | null; acknowledgedAt: string | null }[] })
  const pending = data.filter((r) => (item.requiresAck ? !r.acknowledgedAt : !r.readAt)).length
  return (
    <Modal open onClose={onClose} title={`Who read “${item.title}”`}>
      {isLoading ? <div className="skeleton" style={{ height: 120, borderRadius: 14 }} /> : (
        <>
          <p className="dim" style={{ fontSize: 13, marginBottom: 10 }}>{data.length - pending} of {data.length} {item.requiresAck ? 'acknowledged' : 'read'}{pending ? ` · ${pending} still to go` : ''}</p>
          <ul style={{ listStyle: 'none', display: 'grid', gap: 6, maxHeight: 360, overflowY: 'auto' }}>
            {data.map((r) => (
              <li key={r.userId} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Avatar name={r.name} size={26} />
                <span style={{ flex: 1 }}>{r.name}</span>
                {item.requiresAck && r.acknowledgedAt ? <span className="pill ok">acknowledged</span> : r.readAt ? <span className="pill info">read</span> : <span className="pill mute">not yet</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </Modal>
  )
}
