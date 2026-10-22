import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import { useAuth } from '../../contexts/AuthContext'
import PageHeader from '../../components/ui/PageHeader'
import Modal from '../../components/ui/Modal'
import { useToast } from '../../components/ui/Toast'
import { useReveal } from '../../lib/motion'

// Pay review: Payroll opens a cycle with a budget; managers recommend increases for their direct reports seeing team
// totals only; Payroll approves and applies them as salary revisions. Managers also see their team cost as totals.
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
const money = (v: number | null | undefined, cur?: string | null) => (v == null ? '—' : `${cur ?? ''} ${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`.trim())
const ST: Record<string, string> = { open: 'ok', closed: 'mute', applied: 'info', recommended: 'warn', approved: 'ok', rejected: 'danger' }
interface Cycle { id: string; name: string; effectiveFrom: string; budgetPercent: number; status: string; recommendations: number }

export default function PayReviewPage() {
  const { hasRole } = useAuth()
  const payroll = hasRole('payroll_admin'), manager = hasRole('manager')
  const [tab, setTab] = useState<'reviews' | 'cost'>('reviews')
  const [cycleId, setCycleId] = useState('')
  const [creating, setCreating] = useState(false)
  const root = useReveal<HTMLDivElement>(tab)
  const { data: cycles = [] } = useQuery({ queryKey: ['comp-cycles'], queryFn: async () => (await api.get('/comp-reviews')).data.data as Cycle[] })
  useEffect(() => { if (!cycleId && cycles[0]) setCycleId(cycles[0].id) }, [cycles, cycleId])
  return (
    <div ref={root}>
      <PageHeader title="Pay review" sub={payroll ? 'Open a review, see recommendations and apply them' : 'Recommend increases for your team within the budget'}
        actions={payroll ? <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>Open a review</button> : undefined}>
        {manager && (
          <div role="tablist" style={{ display: 'flex', gap: 6, marginTop: 14 }}>
            {([['reviews', 'Reviews'], ['cost', 'Team cost']] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`btn btn-sm ${tab === k ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab(k)}>{l}</button>)}
          </div>
        )}
      </PageHeader>
      {tab === 'cost' ? <TeamCost /> : (
        <div style={{ display: 'grid', gap: 'var(--gap)' }}>
          <section data-card className="card" style={{ padding: 14 }}>
            {!cycles.length ? <p className="dim">No pay reviews yet.{payroll ? ' Open one to start.' : ' Payroll opens them.'}</p> : (
              <div className="chips">{cycles.map((c) => <button key={c.id} className={`chip${cycleId === c.id ? ' is-on' : ''}`} onClick={() => setCycleId(c.id)}>{c.name} <span className={`pill ${ST[c.status]}`}>{c.status}</span></button>)}</div>
            )}
          </section>
          {cycleId && payroll && <PayrollReview cycleId={cycleId} />}
          {cycleId && manager && <ManagerReview cycleId={cycleId} />}
        </div>
      )}
      {creating && <NewCycle onClose={() => setCreating(false)} />}
    </div>
  )
}

function NewCycle({ onClose }: { onClose: () => void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const next = new Date(); next.setUTCMonth(next.getUTCMonth() + 1, 1)
  const [f, setF] = useState({ name: `Pay review ${next.getUTCFullYear()}`, effectiveFrom: next.toISOString().slice(0, 10), budgetPercent: '5' })
  const save = useMutation({
    mutationFn: () => api.post('/comp-reviews', { name: f.name.trim(), effectiveFrom: f.effectiveFrom, budgetPercent: Number(f.budgetPercent) }),
    onSuccess: () => { toast('Review opened; managers are notified'); qc.invalidateQueries({ queryKey: ['comp-cycles'] }); onClose() },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  return (
    <Modal open onClose={onClose} title="Open a pay review">
      <div style={{ display: 'grid', gap: 12 }}>
        <label className="field"><span>Name</span><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={80} /></label>
        <label className="field"><span>New pay from (1st of a month)</span><input className="input" type="date" value={f.effectiveFrom} onChange={(e) => setF({ ...f, effectiveFrom: e.target.value })} /></label>
        <label className="field"><span>Budget (% of each team's annual CTC)</span><input className="input" type="number" min={0} max={50} step={0.5} value={f.budgetPercent} onChange={(e) => setF({ ...f, budgetPercent: e.target.value })} /></label>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button className="btn btn-primary" disabled={save.isPending || !f.name.trim() || !f.effectiveFrom.endsWith('-01')} onClick={() => save.mutate()}>Open review</button></div>
      </div>
    </Modal>
  )
}

function ManagerReview({ cycleId }: { cycleId: string }) {
  const toast = useToast()
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery({ queryKey: ['comp-my-team', cycleId], retry: false, queryFn: async () => (await api.get(`/comp-reviews/${cycleId}/my-team`)).data.data })
  const [pct, setPct] = useState<Record<string, string>>({})
  useEffect(() => { if (data) setPct(Object.fromEntries(data.people.map((p: any) => [p.employeeId, p.increasePercent == null ? '' : String(p.increasePercent)]))) }, [data])
  const save = useMutation({
    mutationFn: () => api.post(`/comp-reviews/${cycleId}/recommend`, { items: Object.entries(pct).filter(([, v]) => v !== '').map(([employeeId, v]) => ({ employeeId, increasePercent: Number(v) })) }),
    onSuccess: () => { toast('Recommendations saved'); qc.invalidateQueries({ queryKey: ['comp-my-team', cycleId] }) },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  if (isLoading) return <div className="skeleton" style={{ height: 160, borderRadius: 22 }} />
  if (error || !data) return null
  const t = data.totals
  const open = data.cycle.status === 'open'
  return (
    <section data-card className="card" style={{ padding: 20, display: 'grid', gap: 12 }}>
      <h3 style={{ fontSize: 16 }}>My team · {data.cycle.budgetPercent}% budget · new pay from {data.cycle.effectiveFrom}</h3>
      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 14 }}>
        <span>{t.headcount} people</span>
        {t.hiddenBecauseSmallTeam ? <span className="dim">Amounts are hidden for teams under 3 people, so no one's pay can be worked out.</span> : <>
          <span>Team annual CTC <strong>{money(t.totalAnnualCtc, t.currency)}</strong></span>
          <span>Budget <strong>{money(t.budget, t.currency)}</strong></span>
          <span>Used <strong>{money(t.used, t.currency)}</strong></span>
        </>}
        <span className={`pill ${t.overBudget ? 'danger' : 'ok'}`}>{t.usedOfBudgetPercent}% of budget{t.overBudget ? ' · over budget' : ''}</span>
      </div>
      <table className="tbl" style={{ width: '100%' }}>
        <thead><tr><th>Person</th><th style={{ width: 160 }}>Increase %</th><th>Status</th></tr></thead>
        <tbody>{data.people.map((p: any) => (
          <tr key={p.employeeId}><td>{p.name} <span className="dim">{p.employeeCode}</span>{!p.eligible && <span className="dim"> · no contract</span>}</td>
            <td><input className="input" type="number" min={0} max={100} step={0.5} disabled={!open || !p.eligible || (p.status && p.status !== 'recommended')} value={pct[p.employeeId] ?? ''} onChange={(e) => setPct({ ...pct, [p.employeeId]: e.target.value })} aria-label={`Increase for ${p.name}`} /></td>
            <td>{p.status ? <span className={`pill ${ST[p.status]}`}>{p.status}</span> : <span className="dim">—</span>}</td></tr>
        ))}</tbody>
      </table>
      {open && <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>Save recommendations</button></div>}
    </section>
  )
}

function PayrollReview({ cycleId }: { cycleId: string }) {
  const toast = useToast()
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: ['comp-review', cycleId], queryFn: async () => (await api.get(`/comp-reviews/${cycleId}/review`)).data.data })
  const refresh = () => { qc.invalidateQueries({ queryKey: ['comp-review', cycleId] }); qc.invalidateQueries({ queryKey: ['comp-cycles'] }) }
  const decide = useMutation({ mutationFn: (v: { id: string; approve: boolean }) => api.post(`/comp-reviews/recommendations/${v.id}/decide`, { approve: v.approve }), onSuccess: refresh, onError: (e) => toast(errMsg(e), 'error') })
  const apply = useMutation({ mutationFn: async () => (await api.post(`/comp-reviews/${cycleId}/apply`)).data.data, onSuccess: (d) => { toast(`${d.revisions} salary revisions raised; a second Payroll admin approves them under Salary structures › Revisions`); refresh() }, onError: (e) => toast(errMsg(e), 'error') })
  if (isLoading || !data) return <div className="skeleton" style={{ height: 160, borderRadius: 22 }} />
  return (
    <section data-card className="card" style={{ padding: 20, display: 'grid', gap: 12, overflowX: 'auto' }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>{data.budgets.map((b: any) => <span key={b.managerEmployeeId} className={`pill ${b.used > b.budget ? 'danger' : 'mute'}`}>{b.manager}: {b.used.toLocaleString()} of {b.budget.toLocaleString()}</span>)}</div>
      {!data.recommendations.length ? <p className="dim">No recommendations yet.</p> : (
        <table className="tbl" style={{ width: '100%', minWidth: 720 }}>
          <thead><tr><th>Person</th><th>Manager</th><th className="num">Increase</th><th className="num">Current CTC</th><th className="num">Proposed</th><th>Status</th><th /></tr></thead>
          <tbody>{data.recommendations.map((r: any) => (
            <tr key={r.id}><td>{r.employee}</td><td>{r.manager}</td><td className="num">{r.increasePercent}%</td><td className="num">{money(r.currentCtc, r.currency)}</td><td className="num">{money(r.proposedCtc, r.currency)}</td>
              <td><span className={`pill ${ST[r.status]}`}>{r.status}</span></td>
              <td style={{ whiteSpace: 'nowrap' }}>{r.status !== 'applied' && data.cycle.status !== 'applied' && <>
                <button className="btn btn-ghost btn-sm" disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, approve: true })}>Approve</button>
                <button className="btn btn-ghost btn-sm" disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, approve: false })}>Reject</button>
              </>}</td></tr>
          ))}</tbody>
        </table>
      )}
      {data.cycle.status !== 'applied' && <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button className="btn btn-primary" disabled={apply.isPending || !data.recommendations.some((r: any) => r.status === 'approved')} onClick={() => apply.mutate()}>Apply approved ones</button></div>}
    </section>
  )
}

function TeamCost() {
  const { data, isLoading } = useQuery({ queryKey: ['team-cost'], queryFn: async () => (await api.get('/comp-reviews/team-cost')).data.data })
  if (isLoading || !data) return <div className="skeleton" style={{ height: 140, borderRadius: 22 }} />
  return (
    <section data-card className="card" style={{ padding: 22, display: 'grid', gap: 12 }}>
      <p className="dim" style={{ fontSize: 13 }}>Everyone below you in the reporting line, as totals. You never see one person's pay.</p>
      {data.hiddenBecauseSmallTeam ? <p>Your team has fewer than {data.minGroup} people with a contract, so the totals are hidden.</p> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
          {[['People', String(data.headcount)], ['Annual CTC', money(data.annualCtc, data.currency)], ['Monthly wages', money(data.monthlyWages, data.currency)], ...(data.lastPayroll ? [[`Gross paid ${data.lastPayroll.month}`, money(data.lastPayroll.gross, data.currency)]] : [])].map(([l, v]) => (
            <div key={l} className="well" style={{ padding: 14, borderRadius: 14 }}><div className="dim" style={{ fontSize: 12 }}>{l}</div><div className="num" style={{ fontSize: 22, fontFamily: 'var(--font-display)' }}>{v}</div></div>
          ))}
        </div>
      )}
    </section>
  )
}
