import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import { useAuth } from '../../contexts/AuthContext'
import PageHeader from '../../components/ui/PageHeader'
import Modal from '../../components/ui/Modal'
import { useToast } from '../../components/ui/Toast'
import { useReveal } from '../../lib/motion'

// Goals & appraisal: a manager sets a goal with up to 5 weighted KPIs, the person accepts it or sends it back,
// the manager records what was achieved, and the weighted result is the % of the expectation met.
const STATUS: Record<string, [string, string]> = {
  draft: ['mute', 'Draft'], sent: ['warn', 'Waiting for acceptance'], returned: ['danger', 'Sent back'], accepted: ['info', 'Agreed'],
  reviewed: ['honey', 'Reviewed'], acknowledged: ['ok', 'Review acknowledged'],
}
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
const num = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 })
const Pill = ({ k }: { k: string }) => <span className={`pill ${STATUS[k]?.[0] ?? 'mute'}`}>{STATUS[k]?.[1] ?? k}</span>

type Tab = 'mine' | 'team' | 'all' | 'cycles'
interface Kpi { id?: string; name: string; target: number; unit?: string | null; weight: number; achieved?: number | null }
interface Goal { id: string; employeeId: string; employee: string | null; setBy: string | null; title: string; description: string | null; status: string; returnNote: string | null; score: number | null; rating: string | null; managerComment: string | null; employeeComment: string | null; cycle: { id: string; name: string; status: string }; kpis: Kpi[] }

export default function PerformancePage() {
  const { user, hasRole } = useAuth()
  const isHR = hasRole('hr_admin')
  const lead = isHR || hasRole('manager')
  const [tab, setTab] = useState<Tab>(user?.employee?.id ? 'mine' : lead ? 'team' : 'cycles')
  const root = useReveal<HTMLDivElement>(tab)
  const tabs: [Tab, string][] = [
    ...(user?.employee?.id ? [['mine', 'My goals'] as [Tab, string]] : []),
    ...(lead ? [['team', 'My team'] as [Tab, string]] : []),
    ...(isHR ? [['all', 'Everyone'] as [Tab, string], ['cycles', 'Review cycles'] as [Tab, string]] : []),
  ]
  return (
    <div ref={root}>
      <PageHeader title={lead ? 'Performance' : 'My goals'} sub="Goals with weighted KPIs, agreed by both sides, reviewed each quarter or year.">
        {tabs.length > 1 && (
          <div role="tablist" style={{ display: 'flex', gap: 6, marginTop: 14, flexWrap: 'wrap' }}>
            {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`btn btn-sm ${tab === k ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab(k)}>{l}</button>)}
          </div>
        )}
      </PageHeader>
      {tab === 'cycles' ? <Cycles /> : <Goals scope={tab} />}
    </div>
  )
}

function useCycles() {
  return useQuery({ queryKey: ['perf-cycles'], queryFn: async () => (await api.get('/performance/cycles')).data.data as { id: string; name: string; period: string; startDate: string; endDate: string; status: string; goals: number }[] })
}

function Goals({ scope }: { scope: 'mine' | 'team' | 'all' }) {
  const { data: cycles = [] } = useCycles()
  const [cycleId, setCycleId] = useState('')
  const [editing, setEditing] = useState<Goal | 'new' | null>(null)
  const { data = [], isLoading } = useQuery({ queryKey: ['perf-goals', scope, cycleId], queryFn: async () => (await api.get('/performance/goals', { params: { scope, ...(cycleId && { cycleId }) } })).data.data as Goal[] })
  const manager = scope !== 'mine'
  return (
    <div style={{ display: 'grid', gap: 'var(--gap)' }}>
      <section data-card className="card" style={{ padding: 14, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <select className="input" style={{ width: 220 }} value={cycleId} onChange={(e) => setCycleId(e.target.value)} aria-label="Review cycle">
          <option value="">All review cycles</option>{cycles.map((c) => <option key={c.id} value={c.id}>{c.name}{c.status === 'closed' ? ' (closed)' : ''}</option>)}
        </select>
        <span style={{ flex: 1 }} />
        {manager && <button className="btn btn-primary btn-sm" disabled={!cycles.some((c) => c.status === 'open')} onClick={() => setEditing('new')}>Set a goal</button>}
      </section>
      {manager && !cycles.length && <section data-card className="card" style={{ padding: 18 }}><p className="dim">No review cycles yet. HR creates them under “Review cycles” (one click adds this year’s quarters and the full year).</p></section>}
      {isLoading ? <div className="skeleton" style={{ height: 140, borderRadius: 22 }} /> : !data.length ? (
        <section data-card className="card" style={{ padding: 24 }}><p className="dim">{scope === 'mine' ? 'No goals yet. Your manager sets them and you’ll get a notification to accept them.' : 'No goals here yet. Use “Set a goal” to give someone in your team a target.'}</p></section>
      ) : data.map((g) => <GoalCard key={g.id} g={g} manager={manager} onEdit={() => setEditing(g)} />)}
      {editing && <GoalForm goal={editing === 'new' ? null : editing} cycles={cycles.filter((c) => c.status === 'open')} onClose={() => setEditing(null)} />}
    </div>
  )
}

function GoalCard({ g, manager, onEdit }: { g: Goal; manager: boolean; onEdit: () => void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const [note, setNote] = useState('')
  const [returning, setReturning] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: object }) => api.post(`/performance/goals/${g.id}/${path}`, body ?? {}),
    onSuccess: (_d, v) => { toast({ send: 'Sent for acceptance', accept: 'Goal accepted', return: 'Sent back to your manager', acknowledge: 'Review acknowledged' }[v.path] ?? 'Saved'); setReturning(false); qc.invalidateQueries({ queryKey: ['perf-goals'] }) },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  const reviewed = g.score != null
  return (
    <section data-card className="card" style={{ padding: 20, display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 280px', minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}><Pill k={g.status} /><span className="pill mute">{g.cycle.name}</span></div>
          <h2 style={{ fontSize: 19, marginTop: 8 }}>{g.title}</h2>
          <p className="dim" style={{ fontSize: 13 }}>{manager ? `For ${g.employee}` : `Set by ${g.setBy ?? 'HR'}`}</p>
          {g.description && <p style={{ marginTop: 6, whiteSpace: 'pre-wrap', fontSize: 14 }}>{g.description}</p>}
        </div>
        {reviewed && (
          <div style={{ textAlign: 'right' }}>
            <div className="num" style={{ fontSize: 30, fontFamily: 'var(--font-display)' }}>{num(g.score!)}%</div>
            <div className="dim" style={{ fontSize: 12 }}>of the expectation met</div>
            <span className={`pill ${g.score! >= 90 ? 'ok' : g.score! >= 70 ? 'warn' : 'danger'}`} style={{ marginTop: 4 }}>{g.rating}</span>
          </div>
        )}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="tbl" style={{ width: '100%', minWidth: 520 }}>
          <thead><tr><th>KPI</th><th className="num">Target</th><th className="num">Weight</th><th className="num">Achieved</th><th className="num">Met</th></tr></thead>
          <tbody>{g.kpis.map((k) => (
            <tr key={k.id}><td>{k.name}</td><td className="num">{num(k.target)} {k.unit}</td><td className="num">{num(k.weight)}%</td>
              <td className="num">{k.achieved == null ? <span className="dim">—</span> : `${num(k.achieved)} ${k.unit ?? ''}`}</td>
              <td className="num">{k.achieved == null ? <span className="dim">—</span> : `${num((k.achieved / k.target) * 100)}%`}</td></tr>
          ))}</tbody>
        </table>
      </div>
      {g.returnNote && g.status === 'returned' && <div className="well" style={{ padding: 12, fontSize: 14 }}><strong>Sent back:</strong> {g.returnNote}</div>}
      {g.managerComment && <div className="well" style={{ padding: 12, fontSize: 14 }}><strong>Manager’s review:</strong> {g.managerComment}</div>}
      {g.employeeComment && <div className="well" style={{ padding: 12, fontSize: 14 }}><strong>{manager ? 'Their' : 'Your'} comment:</strong> {g.employeeComment}</div>}
      {returning && (
        <div style={{ display: 'grid', gap: 8 }}>
          <textarea className="input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder={g.status === 'reviewed' ? 'Optional comment on your review…' : 'What should change? (e.g. the target is too high for this quarter)'} style={{ height: 'auto', padding: 12 }} maxLength={1000} />
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {manager && ['draft', 'returned'].includes(g.status) && <><button className="btn btn-ghost btn-sm" onClick={onEdit}>Edit</button><button className="btn btn-primary btn-sm" disabled={act.isPending} onClick={() => act.mutate({ path: 'send' })}>Send to {g.employee?.split(' ')[0]}</button></>}
        {manager && ['accepted', 'reviewed'].includes(g.status) && <button className="btn btn-primary btn-sm" onClick={() => setReviewing(true)}>{reviewed ? 'Change review' : 'Record achievement'}</button>}
        {!manager && g.status === 'sent' && (returning
          ? <><button className="btn btn-primary btn-sm" disabled={act.isPending || note.trim().length < 3} onClick={() => act.mutate({ path: 'return', body: { note: note.trim() } })}>Send back</button><button className="btn btn-ghost btn-sm" onClick={() => setReturning(false)}>Cancel</button></>
          : <><button className="btn btn-primary btn-sm" disabled={act.isPending} onClick={() => act.mutate({ path: 'accept' })}>Accept goal</button><button className="btn btn-ghost btn-sm" onClick={() => setReturning(true)}>Send back</button></>)}
        {!manager && g.status === 'reviewed' && (returning
          ? <button className="btn btn-primary btn-sm" disabled={act.isPending} onClick={() => act.mutate({ path: 'acknowledge', body: note.trim() ? { comment: note.trim() } : {} })}>Acknowledge</button>
          : <><button className="btn btn-primary btn-sm" disabled={act.isPending} onClick={() => act.mutate({ path: 'acknowledge' })}>Acknowledge review</button><button className="btn btn-ghost btn-sm" onClick={() => setReturning(true)}>Add a comment</button></>)}
      </div>
      {reviewing && <ReviewForm g={g} onClose={() => setReviewing(false)} />}
    </section>
  )
}

const blankKpi = (): Kpi => ({ name: '', target: 0, unit: '', weight: 0 })

function GoalForm({ goal, cycles, onClose }: { goal: Goal | null; cycles: { id: string; name: string }[]; onClose: () => void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const { data: people = [] } = useQuery({ queryKey: ['perf-people'], enabled: !goal, queryFn: async () => (await api.get('/employees', { params: { limit: 500 } })).data.data as any[] })
  const { user } = useAuth()
  const [f, setF] = useState({ cycleId: goal?.cycle.id ?? cycles[0]?.id ?? '', employeeId: goal?.employeeId ?? '', title: goal?.title ?? '', description: goal?.description ?? '' })
  const [kpis, setKpis] = useState<Kpi[]>(goal?.kpis.map((k) => ({ name: k.name, target: k.target, unit: k.unit ?? '', weight: k.weight })) ?? [{ name: '', target: 0, unit: '', weight: 100 }])
  const total = kpis.reduce((s, k) => s + (Number(k.weight) || 0), 0)
  const valid = f.title.trim().length >= 3 && (goal || (f.cycleId && f.employeeId)) && kpis.every((k) => k.name.trim().length >= 2 && k.target > 0 && k.weight > 0) && Math.abs(total - 100) < 0.01
  const save = useMutation({
    mutationFn: async (send: boolean) => {
      const body: Record<string, unknown> = { title: f.title.trim(), ...(f.description.trim() && { description: f.description.trim() }), kpis: kpis.map((k) => ({ name: k.name.trim(), target: Number(k.target), weight: Number(k.weight), ...(k.unit?.trim() && { unit: k.unit.trim() }) })), send }
      if (goal) await api.put(`/performance/goals/${goal.id}`, body)
      else await api.post('/performance/goals', { ...body, cycleId: f.cycleId, employeeId: f.employeeId })
    },
    onSuccess: (_d, send) => { toast(send ? 'Goal sent for acceptance' : 'Draft saved'); qc.invalidateQueries({ queryKey: ['perf-goals'] }); onClose() },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  const set = (i: number, patch: Partial<Kpi>) => setKpis(kpis.map((k, j) => (j === i ? { ...k, ...patch } : k)))
  return (
    <Modal open onClose={onClose} title={goal ? 'Edit goal' : 'Set a goal'} width={720}>
      <div style={{ display: 'grid', gap: 12 }}>
        {!goal && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
            <label className="field"><span>For</span><select className="input" value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value })}><option value="">Choose a person…</option>{people.filter((p) => p.id !== user?.employee?.id).map((p) => <option key={p.id} value={p.id}>{p.firstName} {p.lastName} ({p.employeeCode})</option>)}</select></label>
            <label className="field"><span>Review cycle</span><select className="input" value={f.cycleId} onChange={(e) => setF({ ...f, cycleId: e.target.value })}>{cycles.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          </div>
        )}
        <label className="field"><span>Goal</span><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. Grow regional revenue" maxLength={160} /></label>
        <label className="field"><span>Details (optional)</span><textarea className="input" rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} style={{ height: 'auto', padding: 10 }} maxLength={2000} /></label>
        <div style={{ display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><strong style={{ fontSize: 14 }}>KPIs (up to 5)</strong><span className={`pill ${Math.abs(total - 100) < 0.01 ? 'ok' : 'warn'}`}>Weights {num(total)}% of 100%</span></div>
          {kpis.map((k, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(160px, 2fr) minmax(90px, 1fr) minmax(70px, .8fr) minmax(70px, .7fr) auto', gap: 6, alignItems: 'center' }}>
              <input className="input" aria-label="KPI" placeholder="KPI, e.g. Revenue" value={k.name} onChange={(e) => set(i, { name: e.target.value })} maxLength={120} />
              <input className="input" aria-label="Target" type="number" min={0} placeholder="Target" value={k.target || ''} onChange={(e) => set(i, { target: Number(e.target.value) })} />
              <input className="input" aria-label="Unit" placeholder="Unit" value={k.unit ?? ''} onChange={(e) => set(i, { unit: e.target.value })} maxLength={30} />
              <input className="input" aria-label="Weight %" type="number" min={0} max={100} placeholder="Weight %" value={k.weight || ''} onChange={(e) => set(i, { weight: Number(e.target.value) })} />
              <button className="btn btn-ghost btn-sm" disabled={kpis.length === 1} onClick={() => setKpis(kpis.filter((_, j) => j !== i))} aria-label="Remove KPI">✕</button>
            </div>
          ))}
          {kpis.length < 5 && <div><button className="btn btn-ghost btn-sm" onClick={() => setKpis([...kpis, blankKpi()])}>+ Add KPI</button></div>}
          <p className="dim" style={{ fontSize: 12 }}>Example: Revenue, target 10,000,000, unit ZMW, weight 60%. At review each KPI counts as achieved ÷ target (capped at 150%), weighted.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" disabled={!valid || save.isPending} onClick={() => save.mutate(false)}>Save draft</button>
          <button className="btn btn-primary" disabled={!valid || save.isPending} onClick={() => save.mutate(true)}>Save and send</button>
        </div>
      </div>
    </Modal>
  )
}

function ReviewForm({ g, onClose }: { g: Goal; onClose: () => void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const [achieved, setAchieved] = useState<Record<string, string>>(Object.fromEntries(g.kpis.map((k) => [k.id!, k.achieved == null ? '' : String(k.achieved)])))
  const [comment, setComment] = useState(g.managerComment ?? '')
  const filled = g.kpis.every((k) => achieved[k.id!] !== '' && Number(achieved[k.id!]) >= 0)
  const preview = filled ? g.kpis.reduce((s, k) => s + (k.weight / 100) * Math.min(1.5, Number(achieved[k.id!]) / k.target) * 100, 0) : null
  const save = useMutation({
    mutationFn: () => api.post(`/performance/goals/${g.id}/review`, { achieved: Object.fromEntries(Object.entries(achieved).map(([k, v]) => [k, Number(v)])), ...(comment.trim() && { comment: comment.trim() }) }),
    onSuccess: (r) => { toast(`Review saved: ${r.data.data.score}% · ${r.data.data.rating}`); qc.invalidateQueries({ queryKey: ['perf-goals'] }); onClose() },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  return (
    <Modal open onClose={onClose} title={`Review: ${g.title}`} width={600}>
      <div style={{ display: 'grid', gap: 12 }}>
        {g.kpis.map((k) => (
          <label key={k.id} className="field"><span>{k.name}: target {num(k.target)} {k.unit} · weight {num(k.weight)}%</span>
            <input className="input" type="number" min={0} value={achieved[k.id!]} onChange={(e) => setAchieved({ ...achieved, [k.id!]: e.target.value })} placeholder="Achieved" />
          </label>
        ))}
        <label className="field"><span>Comment for {g.employee?.split(' ')[0]}</span><textarea className="input" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} style={{ height: 'auto', padding: 10 }} maxLength={2000} /></label>
        {preview != null && <p style={{ fontSize: 14 }}>Result: <strong>{num(Math.round(preview * 10) / 10)}%</strong> of the expectation met</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button className="btn btn-primary" disabled={!filled || save.isPending} onClick={() => save.mutate()}>Save review</button></div>
      </div>
    </Modal>
  )
}

function Cycles() {
  const toast = useToast()
  const qc = useQueryClient()
  const { data = [], isLoading } = useCycles()
  const [f, setF] = useState({ name: '', period: 'quarterly', startDate: '', endDate: '' })
  const done = (msg: string) => { toast(msg); qc.invalidateQueries({ queryKey: ['perf-cycles'] }) }
  const year = useMutation({ mutationFn: async () => (await api.post('/performance/cycles/this-year')).data.data, onSuccess: (d) => done(d.created ? `${d.created} cycles added` : 'This year’s cycles already exist'), onError: (e) => toast(errMsg(e), 'error') })
  const add = useMutation({ mutationFn: () => api.post('/performance/cycles', f), onSuccess: () => { setF({ name: '', period: 'quarterly', startDate: '', endDate: '' }); done('Cycle added') }, onError: (e) => toast(errMsg(e), 'error') })
  const status = useMutation({ mutationFn: (v: { id: string; status: string }) => api.post(`/performance/cycles/${v.id}/status`, { status: v.status }), onSuccess: () => done('Cycle updated'), onError: (e) => toast(errMsg(e), 'error') })
  return (
    <div style={{ display: 'grid', gap: 'var(--gap)' }}>
      <section data-card className="card" style={{ padding: 18, display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <button className="btn btn-honey btn-sm" disabled={year.isPending} onClick={() => year.mutate()}>Add this year’s quarters + full year</button>
        <span className="dim" style={{ fontSize: 13, flex: '1 1 100%' }}>Or add a custom cycle:</span>
        <label className="field" style={{ flex: '1 1 160px' }}><span>Name</span><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="H1 2027" maxLength={60} /></label>
        <label className="field"><span>Type</span><select className="input" value={f.period} onChange={(e) => setF({ ...f, period: e.target.value })}><option value="quarterly">Quarterly</option><option value="yearly">Yearly</option></select></label>
        <label className="field"><span>Starts</span><input className="input" type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></label>
        <label className="field"><span>Ends</span><input className="input" type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></label>
        <button className="btn btn-primary btn-sm" disabled={add.isPending || f.name.trim().length < 2 || !f.startDate || !f.endDate} onClick={() => add.mutate()}>Add</button>
      </section>
      <section data-card className="card" style={{ padding: 8, overflowX: 'auto' }}>
        {isLoading ? <div className="skeleton" style={{ height: 100, borderRadius: 14 }} /> : !data.length ? <p className="dim" style={{ padding: 16 }}>No review cycles yet.</p> : (
          <table className="tbl" style={{ width: '100%', minWidth: 560 }}>
            <thead><tr><th>Cycle</th><th>Type</th><th>Dates</th><th className="num">Goals</th><th>Status</th><th /></tr></thead>
            <tbody>{data.map((c) => (
              <tr key={c.id}><td style={{ fontWeight: 500 }}>{c.name}</td><td>{c.period === 'yearly' ? 'Yearly' : 'Quarterly'}</td><td className="num">{c.startDate} → {c.endDate}</td><td className="num">{c.goals}</td>
                <td><span className={`pill ${c.status === 'open' ? 'ok' : 'mute'}`}>{c.status === 'open' ? 'Open' : 'Closed'}</span></td>
                <td><button className="btn btn-ghost btn-sm" onClick={() => status.mutate({ id: c.id, status: c.status === 'open' ? 'closed' : 'open' })}>{c.status === 'open' ? 'Close' : 'Reopen'}</button></td></tr>
            ))}</tbody>
          </table>
        )}
      </section>
    </div>
  )
}
