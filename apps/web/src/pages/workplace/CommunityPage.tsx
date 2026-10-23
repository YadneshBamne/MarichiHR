import { useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import { useAuth } from '../../contexts/AuthContext'
import PageHeader from '../../components/ui/PageHeader'
import Modal from '../../components/ui/Modal'
import Icon from '../../components/ui/Icon'
import { useToast } from '../../components/ui/Toast'
import { useReveal } from '../../lib/motion'
import { Md, MD_HINT, AttachButton, AttachList, useFollows, NewSpace, Events, CommunitySettings, Engagement, type Att } from './CommunityExtras'

// Community: discussions in spaces (with polls and @mentions), a recognition wall of kudos, and HR moderation.
const BADGES: Record<string, string> = { teamwork: 'Teamwork', customer: 'Customer hero', innovation: 'Bright idea', leadership: 'Leadership', above_and_beyond: 'Above and beyond' }
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
type Tab = 'discussions' | 'events' | 'wall' | 'moderation'

const usePeople = () => useQuery({ queryKey: ['community-people'], queryFn: async () => ((await api.get('/employees/org-chart')).data.data.people as { id: string; name: string; isMe: boolean }[]).filter((p) => !p.isMe) })

export default function CommunityPage() {
  const { hasRole } = useAuth()
  const mod = hasRole('hr_admin') || hasRole('system_admin')
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as Tab) || 'discussions'
  const root = useReveal<HTMLDivElement>(tab)
  const tabs: [Tab, string][] = [['discussions', 'Discussions'], ['events', 'Events'], ['wall', 'Recognition wall'], ...(mod ? [['moderation', 'Moderation'] as [Tab, string]] : [])]
  return (
    <div ref={root}>
      <PageHeader title="Community" sub="Talk, ask, vote and thank each other.">
        <div role="tablist" style={{ display: 'flex', gap: 6, marginTop: 14, flexWrap: 'wrap' }}>
          {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`btn btn-sm ${tab === k ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setParams({ tab: k })}>{l}</button>)}
        </div>
      </PageHeader>
      {tab === 'discussions' && <Discussions mod={mod} />}
      {tab === 'events' && <Events />}
      {tab === 'wall' && <Wall mod={mod} />}
      {tab === 'moderation' && mod && <div style={{ display: 'grid', gap: 'var(--gap)' }}><Moderation /><CommunitySettings /><Engagement /></div>}
    </div>
  )
}

function Discussions({ mod }: { mod: boolean }) {
  const toast = useToast()
  const qc = useQueryClient()
  const { hasRole } = useAuth()
  const [spaceId, setSpaceId] = useState('')
  const [q, setQ] = useState('')
  const [tag, setTag] = useState('')
  const [following, setFollowing] = useState(false)
  const [writing, setWriting] = useState(false)
  const [newSpace, setNewSpace] = useState(false)
  const follows = useFollows()
  const { data: spaces = [] } = useQuery({ queryKey: ['forum-spaces'], queryFn: async () => (await api.get('/forums/spaces')).data.data as { id: string; name: string; description: string; threads: number; kind: string; canModerate: boolean; following: boolean }[] })
  const { data: threads = [], isLoading } = useQuery({ queryKey: ['forum-threads', spaceId, q, tag, following], queryFn: async () => (await api.get('/forums/threads', { params: { ...(spaceId && { spaceId }), ...(q.trim() && { q: q.trim() }), ...(tag && { tag }), ...(following && { feed: 'following' }) } })).data.data as any[] })
  const canAddSpace = mod || (hasRole('manager') && !spaces.some((s) => s.kind === 'team' && s.canModerate))
  const writable = spaces.filter((s) => s.kind !== 'news' || s.canModerate)
  void toast; void qc
  return (
    <div style={{ display: 'grid', gap: 'var(--gap)' }}>
      <section data-card className="card" style={{ padding: 14, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <div className="chips" style={{ flex: '1 1 300px' }}>
          <button className={`chip${!spaceId && !following ? ' is-on' : ''}`} onClick={() => { setSpaceId(''); setFollowing(false) }}>All</button>
          <button className={`chip${following ? ' is-on' : ''}`} onClick={() => { setFollowing(true); setSpaceId('') }} title="Threads from the tags, people and spaces you follow">Following</button>
          {spaces.map((s) => <button key={s.id} className={`chip${spaceId === s.id ? ' is-on' : ''}`} onClick={() => { setSpaceId(s.id); setFollowing(false) }} title={s.description}>{s.kind === 'team' ? <Icon name="users" size={12} /> : s.kind === 'department' ? <Icon name="layers" size={12} /> : s.kind === 'news' ? <Icon name="bell" size={12} /> : null} {s.name} <span className="dim">{s.threads}</span></button>)}
          {canAddSpace && <button className="chip" onClick={() => setNewSpace(true)}><Icon name="plus" size={12} /> {mod ? 'Space' : 'Team space'}</button>}
          {tag && <button className="chip is-on" onClick={() => setTag('')}>#{tag} ×</button>}
          {spaceId && <button className="chip" onClick={() => follows.toggle('space', spaceId)}>{follows.is('space', spaceId) ? 'Following this space ✓' : 'Follow this space'}</button>}
        </div>
        <input className="input" style={{ width: 200 }} placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search discussions" />
        <button className="btn btn-primary btn-sm" disabled={!writable.length} onClick={() => setWriting(true)}>New thread</button>
      </section>
      <section data-card className="card" style={{ padding: 8 }}>
        {isLoading ? <div className="skeleton" style={{ height: 120, borderRadius: 14 }} /> : !threads.length ? <p className="dim" style={{ padding: 16 }}>{following ? 'Nothing yet from what you follow. Open a thread and follow its tags, author or space.' : 'Nothing here yet. Start the first thread.'}</p> : threads.map((t) => (
          <Link key={t.id} to={`/community/${t.id}`} className="row-link" style={{ display: 'flex', gap: 12, alignItems: 'center', padding: 12, borderRadius: 14 }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                {t.pinned && <span className="pill honey">Pinned</span>}{t.locked && <span className="pill mute">Locked</span>}{t.hidden && <span className="pill danger">Hidden</span>}{t.hasPoll && <span className="pill info">Poll</span>}
                <strong style={{ fontWeight: 600 }}>{t.title}</strong>
                {t.tags?.map((g: string) => <span key={g} className="pill mute" role="button" onClick={(e) => { e.preventDefault(); setTag(g) }} style={{ cursor: 'pointer', textTransform: 'none' }}>#{g}</span>)}
                {t.attachments > 0 && <Icon name="paperclip" size={12} />}
              </span>
              <span className="dim" style={{ display: 'block', fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.space} · {t.author} · {when(t.lastActivityAt)} · {t.excerpt}</span>
            </span>
            <span className="dim num" style={{ fontSize: 12 }}><Icon name="message" size={13} /> {t.comments}</span>
          </Link>
        ))}
      </section>
      {writing && <NewThread spaces={writable} defaultSpace={writable.some((s) => s.id === spaceId) ? spaceId : writable[0]?.id} onClose={() => setWriting(false)} />}
      {newSpace && <NewSpace onClose={() => setNewSpace(false)} />}
    </div>
  )
}

// A simple @mention picker: pick people, their names go into the text and they are notified
function MentionPicker({ value, onPick }: { value: string[]; onPick: (id: string, name: string) => void }) {
  const { data: people = [] } = usePeople()
  return (
    <select className="input" value="" onChange={(e) => { const p = people.find((x) => x.id === e.target.value); if (p) onPick(p.id, p.name) }} aria-label="Mention someone" style={{ width: 200 }}>
      <option value="">@ Mention someone…</option>
      {people.filter((p) => !value.includes(p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
    </select>
  )
}

function NewThread({ spaces, defaultSpace, onClose }: { spaces: { id: string; name: string }[]; defaultSpace?: string; onClose: () => void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const [f, setF] = useState({ spaceId: defaultSpace ?? '', title: '', body: '', tags: '' })
  const [files, setFiles] = useState<Att[]>([])
  const [mentions, setMentions] = useState<string[]>([])
  const [poll, setPoll] = useState<{ question: string; options: string[]; multi: boolean } | null>(null)
  const pollOk = !poll || (poll.question.trim().length >= 3 && poll.options.filter((o) => o.trim()).length >= 2)
  const save = useMutation({
    mutationFn: () => api.post('/forums/threads', { spaceId: f.spaceId, title: f.title.trim(), body: f.body.trim(), ...(mentions.length && { mentions }), ...(f.tags.trim() && { tags: f.tags.split(/[,\s]+/).filter(Boolean).slice(0, 5) }), ...(files.length && { attachmentIds: files.map((x) => x.id) }), ...(poll && { poll: { question: poll.question.trim(), options: poll.options.map((o) => o.trim()).filter(Boolean), multi: poll.multi } }) }),
    onSuccess: () => { toast('Posted'); qc.invalidateQueries({ queryKey: ['forum-threads'] }); qc.invalidateQueries({ queryKey: ['forum-spaces'] }); onClose() },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  return (
    <Modal open onClose={onClose} title="New thread" width={640}>
      <div style={{ display: 'grid', gap: 12 }}>
        <label className="field"><span>Space</span><select className="input" value={f.spaceId} onChange={(e) => setF({ ...f, spaceId: e.target.value })}>{spaces.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label className="field"><span>Title</span><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={160} /></label>
        <label className="field"><span>Message <span className="dim" style={{ fontWeight: 400 }}>· {MD_HINT}</span></span><textarea className="input" rows={5} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} style={{ height: 'auto', padding: 12 }} maxLength={10000} /></label>
        <label className="field"><span>Tags (up to 5, e.g. travel, it-help)</span><input className="input" value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} maxLength={150} /></label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <AttachButton files={files} onChange={setFiles} />
          <MentionPicker value={mentions} onPick={(id, name) => { setMentions([...mentions, id]); setF({ ...f, body: `${f.body}${f.body && !f.body.endsWith(' ') ? ' ' : ''}@${name} ` }) }} />
          {!poll && <button className="btn btn-ghost btn-sm" onClick={() => setPoll({ question: '', options: ['', ''], multi: false })}>Add a poll</button>}
        </div>
        {poll && (
          <div className="well" style={{ padding: 12, display: 'grid', gap: 8, borderRadius: 14 }}>
            <input className="input" placeholder="Poll question" value={poll.question} onChange={(e) => setPoll({ ...poll, question: e.target.value })} maxLength={200} />
            {poll.options.map((o, i) => <input key={i} className="input" placeholder={`Option ${i + 1}`} value={o} onChange={(e) => setPoll({ ...poll, options: poll.options.map((x, j) => (j === i ? e.target.value : x)) })} maxLength={120} />)}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {poll.options.length < 10 && <button className="btn btn-ghost btn-sm" onClick={() => setPoll({ ...poll, options: [...poll.options, ''] })}>+ Option</button>}
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}><input type="checkbox" checked={poll.multi} onChange={(e) => setPoll({ ...poll, multi: e.target.checked })} /> People can pick several</label>
              <button className="btn btn-ghost btn-sm" onClick={() => setPoll(null)}>Remove poll</button>
            </div>
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button className="btn btn-primary" disabled={save.isPending || !f.spaceId || f.title.trim().length < 3 || !f.body.trim() || !pollOk} onClick={() => save.mutate()}>Post</button></div>
      </div>
    </Modal>
  )
}

export function ThreadPage() {
  const { id = '' } = useParams()
  const toast = useToast()
  const qc = useQueryClient()
  const [reply, setReply] = useState('')
  const [replyFiles, setReplyFiles] = useState<Att[]>([])
  const [mentions, setMentions] = useState<string[]>([])
  const follows = useFollows()
  const { data: t, isLoading } = useQuery({ queryKey: ['forum-thread', id], queryFn: async () => (await api.get(`/forums/threads/${id}`)).data.data })
  const root = useReveal<HTMLDivElement>(isLoading)
  const refresh = () => { qc.invalidateQueries({ queryKey: ['forum-thread', id] }); qc.invalidateQueries({ queryKey: ['forum-threads'] }) }
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body: object }) => api.post(path, body),
    onSuccess: (_d, v) => { toast(v.path.endsWith('/comments') ? 'Replied' : v.path === '/forums/reports' ? 'Reported to HR' : 'Saved'); if (v.path.endsWith('/comments')) { setReply(''); setMentions([]); setReplyFiles([]) } refresh() },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  const report = (targetType: string, targetId: string) => { const reason = window.prompt('Why are you reporting this?'); if (reason && reason.trim().length >= 3) act.mutate({ path: '/forums/reports', body: { targetType, targetId, reason: reason.trim() } }) }
  if (isLoading) return <div className="skeleton" style={{ height: 240, borderRadius: 22 }} />
  if (!t) return <section className="card" style={{ padding: 24 }}>Thread not found. <Link className="link" to="/community">Back</Link></section>
  const p = t.poll
  const [picked, setPicked] = [p?.mine ?? [], (ids: string[]) => act.mutate({ path: `/forums/threads/${id}/vote`, body: { optionIds: ids } })]
  return (
    <div ref={root}>
      <PageHeader title={t.title} sub={`${t.space} · ${t.author.name} · ${when(t.createdAt)}`} actions={<Link to="/community" className="btn btn-ghost btn-sm"><Icon name="chevronLeft" size={14} /> Community</Link>} />
      <div style={{ display: 'grid', gap: 'var(--gap)' }}>
        <section data-card className="card" style={{ padding: 22, display: 'grid', gap: 14 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{t.pinned && <span className="pill honey">Pinned</span>}{t.locked && <span className="pill mute">Locked</span>}{t.hidden && <span className="pill danger">Hidden</span>}</div>
          <Md text={t.body} />
          <AttachList files={t.attachments} />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {t.tags?.map((g: string) => <button key={g} className="chip" onClick={() => follows.toggle('tag', g)} title={follows.is('tag', g) ? 'Unfollow this tag' : 'Follow this tag'}>#{g} {follows.is('tag', g) ? '✓' : '+'}</button>)}
            {!t.mine && <button className="chip" onClick={() => follows.toggle('user', t.authorUserId)}>{follows.is('user', t.authorUserId) ? `Following ${t.author.name} ✓` : `Follow ${t.author.name}`}</button>}
          </div>
          {p && (
            <div className="well" style={{ padding: 14, borderRadius: 14, display: 'grid', gap: 8 }}>
              <strong>{p.question}</strong>
              {p.options.map((o: any) => {
                const pct = p.voters ? Math.round((o.votes / p.voters) * 100) : 0
                const mine = picked.includes(o.id)
                return (
                  <button key={o.id} disabled={p.closed || act.isPending} onClick={() => setPicked(p.multi ? (mine ? picked.filter((x: string) => x !== o.id) : [...picked, o.id]).filter(Boolean) : [o.id])} style={{ position: 'relative', textAlign: 'left', border: `1px solid ${mine ? 'var(--ink)' : 'var(--line)'}`, background: 'var(--card)', borderRadius: 12, padding: '10px 12px', cursor: p.closed ? 'default' : 'pointer', overflow: 'hidden' }}>
                    <span aria-hidden style={{ position: 'absolute', inset: 0, width: `${pct}%`, background: 'var(--honey-2)' }} />
                    <span style={{ position: 'relative', display: 'flex', justifyContent: 'space-between', gap: 8 }}><span>{mine ? '✓ ' : ''}{o.label}</span><span className="num">{pct}% · {o.votes}</span></span>
                  </button>
                )
              })}
              <span className="dim" style={{ fontSize: 12 }}>{p.voters} vote{p.voters === 1 ? '' : 's'}{p.multi ? ' · pick several' : ''}{p.closed ? ' · closed' : p.closesAt ? ` · closes ${when(p.closesAt)}` : ''}</span>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {t.canModerate ? <>
              <button className="btn btn-ghost btn-sm" onClick={() => act.mutate({ path: `/forums/threads/${id}/moderate`, body: { pinned: !t.pinned } })}>{t.pinned ? 'Unpin' : 'Pin'}</button>
              <button className="btn btn-ghost btn-sm" onClick={() => act.mutate({ path: `/forums/threads/${id}/moderate`, body: { locked: !t.locked } })}>{t.locked ? 'Unlock' : 'Lock'}</button>
              <button className="btn btn-ghost btn-sm" onClick={() => { if (t.hidden) act.mutate({ path: `/forums/threads/${id}/moderate`, body: { hidden: false } }); else { const reason = window.prompt('Why hide it? The author sees this (optional)'); if (reason !== null) act.mutate({ path: `/forums/threads/${id}/moderate`, body: { hidden: true, ...(reason.trim() && { reason: reason.trim() }) } }) } }}>{t.hidden ? 'Show again' : 'Hide'}</button>
            </> : !t.mine && <button className="btn btn-ghost btn-sm" onClick={() => report('thread', t.id)}>Report</button>}
          </div>
        </section>
        <section data-card className="card" style={{ padding: 18, display: 'grid', gap: 12 }}>
          <h3 style={{ fontSize: 16 }}>{t.comments.length} repl{t.comments.length === 1 ? 'y' : 'ies'}</h3>
          {t.comments.map((c: any) => (
            <div key={c.id} style={{ borderTop: '1px solid var(--line)', paddingTop: 10, opacity: c.hidden ? 0.55 : 1 }}>
              <div className="dim" style={{ fontSize: 12 }}>{c.author.name} · {when(c.createdAt)}{c.hidden ? ' · hidden' : ''}</div>
              <Md text={c.body} size={14} />
              <AttachList files={c.attachments} />
              {t.canModerate ? <button className="btn btn-ghost btn-sm" onClick={() => { if (c.hidden) act.mutate({ path: `/forums/comments/${c.id}/hide`, body: { hidden: false } }); else { const reason = window.prompt('Why hide it? The author sees this (optional)'); if (reason !== null) act.mutate({ path: `/forums/comments/${c.id}/hide`, body: { hidden: true, ...(reason.trim() && { reason: reason.trim() }) } }) } }}>{c.hidden ? 'Show again' : 'Hide'}</button>
                : !c.mine && <button className="btn btn-ghost btn-sm" onClick={() => report('comment', c.id)}>Report</button>}
            </div>
          ))}
          {t.locked ? <p className="dim" style={{ fontSize: 13 }}>This thread is locked.</p> : (
            <div style={{ display: 'grid', gap: 8 }}>
              <textarea className="input" rows={3} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Write a reply…" style={{ height: 'auto', padding: 12 }} maxLength={5000} />
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <MentionPicker value={mentions} onPick={(pid, name) => { setMentions([...mentions, pid]); setReply(`${reply}${reply && !reply.endsWith(' ') ? ' ' : ''}@${name} `) }} />
                <AttachButton files={replyFiles} onChange={setReplyFiles} />
                <button className="btn btn-primary btn-sm" disabled={act.isPending || !reply.trim()} onClick={() => act.mutate({ path: `/forums/threads/${id}/comments`, body: { body: reply.trim(), ...(mentions.length && { mentions }), ...(replyFiles.length && { attachmentIds: replyFiles.map((x) => x.id) }) } })}>Reply</button>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function Wall({ mod }: { mod: boolean }) {
  const toast = useToast()
  const qc = useQueryClient()
  const { data: people = [] } = usePeople()
  const { data = [], isLoading } = useQuery({ queryKey: ['kudos'], queryFn: async () => (await api.get('/forums/kudos')).data.data as any[] })
  const [f, setF] = useState({ toEmployeeId: '', badge: 'teamwork', message: '' })
  const give = useMutation({
    mutationFn: () => api.post('/forums/kudos', { ...f, message: f.message.trim() }),
    onSuccess: () => { toast('Kudos sent'); setF({ toEmployeeId: '', badge: 'teamwork', message: '' }); qc.invalidateQueries({ queryKey: ['kudos'] }) },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body: object }) => api.post(path, body),
    onSuccess: () => { toast('Done'); qc.invalidateQueries({ queryKey: ['kudos'] }) },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  return (
    <div style={{ display: 'grid', gap: 'var(--gap)' }}>
      <section data-card className="card" style={{ padding: 18, display: 'grid', gap: 10 }}>
        <h3 style={{ fontSize: 16 }}>Thank someone</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          <label className="field"><span>Who</span><select className="input" value={f.toEmployeeId} onChange={(e) => setF({ ...f, toEmployeeId: e.target.value })}><option value="">Choose a person…</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label className="field"><span>For</span><select className="input" value={f.badge} onChange={(e) => setF({ ...f, badge: e.target.value })}>{Object.entries(BADGES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        </div>
        <label className="field"><span>Message</span><input className="input" value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} maxLength={500} placeholder="What did they do?" /></label>
        <div><button className="btn btn-honey btn-sm" disabled={give.isPending || !f.toEmployeeId || f.message.trim().length < 3} onClick={() => give.mutate()}>Send kudos</button></div>
      </section>
      {isLoading ? <div className="skeleton" style={{ height: 140, borderRadius: 22 }} /> : !data.length ? <section className="card" style={{ padding: 24 }}><p className="dim">No kudos yet. Be the first to thank someone.</p></section> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 'var(--gap)' }}>
          {data.map((k) => (
            <article key={k.id} data-card className="card" style={{ padding: 16, display: 'grid', gap: 8, opacity: k.hidden ? 0.55 : 1 }}>
              <span className="pill honey" style={{ justifySelf: 'start' }}>{BADGES[k.badge] ?? k.badge}</span>
              <strong style={{ fontSize: 16 }}>{k.to}</strong>
              <p style={{ fontSize: 14 }}>{k.message}</p>
              <span className="dim" style={{ fontSize: 12 }}>from {k.from} · {when(k.createdAt)}{k.hidden ? ' · hidden' : ''}</span>
              {mod ? <button className="btn btn-ghost btn-sm" style={{ justifySelf: 'start' }} onClick={() => act.mutate({ path: `/forums/kudos/${k.id}/hide`, body: { hidden: !k.hidden } })}>{k.hidden ? 'Show again' : 'Hide'}</button>
                : !k.mine && <button className="btn btn-ghost btn-sm" style={{ justifySelf: 'start' }} onClick={() => { const reason = window.prompt('Why are you reporting this?'); if (reason && reason.trim().length >= 3) act.mutate({ path: '/forums/reports', body: { targetType: 'kudos', targetId: k.id, reason: reason.trim() } }) }}>Report</button>}
            </article>
          ))}
        </div>
      )}
    </div>
  )
}

function Moderation() {
  const toast = useToast()
  const qc = useQueryClient()
  const { data = [], isLoading } = useQuery({ queryKey: ['forum-reports'], queryFn: async () => (await api.get('/forums/reports')).data.data as any[] })
  const resolve = useMutation({
    mutationFn: ({ id, hide }: { id: string; hide: boolean }) => api.post(`/forums/reports/${id}/resolve`, { hide }),
    onSuccess: (_d, v) => { toast(v.hide ? 'Hidden' : 'Kept'); qc.invalidateQueries({ queryKey: ['forum-reports'] }) },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  return (
    <section data-card className="card" style={{ padding: 8 }}>
      {isLoading ? <div className="skeleton" style={{ height: 100, borderRadius: 14 }} /> : !data.length ? <p className="dim" style={{ padding: 16 }}>No open reports.</p> : data.map((r) => (
        <div key={r.id} style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', padding: 12, borderBottom: '1px solid var(--line)' }}>
          <div style={{ flex: '1 1 320px', minWidth: 0 }}>
            <div><span className="pill mute">{r.targetType}</span> <span style={{ fontSize: 14 }}>{r.content ?? <span className="dim">(deleted)</span>}</span></div>
            <div className="dim" style={{ fontSize: 12 }}>Reported by {r.reporter} · “{r.reason}” · {when(r.createdAt)}{r.threadId && <> · <Link className="link" to={`/community/${r.threadId}`}>Open thread</Link></>}</div>
          </div>
          <button className="btn btn-primary btn-sm" disabled={resolve.isPending} onClick={() => resolve.mutate({ id: r.id, hide: true })}>Hide it</button>
          <button className="btn btn-ghost btn-sm" disabled={resolve.isPending} onClick={() => resolve.mutate({ id: r.id, hide: false })}>Keep it</button>
        </div>
      ))}
    </section>
  )
}
