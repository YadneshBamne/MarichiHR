import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import { useAuth } from '../../contexts/AuthContext'
import PageHeader from '../../components/ui/PageHeader'
import ReasonModal from '../../components/ui/ReasonModal'
import Modal from '../../components/ui/Modal'
import { useToast } from '../../components/ui/Toast'
import { useReveal } from '../../lib/motion'
import { fmtDate } from '../../lib/format'

const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
const STATUS: Record<string, [string, string]> = { pending_self: ['warn', 'Self appraisal due'], self_submitted: ['info', 'With manager'], manager_submitted: ['honey', 'Reviewed'], published: ['ok', 'Result ready'], acknowledged: ['mute', 'Acknowledged'], excluded: ['mute', 'Removed from the cycle'] }
const CYCLE: Record<string, string> = { draft: 'Draft', launching: 'Launching', active: 'Open', calibration: 'Calibration', published: 'Published', closed: 'Closed' }
const POTENTIAL = ['', 'Lower potential', 'Solid potential', 'High potential']
const Pill = ({ s }: { s: string }) => <span className={`pill ${STATUS[s]?.[0] ?? 'mute'}`}>{STATUS[s]?.[1] ?? s}</span>
// What a rating means as a score (kept in step with the server: the lowest rating counts as 40%, the top one as 120%)
const scaleHelp = (max: number) => `Competency ratings count as a score: 1 = 40%${max > 2 ? `, ${Math.round(40 + ((Math.ceil(max / 2) - 1) / (max - 1)) * 80)}% for ${Math.ceil(max / 2)}` : ''}, ${max} = 120%. 110% and above is "Exceeds expectations", 90% to 110% "Meets", 70% to 90% "Partly meets". On a 1 to 5 scale, 4 is "Meets" and a perfect 5 can exceed.`

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
  const done = (m: string) => { toast(m); qc.invalidateQueries({ queryKey: ['appraisal', id] }); qc.invalidateQueries({ queryKey: ['appraisals'] }); qc.invalidateQueries({ queryKey: ['appraisal-cycles'] }) }
  const a = q.data
  const [ratings, setRatings] = useState<Record<string, number>>({})
  const [potential, setPotential] = useState(2)
  const [comment, setComment] = useState('')
  const [skip, setSkip] = useState({ on: false, reason: '' })
  const [cal, setCal] = useState({ finalScore: '', reason: '' })
  const [ask, setAsk] = useState<null | 'exclude'>(null)
  const comps: any[] = a?.competencies ?? []
  // "Change your review" starts from what was saved
  useEffect(() => { if (a?.managerReview && a.can.manager) { setRatings(a.managerReview.ratings ?? {}); setPotential(a.managerReview.potential ?? 2); setComment(a.managerReview.comment ?? '') } }, [a?.id, a?.managerReview, a?.can?.manager]) // eslint-disable-line react-hooks/exhaustive-deps
  const complete = comps.length > 0 && comps.every((c) => ratings[c.id])
  const self = useMutation({ mutationFn: async () => (await api.post(`/appraisal/appraisals/${id}/self`, { ratings, comment: comment.trim() || undefined })).data.data, onSuccess: () => done('Self appraisal sent'), onError: (e) => toast(errMsg(e), 'error') })
  const mgr = useMutation({ mutationFn: async () => (await api.post(`/appraisal/appraisals/${id}/manager`, { ratings, potential, comment, ...(skip.on && { skipSelf: true, skipReason: skip.reason.trim() }) })).data.data, onSuccess: () => done('Review saved'), onError: (e) => toast(errMsg(e), 'error') })
  const calibrate = useMutation({ mutationFn: async () => (await api.post(`/appraisal/appraisals/${id}/calibrate`, { finalScore: Number(cal.finalScore), reason: cal.reason })).data.data, onSuccess: () => done('Calibrated'), onError: (e) => toast(errMsg(e), 'error') })
  const ack = useMutation({ mutationFn: async () => (await api.post(`/appraisal/appraisals/${id}/acknowledge`, { comment: comment.trim() || undefined })).data.data, onSuccess: () => done('Acknowledged'), onError: (e) => toast(errMsg(e), 'error') })
  const exclude = useMutation({ mutationFn: async (reason: string) => (await api.post(`/appraisal/appraisals/${id}/exclude`, { reason })).data.data, onSuccess: () => { setAsk(null); done('Removed from the cycle') }, onError: (e) => toast(errMsg(e), 'error') })
  const restore = useMutation({ mutationFn: async () => (await api.post(`/appraisal/appraisals/${id}/restore`)).data.data, onSuccess: () => done('Back in the cycle'), onError: (e) => toast(errMsg(e), 'error') })
  if (q.isError) return <div className="card" style={{ padding: 20, display: 'grid', gap: 10 }}><span>This appraisal could not be loaded.</span><div style={{ display: 'flex', gap: 8 }}><button className="btn btn-primary btn-sm" onClick={() => q.refetch()}>Try again</button><button className="btn btn-ghost btn-sm" onClick={onBack}>Back</button></div></div>
  if (q.isLoading || !a) return <p>Loading…</p>
  const rater = (disabled?: boolean) => comps.map((c) => (
    <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '8px 0', borderTop: '1px solid var(--line)', flexWrap: 'wrap' }}>
      <span><strong>{c.name}</strong><span className="dim" style={{ display: 'block', fontSize: 13 }}>{c.description}</span></span>
      <Stars value={ratings[c.id] ?? 0} max={a.scaleMax} disabled={disabled} onChange={(n) => setRatings({ ...ratings, [c.id]: n })} />
    </div>))
  const shown = (r?: Record<string, number>) => comps.map((c) => <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderTop: '1px solid var(--line)' }}><span>{c.name}</span><strong>{r?.[c.id] ?? '–'} / {a.scaleMax}</strong></div>)
  const mayReview = a.can.manager || a.can.skipSelf
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div><button className="btn btn-ghost btn-sm" onClick={onBack}>Back</button></div>
      <div className="card" style={{ padding: 20, display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <span><strong style={{ fontSize: 18 }}>{a.employee}</strong><span className="dim" style={{ display: 'block' }}>{a.cycleName} · {CYCLE[a.cycleStatus]} · manager {a.manager ?? 'HR'}</span></span>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {a.finalScore != null && <><span className="pill honey">{a.finalScore}%</span><span className="pill ok">{a.rating}</span></>}<Pill s={a.status} />
          {a.can.hrTools && <button className="btn btn-ghost btn-sm" onClick={() => setAsk('exclude')}>Remove from the cycle</button>}
          {a.can.restore && <button className="btn btn-ghost btn-sm" disabled={restore.isPending} onClick={() => restore.mutate()}>Put back in the cycle</button>}
        </span>
      </div>
      {a.exclusion && <div className="well" style={{ padding: 12, fontSize: 14 }}><strong>Removed from the cycle:</strong> {a.exclusion.reason}</div>}
      {a.selfSkipped && <div className="well" style={{ padding: 12, fontSize: 14 }}><strong>Self appraisal skipped by HR:</strong> {a.selfSkipped.reason}</div>}
      {a.ownRule && <div className="well" style={{ padding: 12, fontSize: 14 }}>{a.ownRule}</div>}

      {a.self && <div className="card" style={{ padding: 20 }}><h2 style={{ fontSize: 17 }}>Self appraisal</h2>{shown(a.self.ratings)}{a.self.comment && <p style={{ marginBottom: 0 }}>“{a.self.comment}”</p>}</div>}
      {a.can.self && (
        <div className="card" style={{ padding: 20 }}><h2 style={{ fontSize: 17 }}>Your self appraisal</h2>
          <p className="dim" style={{ marginTop: 0 }}>Rate yourself from 1 to {a.scaleMax}. Be honest: your manager sees this before their own review.</p>
          {rater()}
          <div className="field" style={{ marginTop: 12 }}><label htmlFor="ap-c">Comments (optional)</label><textarea id="ap-c" className="input" rows={3} style={{ height: 'auto', padding: 14, borderRadius: 20 }} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={3000} /></div>
          <button className="btn btn-primary" style={{ marginTop: 12 }} disabled={!complete || self.isPending} onClick={() => self.mutate()}>{self.isPending ? 'Sending…' : 'Send self appraisal'}</button>
        </div>)}

      {a.peerReview && <Peers a={a} onDone={(m) => done(m)} />}

      {a.managerReview && (
        <div className="card" style={{ padding: 20 }}><h2 style={{ fontSize: 17 }}>Manager's review</h2>{shown(a.managerReview.ratings)}
          <p style={{ marginBottom: 0 }}>“{a.managerReview.comment}”</p>
          {a.scores && <p className="dim" style={{ marginBottom: 0 }}>Goals {a.scores.goalScore ?? 'none'}{a.scores.goalScore != null ? '%' : ''} · competencies {a.scores.competencyScore}% · potential: {POTENTIAL[a.managerReview.potential]}</p>}
        </div>)}
      {mayReview && (
        <div className="card" style={{ padding: 20 }}><h2 style={{ fontSize: 17 }}>{a.managerReview ? 'Change your review' : 'Your review'}</h2>
          <p className="dim" style={{ marginTop: 0, fontSize: 13 }}>{scaleHelp(a.scaleMax)}</p>
          {a.can.skipSelf && (
            <div className="well" style={{ padding: 12, marginBottom: 8, display: 'grid', gap: 8 }}>
              <span style={{ fontSize: 14 }}>{a.employee} has not sent a self appraisal yet. As HR you can write the review without it (for example when they are on long leave).</span>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}><input type="checkbox" checked={skip.on} onChange={(e) => setSkip({ ...skip, on: e.target.checked })} /> Write the review without the self appraisal</label>
              {skip.on && <input className="input" value={skip.reason} onChange={(e) => setSkip({ ...skip, reason: e.target.value })} placeholder="Why? (kept in the audit log)" maxLength={500} aria-label="Reason for skipping the self appraisal" />}
            </div>)}
          {rater()}
          <div className="field" style={{ marginTop: 12 }}><label htmlFor="ap-pot">Potential</label><select id="ap-pot" className="input" value={potential} onChange={(e) => setPotential(Number(e.target.value))}>{[1, 2, 3].map((n) => <option key={n} value={n}>{POTENTIAL[n]}</option>)}</select></div>
          <div className="field" style={{ marginTop: 12 }}><label htmlFor="ap-m">Your comments</label><textarea id="ap-m" className="input" rows={3} style={{ height: 'auto', padding: 14, borderRadius: 20 }} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={3000} /></div>
          <button className="btn btn-primary" style={{ marginTop: 12 }} disabled={!complete || comment.trim().length < 3 || mgr.isPending || (a.can.skipSelf && !a.can.manager && !skip.on) || (skip.on && skip.reason.trim().length < 5)} onClick={() => mgr.mutate()}>{mgr.isPending ? 'Saving…' : 'Save review'}</button>
        </div>)}
      {a.can.calibrate && (
        <div className="card" style={{ padding: 20, display: 'grid', gap: 10 }}><h2 style={{ fontSize: 17 }}>Calibrate</h2>
          {a.calibration && <span className="dim">Last: {a.calibration.previous} → {a.calibration.finalScore} ({a.calibration.reason})</span>}
          <p className="dim" style={{ margin: 0, fontSize: 13 }}>Today's score is {a.scores?.computed ?? '–'}%. Enter the final score as a percentage: 100 is "Meets expectations", 110 and above "Exceeds", under 70 "Below" (0 to 150).</p>
          <div className="field"><label htmlFor="cal-s">Final score (0 to 150)</label><input id="cal-s" className="input" inputMode="decimal" value={cal.finalScore} onChange={(e) => setCal({ ...cal, finalScore: e.target.value })} /></div>
          <div className="field"><label htmlFor="cal-r">Reason (kept in the audit log)</label><input id="cal-r" className="input" value={cal.reason} onChange={(e) => setCal({ ...cal, reason: e.target.value })} /></div>
          <div><button className="btn btn-primary" disabled={calibrate.isPending || cal.finalScore === '' || cal.reason.trim().length < 5} onClick={() => calibrate.mutate()}>Save calibration</button></div>
        </div>)}
      {a.can.acknowledge && (
        <div className="card" style={{ padding: 20, display: 'grid', gap: 10 }}><h2 style={{ fontSize: 17 }}>Acknowledge your result</h2>
          <div className="field"><label htmlFor="ap-ack">Comment (optional)</label><input id="ap-ack" className="input" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} /></div>
          <div><button className="btn btn-primary" disabled={ack.isPending} onClick={() => ack.mutate()}>I have read it</button></div>
        </div>)}
      {ask === 'exclude' && <ReasonModal title="Remove from the cycle" label="Why is this person being removed?" help="For example a leaver or someone on long leave. They no longer count towards publishing, any open 360 requests are cancelled, and you can put them back later." confirmLabel="Remove" busy={exclude.isPending} onClose={() => setAsk(null)} onSubmit={(r) => exclude.mutate(r)} />}
    </div>
  )
}

function Peers({ a, onDone }: { a: any; onDone: (m: string) => void }) {
  const toast = useToast()
  const [term, setTerm] = useState('')
  const [picked, setPicked] = useState<{ id: string; name: string }[]>([])
  const [swap, setSwap] = useState<any | null>(null)
  const [swapTerm, setSwapTerm] = useState('')
  const [mod, setMod] = useState<{ item: any; action: 'hide' | 'edit' | 'restore' } | null>(null)
  const [modText, setModText] = useState('')
  const people = useQuery({ queryKey: ['appraisal-people', term], enabled: term.trim().length >= 2, queryFn: async () => (await api.get('/appraisal/people', { params: { q: term.trim() } })).data.data as any[] })
  const swapPeople = useQuery({ queryKey: ['appraisal-people', swapTerm], enabled: !!swap && swapTerm.trim().length >= 2, queryFn: async () => (await api.get('/appraisal/people', { params: { q: swapTerm.trim() } })).data.data as any[] })
  const send = useMutation({ mutationFn: async () => (await api.post(`/appraisal/appraisals/${a.id}/peers`, { employeeIds: picked.map((p) => p.id) })).data.data, onSuccess: () => { setPicked([]); setTerm(''); onDone('Reviewers requested') }, onError: (e) => toast(errMsg(e), 'error') })
  const replace = useMutation({ mutationFn: async (v: { fid: string; employeeId: string }) => (await api.post(`/appraisal/appraisals/${a.id}/peers/${v.fid}/replace`, { employeeId: v.employeeId })).data.data, onSuccess: () => { setSwap(null); setSwapTerm(''); onDone('Reviewer replaced') }, onError: (e) => toast(errMsg(e), 'error') })
  const remind = useMutation({ mutationFn: async () => (await api.post(`/appraisal/appraisals/${a.id}/peers/remind`)).data.data, onSuccess: (d) => onDone(d.reminded ? `Reminded ${d.reminded} reviewer${d.reminded === 1 ? '' : 's'}` : 'Everyone was reminded in the last day'), onError: (e) => toast(errMsg(e), 'error') })
  const moderate = useMutation({ mutationFn: async (v: { reason: string }) => (await api.post(`/appraisal/appraisals/${a.id}/peers/${mod!.item.id}/moderate`, { action: mod!.action, reason: v.reason, ...(mod!.action === 'edit' && { text: modText.trim() }) })).data.data, onSuccess: () => { setMod(null); onDone('Comment updated') }, onError: (e) => toast(errMsg(e), 'error') })
  const p = a.peers
  const nominated = p?.requested ?? 0
  const canAsk = a.cycleStatus === 'active' && a.status !== 'excluded' && (a.can.self || a.can.manager || a.status === 'pending_self' || a.status === 'self_submitted')
  const hr = !!p?.commentItems
  return (
    <div className="card" style={{ padding: 20, display: 'grid', gap: 10 }}>
      <h2 style={{ fontSize: 17 }}>Peer feedback (anonymous)</h2>
      <span className="dim">{p ? `${p.answered} of ${p.requested} reviewers answered.` : 'No reviewers yet.'}{p?.minimum && p.answered < p.minimum ? ` Results show once ${p.minimum} have answered, so nobody can be identified.` : ''}</span>
      {p?.averages && (a.competencies ?? []).map((c: any) => <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--line)', padding: '6px 0' }}><span>{c.name}</span><strong>{p.averages[c.id]} / {a.scaleMax}</strong></div>)}
      {!hr && p?.comments?.map((c: string, i: number) => <p key={i} style={{ margin: 0 }}>“{c}”</p>)}
      {hr && p.commentItems.map((it: any) => (
        <div key={it.id} className="well" style={{ padding: 10, display: 'grid', gap: 6 }}>
          <span style={{ fontSize: 14 }}>{it.hidden ? <em className="dim">Hidden: </em> : null}“{it.hidden ? it.original : it.shown}”{it.edited && <span className="pill info" style={{ marginLeft: 6 }}>edited</span>}</span>
          {it.edited && <span className="dim" style={{ fontSize: 12 }}>Original: “{it.original}”</span>}
          {(it.hidden || it.edited) && it.reason && <span className="dim" style={{ fontSize: 12 }}>Reason: {it.reason}</span>}
          {['active', 'calibration'].includes(a.cycleStatus) && ['manager_submitted', 'self_submitted', 'pending_self'].includes(a.status) && (
            <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setMod({ item: it, action: 'hide' })}>Hide</button>
              <button className="btn btn-ghost btn-sm" onClick={() => { setModText(it.shown ?? it.original); setMod({ item: it, action: 'edit' }) }}>Edit</button>
              {(it.hidden || it.edited) && <button className="btn btn-ghost btn-sm" onClick={() => setMod({ item: it, action: 'restore' })}>Restore</button>}
            </span>)}
        </div>))}
      {hr && p.pending?.length > 0 && (
        <div style={{ display: 'grid', gap: 6 }}>
          <strong style={{ fontSize: 14 }}>Waiting for an answer</strong>
          {p.pending.map((x: any) => <div key={x.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}><span>{x.reviewer}{x.remindedAt && <span className="dim"> · reminded {fmtDate(x.remindedAt)}</span>}</span>{a.cycleStatus === 'active' && <button className="btn btn-ghost btn-sm" onClick={() => setSwap(x)}>Replace</button>}</div>)}
          {a.cycleStatus === 'active' && <div><button className="btn btn-ghost btn-sm" disabled={remind.isPending} onClick={() => remind.mutate()}>Remind everyone waiting</button></div>}
        </div>)}
      {canAsk && (
        <>
          <div className="field"><label htmlFor="pr-q">Ask colleagues for feedback (3 to 5 peers in total{nominated ? `, ${nominated} asked so far` : ''})</label><input id="pr-q" className="input" placeholder="Start typing a name" value={term} onChange={(e) => setTerm(e.target.value)} /></div>
          {people.data?.filter((x) => !picked.some((s) => s.id === x.id)).map((x) => <button key={x.id} type="button" className="btn btn-ghost btn-sm" style={{ justifyContent: 'flex-start' }} onClick={() => { setPicked([...picked, x]); setTerm('') }}>{x.name} <span className="dim">{x.code}</span></button>)}
          {picked.length > 0 && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{picked.map((x) => <span key={x.id} className="chip is-on">{x.name} <button type="button" aria-label={`Remove ${x.name}`} className="link" onClick={() => setPicked(picked.filter((s) => s.id !== x.id))}>×</button></span>)}</div>}
          <div><button className="btn btn-primary btn-sm" disabled={!picked.length || nominated + picked.length < 3 || nominated + picked.length > 5 || send.isPending} onClick={() => send.mutate()}>Send requests</button>{picked.length > 0 && nominated + picked.length < 3 && <span className="dim" style={{ fontSize: 12, marginLeft: 8 }}>Choose at least {3 - nominated} (feedback is shown only from 3 answers).</span>}</div>
        </>
      )}
      {swap && (
        <Modal open onClose={() => setSwap(null)} title={`Replace ${swap.reviewer}`} width={440}>
          <div style={{ display: 'grid', gap: 10 }}>
            <p className="dim" style={{ margin: 0, fontSize: 13 }}>They have not answered. Choose someone else to ask instead.</p>
            <input className="input" placeholder="Start typing a name" value={swapTerm} onChange={(e) => setSwapTerm(e.target.value)} autoFocus aria-label="Find a replacement" />
            {swapPeople.data?.map((x) => <button key={x.id} type="button" className="btn btn-ghost btn-sm" style={{ justifyContent: 'flex-start' }} disabled={replace.isPending} onClick={() => replace.mutate({ fid: swap.id, employeeId: x.id })}>{x.name} <span className="dim">{x.code}</span></button>)}
          </div>
        </Modal>)}
      {mod && (
        <ReasonModal title={mod.action === 'hide' ? 'Hide this comment' : mod.action === 'edit' ? 'Edit this comment' : 'Restore the original comment'} label="Reason (kept in the audit log)" confirmLabel={mod.action === 'hide' ? 'Hide comment' : mod.action === 'edit' ? 'Save the edited comment' : 'Restore'} busy={moderate.isPending}
          help={mod.action === 'edit' ? <>Edit it so it no longer names or points at the writer. <textarea className="input" rows={3} value={modText} onChange={(e) => setModText(e.target.value)} maxLength={2000} style={{ height: 'auto', padding: 10, marginTop: 6 }} aria-label="Edited comment" /></> : mod.action === 'hide' ? 'Use this when a comment names its writer or could identify them. Nobody else will see it, and the average is not affected.' : undefined}
          onClose={() => setMod(null)} onSubmit={(reason) => moderate.mutate({ reason })} />)}
    </div>
  )
}

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
              <p className="dim" style={{ margin: '6px 0' }}>Your name is never shown to {String(f.subject).split(' ')[0]} or their manager. Please do not put your own name, or details that point to you, in your comment.</p>
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
  const goalCycles = useQuery({ queryKey: ['appraisal-goal-cycles'], queryFn: async () => (await api.get('/appraisal/goal-cycles')).data.data as any[] })
  const [sel, setSel] = useState<string | null>(null)
  const [adding, setAdding] = useState<string | null>(null)
  const [f, setF] = useState({ name: '', startDate: `${new Date().getFullYear()}-01-01`, endDate: `${new Date().getFullYear()}-12-31`, goalsWeight: 50, scaleMax: 5, goalCycleId: '' })
  const [chosen, setChosen] = useState<string[]>([])
  const refresh = () => qc.invalidateQueries({ queryKey: ['appraisal-cycles'] })
  const create = useMutation({ mutationFn: async () => (await api.post('/appraisal/cycles', { name: f.name, startDate: f.startDate, endDate: f.endDate, goalsWeight: f.goalsWeight, scaleMax: f.scaleMax, ...(f.goalCycleId && { goalCycleId: f.goalCycleId }), competencyIds: chosen.length ? chosen : (comps.data ?? []).filter((c) => c.active !== false).slice(0, 4).map((c) => c.id), peerReview: true })).data.data, onSuccess: () => { toast('Cycle created'); setF({ ...f, name: '' }); refresh() }, onError: (e) => toast(errMsg(e), 'error') })
  const launch = useMutation({ mutationFn: async (id: string) => (await api.post(`/appraisal/cycles/${id}/launch`, {})).data.data, onSuccess: (d) => { toast(`Launched for ${d.participants} people`); refresh() }, onError: (e) => { toast(errMsg(e), 'error'); refresh() } })
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
        <div className="field"><label htmlFor="cy-gc">Goal cycle this review counts</label>
          <select id="cy-gc" className="input" value={f.goalCycleId} onChange={(e) => setF({ ...f, goalCycleId: e.target.value })}>
            <option value="">The only open goal cycle (or goals reviewed during these dates)</option>
            {goalCycles.data?.map((g) => <option key={g.id} value={g.id}>{g.name}{g.status === 'closed' ? ' (closed)' : ''}</option>)}
          </select>
          <span className="dim" style={{ fontSize: 12 }}>Goal cycles are the quarters and years set up under Performance. Their reviewed goals make up the goals part of the score.</span></div>
        <p className="dim" style={{ margin: 0, fontSize: 13 }}>{scaleHelp(f.scaleMax)}</p>
        <div><span className="dim" style={{ fontSize: 13 }}>Competencies (none chosen = the first four)</span>
          <div className="chips" style={{ marginTop: 6 }}>{comps.data?.filter((c) => c.active !== false).map((c) => <button key={c.id} type="button" className={`chip ${chosen.includes(c.id) ? 'is-on' : ''}`} onClick={() => setChosen(chosen.includes(c.id) ? chosen.filter((x) => x !== c.id) : [...chosen, c.id])}>{c.name}</button>)}</div></div>
        <div><button className="btn btn-primary" disabled={create.isPending || f.name.trim().length < 2} onClick={() => create.mutate()}>Create cycle</button></div>
      </div>
      {cycles.data?.map((c) => (
        <div key={c.id} className="card" style={{ padding: 20, display: 'grid', gap: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}><span><strong>{c.name}</strong><span className="dim" style={{ display: 'block', fontSize: 13 }}>{String(c.startDate).slice(0, 10)} to {String(c.endDate).slice(0, 10)} · {c.participants} people{c.goalCycleName ? ` · counts goals of ${c.goalCycleName}` : ''}</span></span><span className="pill info">{CYCLE[c.status]}</span></div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {c.status === 'draft' && <button className="btn btn-primary btn-sm" disabled={launch.isPending} onClick={() => launch.mutate(c.id)}>{launch.isPending ? 'Launching…' : 'Launch for everyone'}</button>}
            {(NEXT[c.status] ?? []).map(([s, l]) => <button key={s} className="btn btn-ghost btn-sm" disabled={move.isPending} onClick={() => move.mutate({ id: c.id, status: s })}>{l}</button>)}
            {c.status === 'active' && <button className="btn btn-ghost btn-sm" onClick={() => setAdding(c.id)}>Add a late joiner</button>}
            {c.status !== 'draft' && <button className="btn btn-ghost btn-sm" onClick={() => setSel(sel === c.id ? null : c.id)}>{sel === c.id ? 'Hide results' : 'Results and people'}</button>}
          </div>
          {sel === c.id && <Summary id={c.id} onOpen={onOpen} />}
        </div>
      ))}
      {adding && <AddJoiner cycleId={adding} onClose={() => setAdding(null)} onAdded={() => { setAdding(null); refresh(); qc.invalidateQueries({ queryKey: ['appraisals'] }) }} />}
    </div>
  )
}

function AddJoiner({ cycleId, onClose, onAdded }: { cycleId: string; onClose: () => void; onAdded: () => void }) {
  const toast = useToast()
  const [term, setTerm] = useState('')
  const people = useQuery({ queryKey: ['appraisal-people', term], enabled: term.trim().length >= 2, queryFn: async () => (await api.get('/appraisal/people', { params: { q: term.trim() } })).data.data as any[] })
  const add = useMutation({ mutationFn: async (employeeId: string) => (await api.post(`/appraisal/cycles/${cycleId}/participants`, { employeeIds: [employeeId] })).data.data, onSuccess: () => { toast('Added to the cycle'); onAdded() }, onError: (e) => toast(errMsg(e), 'error') })
  return (
    <Modal open onClose={onClose} title="Add a late joiner" width={440}>
      <div style={{ display: 'grid', gap: 10 }}>
        <p className="dim" style={{ margin: 0, fontSize: 13 }}>Someone who joined after the cycle was launched. They get a self appraisal to fill in, like everyone else.</p>
        <input className="input" placeholder="Start typing a name" value={term} onChange={(e) => setTerm(e.target.value)} autoFocus aria-label="Find a person" />
        {people.data?.map((x) => <button key={x.id} type="button" className="btn btn-ghost btn-sm" style={{ justifyContent: 'flex-start' }} disabled={add.isPending} onClick={() => add.mutate(x.id)}>{x.name} <span className="dim">{x.code}</span></button>)}
      </div>
    </Modal>
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

type PlanAsk = { plan: any; kind: 'note' | 'extend' | 'met' | 'notmet' }
function Plans({ manager, hr }: { manager: boolean; hr: boolean }) {
  const toast = useToast()
  const qc = useQueryClient()
  const [scope, setScope] = useState<'mine' | 'team' | 'all'>('mine')
  const q = useQuery({ queryKey: ['plans', scope], queryFn: async () => (await api.get('/appraisal/plans', { params: { scope } })).data.data as any[] })
  const refresh = () => qc.invalidateQueries({ queryKey: ['plans'] })
  const [term, setTerm] = useState('')
  const [who, setWho] = useState<{ id: string; name: string } | null>(null)
  const [f, setF] = useState({ reason: '', endDate: '', objectives: '' })
  const [ask, setAsk] = useState<PlanAsk | null>(null)
  const [newEnd, setNewEnd] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
  const people = useQuery({ queryKey: ['appraisal-people', term], enabled: term.trim().length >= 2 && !who, queryFn: async () => (await api.get('/appraisal/people', { params: { q: term.trim() } })).data.data as any[] })
  const create = useMutation({ mutationFn: async () => (await api.post('/appraisal/plans', { employeeId: who!.id, reason: f.reason, endDate: f.endDate, objectives: f.objectives.split('\n').map((x) => x.trim()).filter(Boolean) })).data.data, onSuccess: () => { toast('Plan started'); setWho(null); setTerm(''); setF({ reason: '', endDate: '', objectives: '' }); refresh() }, onError: (e) => toast(errMsg(e), 'error') })
  const tick = useMutation({ mutationFn: async (v: { id: string; objectiveId: string; done: boolean }) => (await api.post(`/appraisal/plans/${v.id}/progress`, { objectiveId: v.objectiveId, done: v.done })).data.data, onSuccess: refresh, onError: (e) => toast(errMsg(e), 'error') })
  const act = useMutation({
    mutationFn: async (note: string) => {
      const p = ask!.plan
      if (ask!.kind === 'note') return (await api.post(`/appraisal/plans/${p.id}/progress`, { note })).data.data
      return (await api.post(`/appraisal/plans/${p.id}/close`, { note, outcome: ask!.kind === 'extend' ? 'extended' : ask!.kind === 'met' ? 'successful' : 'unsuccessful', ...(ask!.kind === 'extend' && { endDate: newEnd }) })).data.data
    },
    onSuccess: () => { toast({ note: 'Note added', extend: 'Plan extended', met: 'Plan closed: objectives met', notmet: 'Plan closed: objectives not met' }[ask!.kind]); setAsk(null); setNewEnd(''); refresh() },
    onError: (e) => toast(errMsg(e), 'error'),
  })
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
          <div className="field"><label htmlFor="pl-e">Ends on</label><input id="pl-e" type="date" className="input" min={tomorrow} value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></div>
          <div className="field"><label htmlFor="pl-o">Objectives, one per line</label><textarea id="pl-o" className="input" rows={3} style={{ height: 'auto', padding: 14, borderRadius: 20 }} value={f.objectives} onChange={(e) => setF({ ...f, objectives: e.target.value })} /></div>
          <div><button className="btn btn-primary" disabled={!who || create.isPending || f.reason.trim().length < 5 || !f.endDate || !f.objectives.trim()} onClick={() => create.mutate()}>Start plan</button></div>
        </div>
      )}
      {q.data?.length === 0 && <div className="card" style={{ padding: 20 }}>No improvement plans.</div>}
      {q.data?.map((p) => (
        <div key={p.id} className="card" style={{ padding: 20, display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}><span><strong>{p.employee}</strong><span className="dim" style={{ display: 'block', fontSize: 13 }}>{p.reason} · until {fmtDate(p.endDate)}</span></span><span className={`pill ${p.status === 'active' ? 'warn' : p.outcome === 'successful' ? 'ok' : 'mute'}`}>{p.status === 'active' ? 'Active' : p.outcome === 'successful' ? 'Objectives met' : 'Objectives not met'}</span></div>
          {p.objectives.map((o: any) => <label key={o.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={o.done} disabled={scope === 'mine' || p.status !== 'active'} onChange={(e) => tick.mutate({ id: p.id, objectiveId: o.id, done: e.target.checked })} /> {o.text}</label>)}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {p.status === 'active' && <button className="btn btn-ghost btn-sm" onClick={() => setAsk({ plan: p, kind: 'note' })}>Add a note</button>}
            {p.status === 'active' && scope !== 'mine' && <button className="btn btn-ghost btn-sm" onClick={() => setAsk({ plan: p, kind: 'extend' })}>Extend</button>}
            {p.status === 'active' && scope !== 'mine' && <button className="btn btn-primary btn-sm" onClick={() => setAsk({ plan: p, kind: 'met' })}>Close: objectives met</button>}
            {p.status === 'active' && scope !== 'mine' && <button className="btn btn-ghost btn-sm" onClick={() => setAsk({ plan: p, kind: 'notmet' })}>Close: not met</button>}
            {!!p.notes?.length && <button className="btn btn-ghost btn-sm" onClick={() => setOpen(open === p.id ? null : p.id)}>{open === p.id ? 'Hide history' : `History (${p.notes.length})`}</button>}
          </div>
          {open === p.id && <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>{[...p.notes].reverse().map((n: any, i: number) => <li key={i}>{fmtDate(n.at)} · {n.text}{n.by && n.by !== 'system' ? <span className="dim"> ({n.by === 'self' ? 'the person' : n.by === 'hr' ? 'HR' : 'manager'})</span> : null}</li>)}</ul>}
        </div>
      ))}
      {ask && (
        <ReasonModal
          title={{ note: 'Add a note to the plan', extend: 'Extend the plan', met: 'Close the plan: objectives met', notmet: 'Close the plan: objectives not met' }[ask.kind]}
          label={ask.kind === 'note' ? 'Your note' : ask.kind === 'extend' ? 'Why more time?' : 'What was the outcome?'} min={ask.kind === 'note' ? 2 : 3} busy={act.isPending}
          help={ask.kind === 'extend' ? <>Choose a new end date in the future. <input type="date" className="input" min={tomorrow} value={newEnd} onChange={(e) => setNewEnd(e.target.value)} style={{ marginTop: 6 }} aria-label="New end date" /></> : ask.kind === 'note' ? undefined : 'This closes the plan for good. The reason is kept in its history and the person is told.'}
          confirmLabel={{ note: 'Add note', extend: 'Extend plan', met: 'Close the plan', notmet: 'Close the plan' }[ask.kind]}
          onClose={() => { setAsk(null); setNewEnd('') }} onSubmit={(t) => { if (ask.kind === 'extend' && !newEnd) { toast('Choose the new end date', 'error'); return } act.mutate(t) }} />
      )}
    </div>
  )
}
