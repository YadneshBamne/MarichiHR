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

// Community: discussions in spaces (with polls and @mentions), a recognition wall of kudos, and HR moderation.
const BADGES: Record<string, string> = { teamwork: 'Teamwork', customer: 'Customer hero', innovation: 'Bright idea', leadership: 'Leadership', above_and_beyond: 'Above and beyond' }
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
type Tab = 'discussions' | 'wall' | 'moderation'

const usePeople = () => useQuery({ queryKey: ['community-people'], queryFn: async () => ((await api.get('/employees/org-chart')).data.data.people as { id: string; name: string; isMe: boolean }[]).filter((p) => !p.isMe) })

export default function CommunityPage() {
  const { hasRole } = useAuth()
  const mod = hasRole('hr_admin') || hasRole('system_admin')
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as Tab) || 'discussions'
  const root = useReveal<HTMLDivElement>(tab)
  const tabs: [Tab, string][] = [['discussions', 'Discussions'], ['wall', 'Recognition wall'], ...(mod ? [['moderation', 'Moderation'] as [Tab, string]] : [])]
  return (
    <div ref={root}>
      <PageHeader title="Community" sub="Talk, ask, vote and thank each other.">
        <div role="tablist" style={{ display: 'flex', gap: 6, marginTop: 14, flexWrap: 'wrap' }}>
          {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`btn btn-sm ${tab === k ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setParams({ tab: k })}>{l}</button>)}
        </div>
      </PageHeader>
      {tab === 'discussions' && <Discussions mod={mod} />}
      {tab === 'wall' && <Wall mod={mod} />}
      {tab === 'moderation' && mod && <Moderation />}
    </div>
  )
}

function Discussions({ mod }: { mod: boolean }) {
  const toast = useToast()
  const qc = useQueryClient()
  const [spaceId, setSpaceId] = useState('')
  const [q, setQ] = useState('')
  const [writing, setWriting] = useState(false)
  const { data: spaces = [] } = useQuery({ queryKey: ['forum-spaces'], queryFn: async () => (await api.get('/forums/spaces')).data.data as { id: string; name: string; description: string; threads: number }[] })
  const { data: threads = [], isLoading } = useQuery({ queryKey: ['forum-threads', spaceId, q], queryFn: async () => (await api.get('/forums/threads', { params: { ...(spaceId && { spaceId }), ...(q.trim() && { q: q.trim() }) } })).data.data as any[] })
  const addSpace = useMutation({
    mutationFn: (name: string) => api.post('/forums/spaces', { name }),
    onSuccess: () => { toast('Space added'); qc.invalidateQueries({ queryKey: ['forum-spaces'] }) },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  return (
    <div style={{ display: 'grid', gap: 'var(--gap)' }}>
      <section data-card className="card" style={{ padding: 14, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <div className="chips" style={{ flex: '1 1 300px' }}>
          <button className={`chip${!spaceId ? ' is-on' : ''}`} onClick={() => setSpaceId('')}>All</button>
          {spaces.map((s) => <button key={s.id} className={`chip${spaceId === s.id ? ' is-on' : ''}`} onClick={() => setSpaceId(s.id)} title={s.description}>{s.name} <span className="dim">{s.threads}</span></button>)}
          {mod && <button className="chip" onClick={() => { const n = window.prompt('Name of the new space'); if (n?.trim()) addSpace.mutate(n.trim()) }}><Icon name="plus" size={12} /> Space</button>}
        </div>
        <input className="input" style={{ width: 200 }} placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search discussions" />
        <button className="btn btn-primary btn-sm" disabled={!spaces.length} onClick={() => setWriting(true)}>New thread</button>
      </section>
      <section data-card className="card" style={{ padding: 8 }}>
        {isLoading ? <div className="skeleton" style={{ height: 120, borderRadius: 14 }} /> : !threads.length ? <p className="dim" style={{ padding: 16 }}>Nothing here yet. Start the first thread.</p> : threads.map((t) => (
          <Link key={t.id} to={`/community/${t.id}`} className="row-link" style={{ display: 'flex', gap: 12, alignItems: 'center', padding: 12, borderRadius: 14 }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                {t.pinned && <span className="pill honey">Pinned</span>}{t.locked && <span className="pill mute">Locked</span>}{t.hidden && <span className="pill danger">Hidden</span>}{t.hasPoll && <span className="pill info">Poll</span>}
                <strong style={{ fontWeight: 600 }}>{t.title}</strong>
              </span>
              <span className="dim" style={{ display: 'block', fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.space} · {t.author} · {when(t.lastActivityAt)} · {t.excerpt}</span>
            </span>
            <span className="dim num" style={{ fontSize: 12 }}><Icon name="message" size={13} /> {t.comments}</span>
          </Link>
        ))}
      </section>
      {writing && <NewThread spaces={spaces} defaultSpace={spaceId || spaces[0]?.id} onClose={() => setWriting(false)} />}
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
  const [f, setF] = useState({ spaceId: defaultSpace ?? '', title: '', body: '' })
  const [mentions, setMentions] = useState<string[]>([])
  const [poll, setPoll] = useState<{ question: string; options: string[]; multi: boolean } | null>(null)
  const pollOk = !poll || (poll.question.trim().length >= 3 && poll.options.filter((o) => o.trim()).length >= 2)
  const save = useMutation({
    mutationFn: () => api.post('/forums/threads', { spaceId: f.spaceId, title: f.title.trim(), body: f.body.trim(), ...(mentions.length && { mentions }), ...(poll && { poll: { question: poll.question.trim(), options: poll.options.map((o) => o.trim()).filter(Boolean), multi: poll.multi } }) }),
    onSuccess: () => { toast('Posted'); qc.invalidateQueries({ queryKey: ['forum-threads'] }); qc.invalidateQueries({ queryKey: ['forum-spaces'] }); onClose() },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  return (
    <Modal open onClose={onClose} title="New thread" width={640}>
      <div style={{ display: 'grid', gap: 12 }}>
        <label className="field"><span>Space</span><select className="input" value={f.spaceId} onChange={(e) => setF({ ...f, spaceId: e.target.value })}>{spaces.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label className="field"><span>Title</span><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={160} /></label>
        <label className="field"><span>Message</span><textarea className="input" rows={5} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} style={{ height: 'auto', padding: 12 }} maxLength={10000} /></label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
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
  const [mentions, setMentions] = useState<string[]>([])
  const { data: t, isLoading } = useQuery({ queryKey: ['forum-thread', id], queryFn: async () => (await api.get(`/forums/threads/${id}`)).data.data })
  const root = useReveal<HTMLDivElement>(isLoading)
  const refresh = () => { qc.invalidateQueries({ queryKey: ['forum-thread', id] }); qc.invalidateQueries({ queryKey: ['forum-threads'] }) }
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body: object }) => api.post(path, body),
    onSuccess: (_d, v) => { toast(v.path.endsWith('/comments') ? 'Replied' : v.path === '/forums/reports' ? 'Reported to HR' : 'Saved'); if (v.path.endsWith('/comments')) { setReply(''); setMentions([]) } refresh() },
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
          <p style={{ whiteSpace: 'pre-wrap' }}>{t.body}</p>
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
              <button className="btn btn-ghost btn-sm" onClick={() => act.mutate({ path: `/forums/threads/${id}/moderate`, body: { hidden: !t.hidden } })}>{t.hidden ? 'Show again' : 'Hide'}</button>
            </> : !t.mine && <button className="btn btn-ghost btn-sm" onClick={() => report('thread', t.id)}>Report</button>}
          </div>
        </section>
        <section data-card className="card" style={{ padding: 18, display: 'grid', gap: 12 }}>
          <h3 style={{ fontSize: 16 }}>{t.comments.length} repl{t.comments.length === 1 ? 'y' : 'ies'}</h3>
          {t.comments.map((c: any) => (
            <div key={c.id} style={{ borderTop: '1px solid var(--line)', paddingTop: 10, opacity: c.hidden ? 0.55 : 1 }}>
              <div className="dim" style={{ fontSize: 12 }}>{c.author.name} · {when(c.createdAt)}{c.hidden ? ' · hidden' : ''}</div>
              <p style={{ whiteSpace: 'pre-wrap', fontSize: 14 }}>{c.body}</p>
              {t.canModerate ? <button className="btn btn-ghost btn-sm" onClick={() => act.mutate({ path: `/forums/comments/${c.id}/hide`, body: { hidden: !c.hidden } })}>{c.hidden ? 'Show again' : 'Hide'}</button>
                : !c.mine && <button className="btn btn-ghost btn-sm" onClick={() => report('comment', c.id)}>Report</button>}
            </div>
          ))}
          {t.locked ? <p className="dim" style={{ fontSize: 13 }}>This thread is locked.</p> : (
            <div style={{ display: 'grid', gap: 8 }}>
              <textarea className="input" rows={3} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Write a reply…" style={{ height: 'auto', padding: 12 }} maxLength={5000} />
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <MentionPicker value={mentions} onPick={(pid, name) => { setMentions([...mentions, pid]); setReply(`${reply}${reply && !reply.endsWith(' ') ? ' ' : ''}@${name} `) }} />
                <button className="btn btn-primary btn-sm" disabled={act.isPending || !reply.trim()} onClick={() => act.mutate({ path: `/forums/threads/${id}/comments`, body: { body: reply.trim(), ...(mentions.length && { mentions }) } })}>Reply</button>
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
