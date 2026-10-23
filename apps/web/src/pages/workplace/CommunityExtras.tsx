import { Fragment, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import { useAuth } from '../../contexts/AuthContext'
import Modal from '../../components/ui/Modal'
import Icon from '../../components/ui/Icon'
import { useToast } from '../../components/ui/Toast'
import { useOrgTree } from '../../lib/hooks/useEmployees'
import { flattenUnits } from './AnnouncementsPage'

const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'

// ─── Markdown (a safe subset, built as React elements: no HTML is ever injected) ─────────────────────────
// **bold**, _italic_, `code`, [text](https://… or /path), "- " lists, blank lines between paragraphs
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(\*\*[^*]+\*\*|_[^_\s][^_]*_|`[^`]+`|\[[^\]]+\]\((?:https?:\/\/|\/)[^)\s]+\))/g
  let last = 0, m: RegExpExecArray | null, k = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const t = m[0]
    if (t.startsWith('**')) out.push(<strong key={k++}>{t.slice(2, -2)}</strong>)
    else if (t.startsWith('_')) out.push(<em key={k++}>{t.slice(1, -1)}</em>)
    else if (t.startsWith('`')) out.push(<code key={k++} style={{ background: 'var(--well)', padding: '1px 5px', borderRadius: 6, fontSize: '0.92em' }}>{t.slice(1, -1)}</code>)
    else {
      const [, label, href] = t.match(/^\[([^\]]+)\]\(([^)]+)\)$/)!
      out.push(href.startsWith('/') ? <Link key={k++} className="link" to={href}>{label}</Link> : <a key={k++} className="link" href={href} target="_blank" rel="noopener noreferrer">{label}</a>)
    }
    last = m.index + t.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}
export function Md({ text, size = 15 }: { text: string; size?: number }) {
  const blocks = text.replace(/\r/g, '').split(/\n{2,}/)
  return (
    <div style={{ display: 'grid', gap: 10, fontSize: size, lineHeight: 1.55, overflowWrap: 'anywhere' }}>
      {blocks.map((b, i) => {
        const lines = b.split('\n')
        if (lines.every((l) => /^\s*[-*] /.test(l))) return <ul key={i} style={{ paddingLeft: 20, margin: 0 }}>{lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*[-*] /, ''))}</li>)}</ul>
        return <p key={i} style={{ margin: 0 }}>{lines.map((l, j) => <Fragment key={j}>{j > 0 && <br />}{inline(l)}</Fragment>)}</p>
      })}
    </div>
  )
}
export const MD_HINT = '**bold**, _italic_, - lists, [link](https://…)'

// ─── Attachments ──────────────────────────────────────────────────────────────────────────────────────
export type Att = { id: string; fileName: string; mimeType: string; size: number }
export function AttachButton({ files, onChange }: { files: Att[]; onChange: (f: Att[]) => void }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const pick = async (f?: File) => {
    if (!f) return
    if (f.size > 5 * 1024 * 1024) { toast('Attachments can be up to 5 MB', 'error'); return }
    setBusy(true)
    try { const fd = new FormData(); fd.append('file', f); const r = await api.post('/forums/attachments', fd); onChange([...files, r.data.data]) } catch (e) { toast(errMsg(e), 'error') } finally { setBusy(false) }
  }
  return (
    <>
      {files.length < 5 && <label className="btn btn-ghost btn-sm" style={{ cursor: busy ? 'wait' : 'pointer' }}><Icon name="paperclip" size={14} /> {busy ? 'Uploading…' : 'Attach'}<input type="file" hidden accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx" disabled={busy} onChange={(e) => { pick(e.target.files?.[0]); e.target.value = '' }} /></label>}
      {files.map((f) => <span key={f.id} className="chip">{f.fileName} <button className="btn btn-ghost btn-icon" style={{ width: 18, height: 18 }} aria-label={`Remove ${f.fileName}`} onClick={() => onChange(files.filter((x) => x.id !== f.id))}>×</button></span>)}
    </>
  )
}
export function AttachList({ files }: { files?: Att[] }) {
  const toast = useToast()
  if (!files?.length) return null
  const open = async (id: string) => { try { window.open((await api.get(`/forums/attachments/${id}`)).data.data.url, '_blank', 'noopener') } catch (e) { toast(errMsg(e), 'error') } }
  return <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{files.map((f) => <button key={f.id} className="chip" onClick={() => open(f.id)}><Icon name="paperclip" size={12} /> {f.fileName} <span className="dim">{Math.ceil(f.size / 1024)} KB</span></button>)}</div>
}

// ─── Follows ──────────────────────────────────────────────────────────────────────────────────────────
export function useFollows() {
  const qc = useQueryClient()
  const toast = useToast()
  const { data = [] } = useQuery({ queryKey: ['forum-follows'], queryFn: async () => (await api.get('/forums/follows')).data.data as { kind: string; key: string }[] })
  const set = useMutation({
    mutationFn: (b: { kind: 'tag' | 'user' | 'space'; key: string; on: boolean }) => api.post('/forums/follows', b),
    onSuccess: (_d, v) => { toast(v.on ? 'Following: new posts reach you' : 'Unfollowed'); qc.invalidateQueries({ queryKey: ['forum-follows'] }); qc.invalidateQueries({ queryKey: ['forum-spaces'] }) },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  const is = (kind: string, key: string) => data.some((f) => f.kind === kind && f.key === key)
  return { is, toggle: (kind: 'tag' | 'user' | 'space', key: string) => set.mutate({ kind, key, on: !is(kind, key) }) }
}

// ─── Spaces ───────────────────────────────────────────────────────────────────────────────────────────
export function NewSpace({ onClose }: { onClose: () => void }) {
  const { hasRole } = useAuth()
  const hr = hasRole('hr_admin') || hasRole('system_admin')
  const toast = useToast()
  const qc = useQueryClient()
  const [f, setF] = useState({ name: '', description: '', kind: hr ? 'company' : 'team', orgUnitId: '', ownerEmployeeId: '' })
  const { data: tree } = useOrgTree()
  const units = flattenUnits(tree)
  const { data: people = [] } = useQuery({ queryKey: ['space-managers'], enabled: hr, queryFn: async () => (await api.get('/employees', { params: { limit: 500 } })).data.data as any[] })
  const save = useMutation({
    mutationFn: () => api.post('/forums/spaces', { name: f.name.trim(), ...(f.description.trim() && { description: f.description.trim() }), kind: f.kind, ...(f.kind === 'department' && { orgUnitId: f.orgUnitId }), ...(f.kind === 'team' && hr && { ownerEmployeeId: f.ownerEmployeeId }) }),
    onSuccess: () => { toast('Space created'); qc.invalidateQueries({ queryKey: ['forum-spaces'] }); onClose() },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  return (
    <Modal open onClose={onClose} title={hr ? 'New space' : 'A space for your team'} width={520}>
      <div style={{ display: 'grid', gap: 12 }}>
        {hr && <label className="field"><span>Who can see it</span><select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="company">Everyone</option><option value="department">A department (and the units below it)</option><option value="team">A manager’s team (everyone reporting to them)</option></select></label>}
        {!hr && <p className="dim" style={{ fontSize: 13 }}>Only you and the people reporting to you (at any level) see it. You moderate it.</p>}
        {f.kind === 'department' && <label className="field"><span>Department</span><select className="input" value={f.orgUnitId} onChange={(e) => setF({ ...f, orgUnitId: e.target.value })}><option value="">Choose…</option>{units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>}
        {f.kind === 'team' && hr && <label className="field"><span>Manager</span><select className="input" value={f.ownerEmployeeId} onChange={(e) => setF({ ...f, ownerEmployeeId: e.target.value })}><option value="">Choose…</option>{people.map((p) => <option key={p.id} value={p.id}>{p.firstName} {p.lastName}</option>)}</select></label>}
        <label className="field"><span>Name</span><input className="input" value={f.name} maxLength={60} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={f.kind === 'team' ? 'e.g. Sales team' : 'e.g. Ideas'} /></label>
        <label className="field"><span>What it is for (optional)</span><input className="input" value={f.description} maxLength={300} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={save.isPending || f.name.trim().length < 2 || (f.kind === 'department' && !f.orgUnitId) || (f.kind === 'team' && hr && !f.ownerEmployeeId)} onClick={() => save.mutate()}>Create</button></div>
      </div>
    </Modal>
  )
}

// ─── Events ───────────────────────────────────────────────────────────────────────────────────────────
const KIND: Record<string, string> = { townhall: 'Townhall', celebration: 'Celebration', training: 'Training', other: 'Event' }
export function Events() {
  const { hasRole } = useAuth()
  const hr = hasRole('hr_admin') || hasRole('system_admin')
  const toast = useToast()
  const qc = useQueryClient()
  const from = new Date().toISOString().slice(0, 10)
  const to = new Date(Date.now() + 120 * 86_400_000).toISOString().slice(0, 10)
  const { data = [], isLoading } = useQuery({ queryKey: ['forum-events', from], queryFn: async () => (await api.get('/forums/events', { params: { from, to } })).data.data as any[] })
  const { data: spaces = [] } = useQuery({ queryKey: ['forum-spaces'], queryFn: async () => (await api.get('/forums/spaces')).data.data as any[] })
  const mine = spaces.filter((s) => s.canModerate && s.kind !== 'company' && s.kind !== 'news')
  const [adding, setAdding] = useState(false)
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: object }) => api.post(path, body ?? {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['forum-events'] }),
    onError: (e) => toast(errMsg(e), 'error'),
  })
  return (
    <div style={{ display: 'grid', gap: 'var(--gap)' }}>
      {(hr || mine.length > 0) && <div><button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}><Icon name="plus" size={14} /> New event</button></div>}
      {isLoading ? <div className="skeleton" style={{ height: 120, borderRadius: 22 }} /> : !data.length ? <section className="card" style={{ padding: 24 }}><p className="dim">No events in the next four months.</p></section> : data.map((e) => {
        const d = new Date(e.startsAt)
        return (
          <section key={e.id} data-card className="card" style={{ padding: 16, display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', opacity: e.cancelled ? 0.55 : 1 }}>
            <div style={{ width: 58, textAlign: 'center', borderRadius: 14, background: 'var(--well)', padding: '6px 0' }}><div className="dim" style={{ fontSize: 11, textTransform: 'uppercase' }}>{d.toLocaleString(undefined, { month: 'short' })}</div><div style={{ fontFamily: 'var(--font-display)', fontSize: 24 }}>{d.getDate()}</div></div>
            <div style={{ flex: '1 1 240px', minWidth: 0 }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}><span className="pill honey">{KIND[e.kind] ?? e.kind}</span>{e.space && <span className="pill mute">{e.space}</span>}{e.cancelled && <span className="pill danger">Cancelled</span>}<strong>{e.title}</strong></div>
              <div className="dim" style={{ fontSize: 13 }}>{d.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}{e.location ? ` · ${e.location}` : ''} · {e.going} going{e.maybe ? `, ${e.maybe} maybe` : ''}</div>
              {e.description && <div style={{ fontSize: 13, marginTop: 4 }}><Md text={e.description} size={13} /></div>}
            </div>
            {!e.cancelled && <div style={{ display: 'flex', gap: 6 }}>
              {(['going', 'maybe', 'no'] as const).map((s) => <button key={s} className={`btn btn-sm ${e.myRsvp === s ? 'btn-primary' : 'btn-ghost'}`} disabled={act.isPending} onClick={() => act.mutate({ path: `/forums/events/${e.id}/rsvp`, body: { status: s } })}>{s === 'going' ? 'Going' : s === 'maybe' ? 'Maybe' : 'Can’t go'}</button>)}
              {(e.mine || hr) && <button className="btn btn-ghost btn-sm" onClick={() => { if (confirm('Cancel this event? People who answered are told.')) act.mutate({ path: `/forums/events/${e.id}/cancel` }) }}>Cancel event</button>}
            </div>}
          </section>
        )
      })}
      {adding && <NewEvent spaces={mine} hr={hr} onClose={() => setAdding(false)} />}
    </div>
  )
}
function NewEvent({ spaces, hr, onClose }: { spaces: any[]; hr: boolean; onClose: () => void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const [f, setF] = useState({ title: '', kind: 'townhall', date: '', time: '10:00', hours: '1', location: '', description: '', spaceId: hr ? '' : spaces[0]?.id ?? '' })
  const save = useMutation({
    mutationFn: () => {
      const start = new Date(`${f.date}T${f.time}`)
      return api.post('/forums/events', { title: f.title.trim(), kind: f.kind, startsAt: start.toISOString(), ...(Number(f.hours) > 0 && { endsAt: new Date(start.getTime() + Number(f.hours) * 3_600_000).toISOString() }), ...(f.location.trim() && { location: f.location.trim() }), ...(f.description.trim() && { description: f.description.trim() }), ...(f.spaceId && { spaceId: f.spaceId }) })
    },
    onSuccess: () => { toast('Event added; people are told'); qc.invalidateQueries({ queryKey: ['forum-events'] }); onClose() },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  return (
    <Modal open onClose={onClose} title="New event" width={560}>
      <div style={{ display: 'grid', gap: 12 }}>
        <label className="field"><span>Title</span><input className="input" value={f.title} maxLength={140} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Q4 townhall" /></label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8 }}>
          <label className="field"><span>Type</span><select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label className="field"><span>Date</span><input className="input" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></label>
          <label className="field"><span>Time</span><input className="input" type="time" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} /></label>
          <label className="field"><span>Hours</span><input className="input" type="number" min={0} step={0.5} value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })} /></label>
        </div>
        <label className="field"><span>Where</span><input className="input" value={f.location} maxLength={200} onChange={(e) => setF({ ...f, location: e.target.value })} placeholder="Main hall, or a video link" /></label>
        <label className="field"><span>For</span><select className="input" value={f.spaceId} onChange={(e) => setF({ ...f, spaceId: e.target.value })}>{hr && <option value="">Everyone</option>}{spaces.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label className="field"><span>Details (optional)</span><textarea className="input" rows={3} value={f.description} maxLength={2000} onChange={(e) => setF({ ...f, description: e.target.value })} style={{ height: 'auto', padding: 12 }} /></label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={save.isPending || f.title.trim().length < 3 || !f.date} onClick={() => save.mutate()}>Add event</button></div>
      </div>
    </Modal>
  )
}

// ─── HR: settings and engagement ──────────────────────────────────────────────────────────────────────
export function CommunitySettings() {
  const toast = useToast()
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['forum-settings'], queryFn: async () => (await api.get('/forums/settings')).data.data as { blockedWords: string[]; autoNews: boolean } })
  const [words, setWords] = useState<string | null>(null)
  const save = useMutation({
    mutationFn: (b: object) => api.put('/forums/settings', b),
    onSuccess: () => { toast('Saved'); setWords(null); qc.invalidateQueries({ queryKey: ['forum-settings'] }) },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  if (!data) return null
  return (
    <section data-card className="card" style={{ padding: 18, display: 'grid', gap: 10 }}>
      <h3 style={{ fontSize: 16 }}>Settings</h3>
      <label className="field"><span>Words that may not be posted (one per line). Posts containing them are refused, naming the word.</span>
        <textarea className="input" rows={4} value={words ?? data.blockedWords.join('\n')} onChange={(e) => setWords(e.target.value)} style={{ height: 'auto', padding: 12 }} /></label>
      <div><button className="btn btn-primary btn-sm" disabled={words == null || save.isPending} onClick={() => save.mutate({ blockedWords: (words ?? '').split('\n').map((w) => w.trim()).filter((w) => w.length >= 2) })}>Save words</button></div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}><input type="checkbox" checked={data.autoNews} onChange={(e) => save.mutate({ autoNews: e.target.checked })} /> Post company-wide policies and paid payrolls in the News space</label>
    </section>
  )
}
export function Engagement() {
  const [days, setDays] = useState(30)
  const { data } = useQuery({ queryKey: ['forum-analytics', days], queryFn: async () => (await api.get('/forums/analytics', { params: { days } })).data.data })
  if (!data) return <div className="skeleton" style={{ height: 120, borderRadius: 22 }} />
  const max = Math.max(1, ...data.weekly.map((w: any) => w.posts))
  return (
    <section data-card className="card" style={{ padding: 18, display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><h3 style={{ fontSize: 16, flex: 1 }}>Engagement</h3>{[30, 90, 365].map((d) => <button key={d} className={`btn btn-sm ${days === d ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setDays(d)}>{d === 365 ? 'Year' : `${d} days`}</button>)}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10 }}>
        {[['Threads', data.threads], ['Replies', data.comments], ['Kudos', data.kudos], ['Poll votes', data.votes], ['People taking part', `${data.activePeople} of ${data.people} (${data.participation}%)`]].map(([l, v]) => <div key={l as string} className="well" style={{ padding: 12, borderRadius: 14 }}><div className="dim" style={{ fontSize: 12 }}>{l}</div><div style={{ fontFamily: 'var(--font-display)', fontSize: 22 }}>{v}</div></div>)}
      </div>
      {data.weekly.length > 0 && <div><div className="dim" style={{ fontSize: 12, marginBottom: 6 }}>Posts per week</div><div style={{ display: 'flex', gap: 4, alignItems: 'flex-end', height: 80 }}>{data.weekly.map((w: any) => <div key={w.week} title={`Week of ${w.week}: ${w.posts}`} style={{ flex: 1, height: `${(w.posts / max) * 100}%`, minHeight: 2, background: 'var(--honey)', borderRadius: 4 }} />)}</div></div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, fontSize: 13 }}>
        <div><div className="dim" style={{ fontSize: 12, marginBottom: 4 }}>Busiest spaces</div>{data.topSpaces.length ? data.topSpaces.map((s: any) => <div key={s.name}>{s.name} · {s.threads}</div>) : <span className="dim">None yet</span>}</div>
        <div><div className="dim" style={{ fontSize: 12, marginBottom: 4 }}>Top tags</div>{data.topTags.length ? data.topTags.map((t: any) => <div key={t.tag}>#{t.tag} · {t.threads}</div>) : <span className="dim">None yet</span>}</div>
      </div>
    </section>
  )
}
