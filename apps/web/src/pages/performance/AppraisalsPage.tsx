import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import { useAuth } from '../../contexts/AuthContext'
import PageHeader from '../../components/ui/PageHeader'
import { useToast } from '../../components/ui/Toast'
import { useReveal } from '../../lib/motion'

const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
const STATUS: Record<string, [string, string]> = { pending_self: ['warn', 'Self appraisal due'], self_submitted: ['info', 'With manager'], manager_submitted: ['honey', 'Reviewed'], published: ['ok', 'Result ready'], acknowledged: ['mute', 'Acknowledged'] }
const CYCLE: Record<string, string> = { draft: 'Draft', active: 'Open', calibration: 'Calibration', published: 'Published', closed: 'Closed' }
const POTENTIAL = ['', 'Lower potential', 'Solid potential', 'High potential']
const Pill = ({ s }: { s: string }) => <span className={`pill ${STATUS[s]?.[0] ?? 'mute'}`}>{STATUS[s]?.[1] ?? s}</span>

// Advanced performance management: self and manager appraisal, 360 feedback, calibration, results and improvement plans.
export default function AppraisalsPage() {
  const { hasRole } = useAuth()
  const hr = hasRole('hr_admin') || hasRole('system_admin')
  const manager = hasRole('manager') || hr
  const tabs = [['mine', 'My review'], ['feedback', 'Feedback for others'], ...(manager ? [['team', 'My team']] : []), ['plans', 'Improvement plans'], ...(hr ? [['manage', 'Cycles and results']] : [])] as [string, string][]
  const [tab, setTab] = useState('mine')
  const [open, setOpen] = useState<string | null>(null)
  const root = useReveal<HTMLDivElement>(tab + (open ?? ''))
  return (
    <div ref={root}>
      <PageHeader title="Appraisals" sub="Review cycles with self and manager appraisal, anonymous peer feedback and a clear result.">
        <div role="tablist" style={{ display: 'flex', gap: 6, marginTop: 14, flexWrap: 'wrap' }}>
          {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`btn btn-sm ${tab === k ? 'btn-primary' : 'btn-ghost'}`} onClick={() => { setTab(k); setOpen(null) }}>{l}</button>)}
        </div>
      </PageHeader>
      {open ? <Detail id={open} onBack={() => setOpen(null)} />
        : tab === 'feedback' ? <Feedback />
        : tab === 'plans' ? <Plans manager={manager} hr={hr} />
        : tab === 'manage' ? <Manage onOpen={setOpen} />
        : <List scope={tab === 'team' ? 'team' : 'mine'} onOpen={setOpen} />}
    </div>
  )
}

function List({ scope, onOpen }: { scope: 'mine' | 'team' | 'all'; onOpen: (id: string) => void }) {
  const q = useQuery({ queryKey: ['appraisals', scope], queryFn: async () => (await api.get('/appraisal/appraisals', { params: { scope } })).data.data as any[] })
  return (
    <div className="card" style={{ padding: 8 }}>
      {q.isLoading && <p style={{ padding: 16 }}>Loading…</p>}
      {q.data?.length === 0 && <p style={{ padding: 16, margin: 0 }}>{scope === 'mine' ? 'No review cycle is open for you right now.' : 'Nothing here yet.'}</p>}
      {q.data?.map((a) => (
        <button key={a.id} type="button" className="btn btn-ghost" onClick={() => onOpen(a.id)} style={{ display: 'flex', width: '100%', justifyContent: 'space-between', gap: 12, textAlign: 'left', height: 'auto', minHeight: 52, padding: '10px 14px' }}>
          <span><strong>{scope === 'mine' ? a.cycleName : a.employee}</strong><span className="dim" style={{ display: 'block', fontSize: 13 }}>{scope === 'mine' ? `Manager: ${a.manager ?? 'HR'}` : a.cycleName}</span></span>
          <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>{a.finalScore != null && <span className="pill honey">{a.finalScore}%</span>}<Pill s={a.status} /></span>
        </button>
      ))}
    </div>
  )
}

function Stars({ value, max, onChange, disabled }: { value: number; max: number; onChange: (n: number) => void; disabled?: boolean }) {
  return <span role="radiogroup" style={{ display: 'inline-flex', gap: 4 }}>{Array.from({ length: max }, (_, i) => i + 1).map((n) => (
    <button key={n} type="button" role="radio" aria-checked={value === n} disabled={disabled} className={`btn btn-sm ${value === n ? 'btn-primary' : 'btn-ghost'}`} style={{ minWidth: 34, padding: 0 }} onClick={() => onChange(n)}>{n}</button>))}</span>
}

function Detail({ id, onBack }: { id: string; onBack: () => void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['appraisal', id], queryFn: async () => (await api.get(`/appraisal/appraisals/${id}`)).data.data as any })
  const done = (m: string) => { toast(m); qc.invalidateQueries({ queryKey: ['appraisal', id] }); qc.invalidateQueries({ queryKey: ['appraisals'] }) }
  const a = q.data
  const [ratings, setRatings] = useState<Record<string, number>>({})
  const [potential, setPotential] = useState(2)
  const [comment, setComment] = useState('')
  const [cal, setCal] = useState({ finalScore: '', reason: '' })
  const comps: any[] = a?.competencies ?? []
  const complete = comps.length > 0 && comps.every((c) => ratings[c.id])
  const self = useMutation({ mutationFn: async () => (await api.post(`/appraisal/appraisals/${id}/self`, { ratings, comment: comment.trim() || undefined })).data.data, onSuccess: () => done('Self appraisal sent'), onError: (e) => toast(errMsg(e), 'error') })
  const mgr = useMutation({ mutationFn: async () => (await api.post(`/appraisal/appraisals/${id}/manager`, { ratings, potential, comment })).data.data, onSuccess: () => done('Review saved'), onError: (e) => toast(errMsg(e), 'error') })
  const calibrate = useMutation({ mutationFn: async () => (await api.post(`/appraisal/appraisals/${id}/calibrate`, { finalScore: Number(cal.finalScore), reason: cal.reason })).data.data, onSuccess: () => done('Calibrated'), onError: (e) => toast(errMsg(e), 'error') })
  const ack = useMutation({ mutationFn: async () => (await api.post(`/appraisal/appraisals/${id}/acknowledge`, { comment: comment.trim() || undefined })).data.data, onSuccess: () => done('Acknowledged'), onError: (e) => toast(errMsg(e), 'error') })
  if (q.isLoading || !a) return <p>Loading…</p>
  const rater = (disabled?: boolean) => comps.map((c) => (
    <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '8px 0', borderTop: '1px solid var(--line)', flexWrap: 'wrap' }}>
      <span><strong>{c.name}</strong><span className="dim" style={{ display: 'block', fontSize: 13 }}>{c.description}</span></span>
      <Stars value={ratings[c.id] ?? 0} max={a.scaleMax} disabled={disabled} onChange={(n) => setRatings({ ...ratings, [c.id]: n })} />
    </div>))
  const shown = (r?: Record<string, number>) => comps.map((c) => <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderTop: '1px solid var(--line)' }}><span>{c.name}</span><strong>{r?.[c.id] ?? '–'} / {a.scaleMax}</strong></div>)
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div><button className="btn btn-ghost btn-sm" onClick={onBack}>Back</button></div>
      <div className="card" style={{ padding: 20, display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <span><strong style={{ fontSize: 18 }}>{a.employee}</strong><span className="dim" style={{ display: 'block' }}>{a.cycleName} · {CYCLE[a.cycleStatus]} · manager {a.manager ?? 'HR'}</span></span>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>{a.finalScore != null && <><span className="pill honey">{a.finalScore}%</span><span className="pill ok">{a.rating}</span></>}<Pill s={a.status} /></span>
      </div>

      {a.self && <div className="card" style={{ padding: 20 }}><h2 style={{ fontSize: 17 }}>Self appraisal</h2>{shown(a.self.ratings)}{a.self.comment && <p style={{ marginBottom: 0 }}>“{a.self.comment}”</p>}</div>}
      {a.can.self && (
        <div className="card" style={{ padding: 20 }}><h2 style={{ fontSize: 17 }}>Your self appraisal</h2>
          <p className="dim" style={{ marginTop: 0 }}>Rate yourself from 1 to {a.scaleMax}. Be honest: your manager sees this before their own review.</p>
          {rater()}
          <div className="field" style={{ marginTop: 12 }}><label htmlFor="ap-c">Comments (optional)</label><textarea id="ap-c" className="input" rows={3} style={{ height: 'auto', padding: 14, borderRadius: 20 }} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={3000} /></div>
          <button className="btn btn-primary" style={{ marginTop: 12 }} disabled={!complete || self.isPending} onClick={() => self.mutate()}>{self.isPending ? 'Sending…' : 'Send self appraisal'}</button>
        </div>)}

      {a.peerReview && <Peers a={a} onDone={() => done('Reviewers requested')} />}

      {a.managerReview && (
        <div className="card" style={{ padding: 20 }}><h2 style={{ fontSize: 17 }}>Manager's review</h2>{shown(a.managerReview.ratings)}
          <p style={{ marginBottom: 0 }}>“{a.managerReview.comment}”</p>
          {a.scores && <p className="dim" style={{ marginBottom: 0 }}>Goals {a.scores.goalScore ?? 'none'}{a.scores.goalScore != null ? '%' : ''} · competencies {a.scores.competencyScore}% · potential: {POTENTIAL[a.managerReview.potential]}</p>}
        </div>)}
      {a.can.manager && (
        <div className="card" style={{ padding: 20 }}><h2 style={{ fontSize: 17 }}>{a.managerReview ? 'Change your review' : 'Your review'}</h2>
          {rater()}
          <div className="field" style={{ marginTop: 12 }}><label htmlFor="ap-pot">Potential</label><select id="ap-pot" className="input" value={potential} onChange={(e) => setPotential(Number(e.target.value))}>{[1, 2, 3].map((n) => <option key={n} value={n}>{POTENTIAL[n]}</option>)}</select></div>
          <div className="field" style={{ marginTop: 12 }}><label htmlFor="ap-m">Your comments</label><textarea id="ap-m" className="input" rows={3} style={{ height: 'auto', padding: 14, borderRadius: 20 }} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={3000} /></div>
          <button className="btn btn-primary" style={{ marginTop: 12 }} disabled={!complete || comment.trim().length < 3 || mgr.isPending} onClick={() => mgr.mutate()}>{mgr.isPending ? 'Saving…' : 'Save review'}</button>
        </div>)}
      {a.can.calibrate && (
        <div className="card" style={{ padding: 20, display: 'grid', gap: 10 }}><h2 style={{ fontSize: 17 }}>Calibrate</h2>
          {a.calibration && <span className="dim">Last: {a.calibration.previous} → {a.calibration.finalScore} ({a.calibration.reason})</span>}
          <div className="field"><label htmlFor="cal-s">Final score (0 to 150)</label><input id="cal-s" className="input" inputMode="decimal" value={cal.finalScore} onChange={(e) => setCal({ ...cal, finalScore: e.target.value })} /></div>
          <div className="field"><label htmlFor="cal-r">Reason (kept in the audit log)</label><input id="cal-r" className="input" value={cal.reason} onChange={(e) => setCal({ ...cal, reason: e.target.value })} /></div>
          <div><button className="btn btn-primary" disabled={calibrate.isPending || cal.finalScore === '' || cal.reason.trim().length < 5} onClick={() => calibrate.mutate()}>Save calibration</button></div>
        </div>)}
      {a.can.acknowledge && (
        <div className="card" style={{ padding: 20, display: 'grid', gap: 10 }}><h2 style={{ fontSize: 17 }}>Acknowledge your result</h2>
          <div className="field"><label htmlFor="ap-ack">Comment (optional)</label><input id="ap-ack" className="input" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} /></div>
          <div><button className="btn btn-primary" disabled={ack.isPending} onClick={() => ack.mutate()}>I have read it</button></div>
        </div>)}
    </div>
  )
}

function Peers({ a, onDone }: { a: any; onDone: () => void }) {
  const toast = useToast()
  const [term, setTerm] = useState('')
  const [picked, setPicked] = useState<{ id: string; name: string }[]>([])
  const people = useQuery({ queryKey: ['appraisal-people', term], enabled: term.trim().length >= 2, queryFn: async () => (await api.get('/appraisal/people', { params: { q: term.trim() } })).data.data as any[] })
  const send = useMutation({ mutationFn: async () => (await api.post(`/appraisal/appraisals/${a.id}/peers`, { employeeIds: picked.map((p) => p.id) })).data.data, onSuccess: () => { setPicked([]); setTerm(''); onDone() }, onError: (e) => toast(errMsg(e), 'error') })
  const p = a.peers
  const canAsk = a.cycleStatus === 'active' && (a.can.self || a.can.manager || a.status === 'pending_self' || a.status === 'self_submitted')
  return (
    <div className="card" style={{ padding: 20, display: 'grid', gap: 10 }}>
      <h2 style={{ fontSize: 17 }}>Peer feedback (anonymous)</h2>
      <span className="dim">{p ? `${p.answered} of ${p.requested} reviewers answered.` : 'No reviewers yet.'}{p?.minimum && p.answered < p.minimum ? ` Results show once ${p.minimum} have answered, so nobody can be identified.` : ''}</span>
      {p?.averages && comps(a).map((c: any) => <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--line)', padding: '6px 0' }}><span>{c.name}</span><strong>{p.averages[c.id]} / {a.scaleMax}</strong></div>)}
      {p?.comments?.map((c: string, i: number) => <p key={i} style={{ margin: 0 }}>“{c}”</p>)}
      {canAsk && (
        <>
          <div className="field"><label htmlFor="pr-q">Ask a colleague (2 to 5 in total)</label><input id="pr-q" className="input" placeholder="Start typing a name" value={term} onChange={(e) => setTerm(e.target.value)} /></div>
          {people.data?.filter((x) => !picked.some((s) => s.id === x.id)).map((x) => <button key={x.id} type="button" className="btn btn-ghost btn-sm" style={{ justifyContent: 'flex-start' }} onClick={() => { setPicked([...picked, x]); setTerm('') }}>{x.name} <span className="dim">{x.code}</span></button>)}
          {picked.length > 0 && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{picked.map((x) => <span key={x.id} className="chip is-on">{x.name} <button type="button" aria-label={`Remove ${x.name}`} className="link" onClick={() => setPicked(picked.filter((s) => s.id !== x.id))}>×</button></span>)}</div>}
          <div><button className="btn btn-primary btn-sm" disabled={!picked.length || send.isPending} onClick={() => send.mutate()}>Send requests</button></div>
        </>
      )}
    </div>
  )
}
const comps = (a: any): any[] => a.competencies ?? []

function Feedback() {
  const toast = useToast()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['appraisal-feedback'], queryFn: async () => (await api.get('/appraisal/feedback/mine')).data.data as any[] })
  const [r, setR] = useState<Record<string, Record<string, number>>>({})
  const [c, setC] = useState<Record<string, string>>({})
  const send = useMutation({ mutationFn: async (f: any) => (await api.post(`/appraisal/feedback/${f.id}`, { ratings: r[f.id], comment: c[f.id]?.trim() || undefined })).data.data, onSuccess: () => { toast('Thank you: your answer is anonymous'); qc.invalidateQueries({ queryKey: ['appraisal-feedback'] }) }, onError: (e) => toast(errMsg(e), 'error') })
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {q.data?.length === 0 && <div className="card" style={{ padding: 20 }}>Nobody has asked you for feedback.</div>}
      {q.data?.map((f) => (
        <div key={f.id} className="card" style={{ padding: 20 }}>
          <strong>{f.subject}</strong> <span className="dim">· {f.cycleName}</span> {f.status === 'submitted' && <span className="pill ok">Sent</span>}
          {f.status === 'requested' && f.open && (
            <>
              <p className="dim" style={{ margin: '6px 0' }}>Your name is never shown to {String(f.subject).split(' ')[0]} or their manager.</p>
              {f.competencies.map((k: any) => <div key={k.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '6px 0', borderTop: '1px solid var(--line)', flexWrap: 'wrap' }}><span>{k.name}</span><Stars value={r[f.id]?.[k.id] ?? 0} max={f.scaleMax} onChange={(n) => setR({ ...r, [f.id]: { ...(r[f.id] ?? {}), [k.id]: n } })} /></div>)}
              <div className="field" style={{ marginTop: 10 }}><label htmlFor={`fc-${f.id}`}>Comment (optional)</label><input id={`fc-${f.id}`} className="input" maxLength={2000} value={c[f.id] ?? ''} onChange={(e) => setC({ ...c, [f.id]: e.target.value })} /></div>
              <button className="btn btn-primary btn-sm" style={{ marginTop: 10 }} disabled={send.isPending || f.competencies.some((k: any) => !r[f.id]?.[k.id])} onClick={() => send.mutate(f)}>Send</button>
            </>
          )}
        </div>
      ))}
    </div>
  )
}

function Manage({ onOpen }: { onOpen: (id: string) => void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const cycles = useQuery({ queryKey: ['appraisal-cycles'], queryFn: async () => (await api.get('/appraisal/cycles')).data.data as any[] })
  const comps = useQuery({ queryKey: ['appraisal-comps'], queryFn: async () => (await api.get('/appraisal/competencies')).data.data as any[] })
  const [sel, setSel] = useState<string | null>(null)
  const [f, setF] = useState({ name: '', startDate: `${new Date().getFullYear()}-01-01`, endDate: `${new Date().getFullYear()}-12-31`, goalsWeight: 50, scaleMax: 5 })
  const [chosen, setChosen] = useState<string[]>([])
  const refresh = () => qc.invalidateQueries({ queryKey: ['appraisal-cycles'] })
  const create = useMutation({ mutationFn: async () => (await api.post('/appraisal/cycles', { ...f, competencyIds: chosen.length ? chosen : (comps.data ?? []).slice(0, 4).map((c) => c.id), peerReview: true })).data.data, onSuccess: () => { toast('Cycle created'); setF({ ...f, name: '' }); refresh() }, onError: (e) => toast(errMsg(e), 'error') })
  const launch = useMutation({ mutationFn: async (id: string) => (await api.post(`/appraisal/cycles/${id}/launch`, {})).data.data, onSuccess: (d) => { toast(`Launched for ${d.participants} people`); refresh() }, onError: (e) => toast(errMsg(e), 'error') })
  const move = useMutation({ mutationFn: async (v: { id: string; status: string }) => (await api.post(`/appraisal/cycles/${v.id}/status`, { status: v.status })).data.data, onSuccess: () => { toast('Updated'); refresh() }, onError: (e) => toast(errMsg(e), 'error') })
  const NEXT: Record<string, [string, string][]> = { active: [['calibration', 'Open calibration']], calibration: [['published', 'Publish results'], ['active', 'Back to open']], published: [['closed', 'Close cycle']] }
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div className="card" style={{ padding: 20, display: 'grid', gap: 10 }}>
        <h2 style={{ fontSize: 17 }}>New review cycle</h2>
        <div className="field"><label htmlFor="cy-n">Name</label><input id="cy-n" className="input" placeholder="Annual 2026" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <div className="field"><label htmlFor="cy-s">Starts</label><input id="cy-s" type="date" className="input" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></div>
          <div className="field"><label htmlFor="cy-e">Ends</label><input id="cy-e" type="date" className="input" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></div>
          <div className="field"><label htmlFor="cy-g">Goals count for (%)</label><input id="cy-g" className="input" inputMode="numeric" value={f.goalsWeight} onChange={(e) => setF({ ...f, goalsWeight: Number(e.target.value) || 0 })} /></div>
          <div className="field"><label htmlFor="cy-sc">Rating scale (1 to)</label><input id="cy-sc" className="input" inputMode="numeric" value={f.scaleMax} onChange={(e) => setF({ ...f, scaleMax: Math.min(10, Math.max(3, Number(e.target.value) || 5)) })} /></div>
        </div>
        <div><span className="dim" style={{ fontSize: 13 }}>Competencies (none chosen = the first four)</span>
          <div className="chips" style={{ marginTop: 6 }}>{comps.data?.filter((c) => c.active !== false).map((c) => <button key={c.id} type="button" className={`chip ${chosen.includes(c.id) ? 'is-on' : ''}`} onClick={() => setChosen(chosen.includes(c.id) ? chosen.filter((x) => x !== c.id) : [...chosen, c.id])}>{c.name}</button>)}</div></div>
        <div><button className="btn btn-primary" disabled={create.isPending || f.name.trim().length < 2} onClick={() => create.mutate()}>Create cycle</button></div>
      </div>
      {cycles.data?.map((c) => (
        <div key={c.id} className="card" style={{ padding: 20, display: 'grid', gap: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}><span><strong>{c.name}</strong><span className="dim" style={{ display: 'block', fontSize: 13 }}>{String(c.startDate).slice(0, 10)} to {String(c.endDate).slice(0, 10)} · {c.participants} people</span></span><span className="pill info">{CYCLE[c.status]}</span></div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {c.status === 'draft' && <button className="btn btn-primary btn-sm" disabled={launch.isPending} onClick={() => launch.mutate(c.id)}>Launch for everyone</button>}
            {(NEXT[c.status] ?? []).map(([s, l]) => <button key={s} className="btn btn-ghost btn-sm" disabled={move.isPending} onClick={() => move.mutate({ id: c.id, status: s })}>{l}</button>)}
            {c.status !== 'draft' && <button className="btn btn-ghost btn-sm" onClick={() => setSel(sel === c.id ? null : c.id)}>{sel === c.id ? 'Hide results' : 'Results'}</button>}
          </div>
          {sel === c.id && <Summary id={c.id} onOpen={onOpen} />}
        </div>
      ))}
    </div>
  )
}

function Summary({ id, onOpen }: { id: string; onOpen: (id: string) => void }) {
  const s = useQuery({ queryKey: ['appraisal-summary', id], queryFn: async () => (await api.get(`/appraisal/cycles/${id}/summary`)).data.data as any })
  const all = useQuery({ queryKey: ['appraisals', 'all', id], queryFn: async () => (await api.get('/appraisal/appraisals', { params: { scope: 'all', cycleId: id } })).data.data as any[] })
  if (!s.data) return <p>Loading…</p>
  const cell = (perf: string, pot: number) => s.data.grid[`${perf}:${pot}`] ?? []
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{Object.entries(s.data.distribution).map(([k, v]) => <span key={k} className="pill mute">{k}: {String(v)}</span>)}</div>
      <div>
        <strong style={{ fontSize: 14 }}>9-box: performance across, potential up</strong>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginTop: 6 }}>
          {[3, 2, 1].flatMap((pot) => ['low', 'medium', 'high'].map((perf) => <div key={`${perf}${pot}`} className="card" style={{ padding: 10, minHeight: 64, fontSize: 13 }}><span className="dim">{POTENTIAL[pot]} · {perf}</span>{cell(perf, pot).map((n: string, i: number) => <div key={i}>{n}</div>)}</div>))}
        </div>
      </div>
      <div>{all.data?.map((a) => <button key={a.id} type="button" className="btn btn-ghost" style={{ display: 'flex', width: '100%', justifyContent: 'space-between', textAlign: 'left', height: 'auto', minHeight: 44 }} onClick={() => onOpen(a.id)}><span>{a.employee}</span><span style={{ display: 'flex', gap: 8 }}>{a.finalScore != null && <span className="pill honey">{a.finalScore}%</span>}<Pill s={a.status} /></span></button>)}</div>
    </div>
  )
}

function Plans({ manager, hr }: { manager: boolean; hr: boolean }) {
  const toast = useToast()
  const qc = useQueryClient()
  const [scope, setScope] = useState<'mine' | 'team' | 'all'>('mine')
  const q = useQuery({ queryKey: ['plans', scope], queryFn: async () => (await api.get('/appraisal/plans', { params: { scope } })).data.data as any[] })
  const refresh = () => qc.invalidateQueries({ queryKey: ['plans'] })
  const [term, setTerm] = useState('')
  const [who, setWho] = useState<{ id: string; name: string } | null>(null)
  const [f, setF] = useState({ reason: '', endDate: '', objectives: '' })
  const people = useQuery({ queryKey: ['appraisal-people', term], enabled: term.trim().length >= 2 && !who, queryFn: async () => (await api.get('/appraisal/people', { params: { q: term.trim() } })).data.data as any[] })
  const create = useMutation({ mutationFn: async () => (await api.post('/appraisal/plans', { employeeId: who!.id, reason: f.reason, endDate: f.endDate, objectives: f.objectives.split('\n').map((x) => x.trim()).filter(Boolean) })).data.data, onSuccess: () => { toast('Plan started'); setWho(null); setTerm(''); setF({ reason: '', endDate: '', objectives: '' }); refresh() }, onError: (e) => toast(errMsg(e), 'error') })
  const tick = useMutation({ mutationFn: async (v: { id: string; objectiveId: string; done: boolean }) => (await api.post(`/appraisal/plans/${v.id}/progress`, { objectiveId: v.objectiveId, done: v.done })).data.data, onSuccess: refresh, onError: (e) => toast(errMsg(e), 'error') })
  const close = useMutation({ mutationFn: async (v: { id: string; outcome: string }) => (await api.post(`/appraisal/plans/${v.id}/close`, { outcome: v.outcome, note: v.outcome === 'successful' ? 'Objectives met' : 'Objectives not met' })).data.data, onSuccess: () => { toast('Plan closed'); refresh() }, onError: (e) => toast(errMsg(e), 'error') })
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {manager && (
        <div style={{ display: 'flex', gap: 6 }}>{(['mine', 'team', ...(hr ? ['all'] : [])] as const).map((k) => <button key={k} className={`btn btn-sm ${scope === k ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setScope(k as any)}>{k === 'mine' ? 'Mine' : k === 'team' ? 'My team' : 'Everyone'}</button>)}</div>
      )}
      {manager && (
        <div className="card" style={{ padding: 20, display: 'grid', gap: 10 }}>
          <h2 style={{ fontSize: 17 }}>Start an improvement plan</h2>
          {who ? <span className="chip is-on">{who.name} <button type="button" className="link" onClick={() => setWho(null)}>change</button></span> : (
            <>
              <div className="field"><label htmlFor="pl-q">Who is it for?</label><input id="pl-q" className="input" placeholder="Start typing a name" value={term} onChange={(e) => setTerm(e.target.value)} /></div>
              {people.data?.map((x) => <button key={x.id} type="button" className="btn btn-ghost btn-sm" style={{ justifyContent: 'flex-start' }} onClick={() => setWho(x)}>{x.name} <span className="dim">{x.code}</span></button>)}
            </>
          )}
          <div className="field"><label htmlFor="pl-r">Why</label><input id="pl-r" className="input" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></div>
          <div className="field"><label htmlFor="pl-e">Ends on</label><input id="pl-e" type="date" className="input" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></div>
          <div className="field"><label htmlFor="pl-o">Objectives, one per line</label><textarea id="pl-o" className="input" rows={3} style={{ height: 'auto', padding: 14, borderRadius: 20 }} value={f.objectives} onChange={(e) => setF({ ...f, objectives: e.target.value })} /></div>
          <div><button className="btn btn-primary" disabled={!who || create.isPending || f.reason.trim().length < 5 || !f.endDate || !f.objectives.trim()} onClick={() => create.mutate()}>Start plan</button></div>
        </div>
      )}
      {q.data?.length === 0 && <div className="card" style={{ padding: 20 }}>No improvement plans.</div>}
      {q.data?.map((p) => (
        <div key={p.id} className="card" style={{ padding: 20, display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}><span><strong>{p.employee}</strong><span className="dim" style={{ display: 'block', fontSize: 13 }}>{p.reason} · until {String(p.endDate).slice(0, 10)}</span></span><span className={`pill ${p.status === 'active' ? 'warn' : p.outcome === 'successful' ? 'ok' : 'mute'}`}>{p.status === 'active' ? 'Active' : p.outcome}</span></div>
          {p.objectives.map((o: any) => <label key={o.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={o.done} disabled={scope === 'mine' || p.status !== 'active'} onChange={(e) => tick.mutate({ id: p.id, objectiveId: o.id, done: e.target.checked })} /> {o.text}</label>)}
          {p.status === 'active' && scope !== 'mine' && <div style={{ display: 'flex', gap: 8 }}><button className="btn btn-primary btn-sm" onClick={() => close.mutate({ id: p.id, outcome: 'successful' })}>Close: met</button><button className="btn btn-ghost btn-sm" onClick={() => close.mutate({ id: p.id, outcome: 'unsuccessful' })}>Close: not met</button></div>}
        </div>
      ))}
    </div>
  )
}
