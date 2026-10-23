import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import { useAuth } from '../../contexts/AuthContext'
import { useToast } from '../../components/ui/Toast'
import { fmtDate } from '../../lib/format'

// Incentive schemes (HR), manager budgets, rating-based variable pay (Payroll) and kudos points (everyone)
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
const n = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 2 })
const TEMPLATES: Record<string, { formula: string; variables: { key: string; label: string }[]; hint: string }> = {
  commission: { formula: 'max(0, sales - target) * 0.05', variables: [{ key: 'sales', label: 'Sales' }, { key: 'target', label: 'Target' }], hint: '5% of sales above target' },
  kpi: { formula: 'score >= 100 ? 10000 : score >= 80 ? 5000 : 0', variables: [{ key: 'score', label: 'KPI score %' }], hint: '10,000 at 100% or more, 5,000 from 80%' },
  milestone: { formula: 'milestones * 2500', variables: [{ key: 'milestones', label: 'Milestones reached' }], hint: '2,500 per milestone reached' },
  other: { formula: 'units * 50', variables: [{ key: 'units', label: 'Units' }], hint: 'Any formula: + - * / max() min() round() and a ? b : c' },
}
const usePeople = () => useQuery({ queryKey: ['incentive-people'], queryFn: async () => (await api.get('/employees', { params: { limit: 500 } })).data.data as any[] })

export function SchemesPanel() {
  const toast = useToast()
  const qc = useQueryClient()
  const { data: schemes = [] } = useQuery({ queryKey: ['incentive-schemes'], queryFn: async () => (await api.get('/incentives/schemes')).data.data as any[] })
  const { data: types = [] } = useQuery({ queryKey: ['incentive-types'], queryFn: async () => (await api.get('/incentives/types')).data.data as any[] })
  const [kind, setKind] = useState('commission')
  const [f, setF] = useState({ name: '', formula: TEMPLATES.commission.formula, typeId: '', variables: TEMPLATES.commission.variables })
  const [running, setRunning] = useState<any>(null)
  const pick = (k: string) => { setKind(k); setF({ ...f, formula: TEMPLATES[k].formula, variables: TEMPLATES[k].variables }) }
  const save = useMutation({
    mutationFn: () => api.post('/incentives/schemes', { name: f.name.trim(), kind, formula: f.formula.trim(), variables: f.variables, typeId: f.typeId || types.find((t) => t.code === 'PERFORMANCE')?.id || types[0]?.id }),
    onSuccess: () => { toast('Scheme saved'); setF({ ...f, name: '' }); qc.invalidateQueries({ queryKey: ['incentive-schemes'] }) },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <section data-card className="card" style={{ padding: 20, display: 'grid', gap: 10 }}>
        <h3 style={{ fontSize: 16 }}>Build a scheme</h3>
        <p className="dim" style={{ fontSize: 13 }}>A formula over values you enter per person when you run it (sales, a KPI score, milestones). Running it creates nominations that HR approves, and each person sees how their amount was worked out.</p>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{Object.keys(TEMPLATES).map((k) => <button key={k} className={`btn btn-sm ${kind === k ? 'btn-primary' : 'btn-ghost'}`} onClick={() => pick(k)}>{k === 'kpi' ? 'KPI bonus' : k[0].toUpperCase() + k.slice(1)}</button>)}</div>
        <span className="dim" style={{ fontSize: 12 }}>Example: {TEMPLATES[kind].hint}</span>
        <label className="field"><span>Name</span><input className="input" value={f.name} maxLength={80} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Q4 sales commission" /></label>
        <label className="field"><span>Values entered per person (name = label, one per line)</span>
          <textarea className="input" style={{ minHeight: 70, fontFamily: 'ui-monospace, monospace', fontSize: 12 }} value={f.variables.map((v) => `${v.key} = ${v.label}`).join('\n')}
            onChange={(e) => setF({ ...f, variables: e.target.value.split('\n').map((l) => l.split('=')).filter((p) => p[0]?.trim()).map(([k, ...l]) => ({ key: k.trim(), label: l.join('=').trim() || k.trim() })) })} /></label>
        <label className="field"><span>Formula</span><input className="input" style={{ fontFamily: 'ui-monospace, monospace' }} value={f.formula} onChange={(e) => setF({ ...f, formula: e.target.value })} /></label>
        <label className="field"><span>Pay it as</span><select className="input" value={f.typeId} onChange={(e) => setF({ ...f, typeId: e.target.value })}><option value="">Performance bonus</option>{types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
        <div><button className="btn btn-primary btn-sm" disabled={f.name.trim().length < 2 || !f.formula.trim() || save.isPending} onClick={() => save.mutate()}>Save scheme</button></div>
      </section>
      <section data-card className="card" style={{ padding: 20, display: 'grid', gap: 8 }}>
        <h3 style={{ fontSize: 16 }}>Schemes</h3>
        {!schemes.length ? <p className="dim" style={{ fontSize: 13 }}>None yet.</p> : schemes.map((s) => (
          <div key={s.id} style={{ display: 'flex', gap: 10, alignItems: 'center', borderTop: '1px solid var(--line)', paddingTop: 8, flexWrap: 'wrap' }}>
            <span style={{ flex: 1, minWidth: 200 }}><strong style={{ fontWeight: 500 }}>{s.name}</strong> <span className="pill mute">{s.kind}</span><div className="dim" style={{ fontSize: 12, fontFamily: 'ui-monospace, monospace' }}>{s.formula}</div></span>
            <button className="btn btn-ghost btn-sm" onClick={() => setRunning(s)}>Run</button>
          </div>
        ))}
      </section>
      {running && <RunScheme scheme={running} onClose={() => setRunning(null)} />}
    </div>
  )
}

function RunScheme({ scheme, onClose }: { scheme: any; onClose: () => void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const { data: people = [] } = usePeople()
  const vars = scheme.variables as { key: string; label: string }[]
  const [period, setPeriod] = useState('')
  const [vals, setVals] = useState<Record<string, Record<string, string>>>({})
  const [preview, setPreview] = useState<any[] | null>(null)
  const rows = Object.entries(vals).filter(([, v]) => vars.every((x) => v[x.key] !== undefined && v[x.key] !== '')).map(([employeeId, v]) => ({ employeeId, values: Object.fromEntries(vars.map((x) => [x.key, Number(v[x.key])])) }))
  const run = useMutation({
    mutationFn: async (dryRun: boolean) => (await api.post(`/incentives/schemes/${scheme.id}/run`, { period: period.trim(), rows, dryRun })).data.data,
    onSuccess: (d, dryRun) => { if (dryRun) setPreview(d.rows); else { toast(`${d.created} nomination${d.created === 1 ? '' : 's'} sent to HR`); qc.invalidateQueries({ queryKey: ['incentives'] }); onClose() } },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  return (
    <section data-card className="card" style={{ padding: 20, display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><h3 style={{ fontSize: 16, flex: 1 }}>Run: {scheme.name}</h3><button className="btn btn-ghost btn-sm" onClick={onClose}>Close</button></div>
      <label className="field"><span>Period</span><input className="input" value={period} maxLength={40} onChange={(e) => setPeriod(e.target.value)} placeholder="e.g. October 2026" /></label>
      <p className="dim" style={{ fontSize: 13 }}>Fill in the values for the people this period. Leave a row empty to skip that person.</p>
      <div style={{ overflowX: 'auto' }}><table className="tbl" style={{ minWidth: 420 }}><thead><tr><th>Person</th>{vars.map((v) => <th key={v.key}>{v.label}</th>)}<th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
        <tbody>{people.map((p) => { const pr = preview?.find((x) => x.employeeId === p.id); return (
          <tr key={p.id}><td>{p.firstName} {p.lastName}</td>
            {vars.map((v) => <td key={v.key}><input className="input" type="number" style={{ height: 30, width: 110 }} value={vals[p.id]?.[v.key] ?? ''} onChange={(e) => { setPreview(null); setVals({ ...vals, [p.id]: { ...vals[p.id], [v.key]: e.target.value } }) }} /></td>)}
            <td style={{ textAlign: 'right' }}>{pr ? (pr.skipped ? <span className="dim" style={{ fontSize: 12 }}>{pr.skipped}</span> : n(pr.amount)) : ''}</td></tr>
        ) })}</tbody></table></div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-ghost btn-sm" disabled={!rows.length || period.trim().length < 2 || run.isPending} onClick={() => run.mutate(true)}>Work out amounts</button>
        <button className="btn btn-primary btn-sm" disabled={!preview || run.isPending} onClick={() => run.mutate(false)}>Send to HR for approval</button>
      </div>
    </section>
  )
}

export function BudgetsPanel() {
  const { hasRole } = useAuth()
  const isHR = hasRole('hr_admin')
  const toast = useToast()
  const qc = useQueryClient()
  const { data = [] } = useQuery({ queryKey: ['incentive-budgets'], queryFn: async () => (await api.get('/incentives/budgets')).data.data as any[] })
  const { data: people = [] } = usePeople()
  const month = new Date().toISOString().slice(0, 7)
  const [f, setF] = useState({ managerEmployeeId: '', periodStart: `${month}-01`, periodEnd: '', amount: '' })
  const save = useMutation({
    mutationFn: () => api.post('/incentives/budgets', { ...f, amount: Number(f.amount) }),
    onSuccess: () => { toast('Budget saved; the manager is told'); qc.invalidateQueries({ queryKey: ['incentive-budgets'] }) },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  const csv = () => {
    const lines = [['Manager', 'From', 'To', 'Budget', 'Used', 'Paid', 'Left', '%'], ...data.map((b) => [b.manager, b.periodStart, b.periodEnd, b.amount, b.used, b.paid, b.left, b.pct])]
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([lines.map((l) => l.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')], { type: 'text/csv' })); a.download = 'incentive-budgets.csv'; a.click()
  }
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {isHR && <section data-card className="card" style={{ padding: 20, display: 'grid', gap: 10 }}>
        <h3 style={{ fontSize: 16 }}>Give a manager a budget</h3>
        <p className="dim" style={{ fontSize: 13 }}>Their nominations in the period must fit it. They and HR are told at 80% and when it is used up.</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8 }}>
          <select className="input" value={f.managerEmployeeId} onChange={(e) => setF({ ...f, managerEmployeeId: e.target.value })} aria-label="Manager"><option value="">Manager…</option>{people.map((p) => <option key={p.id} value={p.id}>{p.firstName} {p.lastName}</option>)}</select>
          <input className="input" type="date" value={f.periodStart} onChange={(e) => setF({ ...f, periodStart: e.target.value })} aria-label="From" />
          <input className="input" type="date" value={f.periodEnd} onChange={(e) => setF({ ...f, periodEnd: e.target.value })} aria-label="To" />
          <input className="input" type="number" placeholder="Amount" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
        </div>
        <div><button className="btn btn-primary btn-sm" disabled={!f.managerEmployeeId || !f.periodEnd || !(Number(f.amount) >= 0) || f.amount === '' || save.isPending} onClick={() => save.mutate()}>Save budget</button></div>
      </section>}
      <section data-card className="card" style={{ padding: 20, display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><h3 style={{ fontSize: 16, flex: 1 }}>{isHR ? 'Budgets and use' : 'My budget'}</h3>{isHR && data.length > 0 && <button className="btn btn-ghost btn-sm" onClick={csv}>Download CSV</button>}</div>
        {!data.length ? <p className="dim" style={{ fontSize: 13 }}>{isHR ? 'No budgets yet. Without one, a manager can nominate any amount within each type’s cap.' : 'HR has not given you a budget; you can nominate within each award’s cap.'}</p> : data.map((b) => (
          <div key={b.id} style={{ display: 'grid', gap: 6, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 13 }}><strong style={{ fontWeight: 500, flex: 1 }}>{b.manager}</strong><span className="dim">{fmtDate(b.periodStart)} – {fmtDate(b.periodEnd)}</span></div>
            <div style={{ height: 8, borderRadius: 4, background: 'var(--well)', overflow: 'hidden' }}><div style={{ width: `${Math.min(100, b.pct)}%`, height: '100%', background: b.pct >= 100 ? 'var(--danger)' : b.pct >= 80 ? 'var(--warn)' : 'var(--ok)' }} /></div>
            <div className="dim" style={{ fontSize: 12 }}>{n(b.used)} of {n(b.amount)} used ({b.pct}%) · {n(b.left)} left · {n(b.paid)} paid through payroll · {b.count} nomination{b.count === 1 ? '' : 's'}</div>
          </div>
        ))}
      </section>
    </div>
  )
}

export function VariablePayPanel() {
  const toast = useToast()
  const qc = useQueryClient()
  const { data: cycles = [] } = useQuery({ queryKey: ['perf-cycles-vp'], queryFn: async () => (await api.get('/performance/cycles')).data.data as any[] })
  const [cid, setCid] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const { data: rows = [], isFetching } = useQuery({ queryKey: ['vp', cid], enabled: !!cid, queryFn: async () => (await api.get(`/incentives/ratings/${cid}`)).data.data as any[] })
  const go = useMutation({
    mutationFn: async () => (await api.post(`/incentives/ratings/${cid}/nominate`, { employeeIds: picked })).data.data,
    onSuccess: (d) => { toast(`${d.created} sent to HR for approval`); setPicked([]); qc.invalidateQueries({ queryKey: ['vp'] }); qc.invalidateQueries({ queryKey: ['incentives'] }) },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  const ok = rows.filter((r) => r.suggested > 0 && !r.alreadyNominated)
  return (
    <section data-card className="card" style={{ padding: 20, display: 'grid', gap: 10 }}>
      <h3 style={{ fontSize: 16 }}>Variable pay from review ratings</h3>
      <p className="dim" style={{ fontSize: 13 }}>Each person’s variable pay for the review period (contract variable % of CTC) times the payout for their rating. HR sets the payout per rating; the nomination HR approves shows the rating and %, never the salary.</p>
      <select className="input" value={cid} onChange={(e) => { setCid(e.target.value); setPicked([]) }} aria-label="Review cycle"><option value="">Choose a review cycle…</option>{cycles.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
      {cid && (isFetching ? <div className="skeleton" style={{ height: 80 }} /> : !rows.length ? <p className="dim" style={{ fontSize: 13 }}>No reviewed goals in this cycle yet.</p> : <>
        <div style={{ overflowX: 'auto' }}><table className="tbl" style={{ minWidth: 640 }}><thead><tr><th /><th>Person</th><th>Score</th><th>Rating</th><th style={{ textAlign: 'right' }}>Variable pay</th><th style={{ textAlign: 'right' }}>Payout</th><th style={{ textAlign: 'right' }}>Suggested</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.employeeId}><td>{r.suggested > 0 && !r.alreadyNominated && <input type="checkbox" checked={picked.includes(r.employeeId)} onChange={(e) => setPicked(e.target.checked ? [...picked, r.employeeId] : picked.filter((x) => x !== r.employeeId))} aria-label={`Select ${r.name}`} />}</td>
              <td>{r.name}{r.note && <div className="dim" style={{ fontSize: 11 }}>{r.note}</div>}{r.alreadyNominated && <div className="dim" style={{ fontSize: 11 }}>already nominated</div>}</td><td>{r.score}%</td><td>{r.rating}</td>
              <td style={{ textAlign: 'right' }}>{n(r.variablePay)}</td><td style={{ textAlign: 'right' }}>{r.payoutPercent}%</td><td style={{ textAlign: 'right', fontWeight: 500 }}>{n(r.suggested)} {r.currency ?? ''}</td></tr>
          ))}</tbody></table></div>
        <div style={{ display: 'flex', gap: 8 }}><button className="btn btn-ghost btn-sm" onClick={() => setPicked(picked.length === ok.length ? [] : ok.map((r) => r.employeeId))}>{picked.length === ok.length && ok.length ? 'Clear' : 'Select all'}</button><button className="btn btn-primary btn-sm" disabled={!picked.length || go.isPending} onClick={() => go.mutate()}>Nominate {picked.length || ''}</button></div>
      </>)}
    </section>
  )
}

export function PointsPanel() {
  const { hasRole } = useAuth()
  const toast = useToast()
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['kudos-points'], queryFn: async () => (await api.get('/incentives/points')).data.data })
  const { data: board = [] } = useQuery({ queryKey: ['kudos-board'], queryFn: async () => (await api.get('/incentives/points/leaderboard')).data.data as any[] })
  const [pts, setPts] = useState('')
  const redeem = useMutation({
    mutationFn: async () => (await api.post('/incentives/points/redeem', { points: Number(pts) })).data.data,
    onSuccess: (d) => { toast(`Sent to HR: ${n(d.amount)} once approved`); setPts(''); qc.invalidateQueries({ queryKey: ['kudos-points'] }); qc.invalidateQueries({ queryKey: ['incentives'] }) },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  const s = data?.settings
  return (
    <div className="dgrid">
      <section data-card className="card span-6" style={{ padding: 20, display: 'grid', gap: 10, alignContent: 'start' }}>
        <h3 style={{ fontSize: 16 }}>My kudos points</h3>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 40 }}>{data?.balance ?? 0}</div>
        {s && <p className="dim" style={{ fontSize: 13 }}>Each kudos you receive in Community earns {s.kudosPoints} points (once per person every 30 days){s.pointsExpireMonths ? `, valid for ${s.pointsExpireMonths} months` : ''}. Redeem {s.minRedeem} or more for pay at {s.pointValue} a point; HR approves it.</p>}
        {data?.expiringSoon > 0 && <div className="pill warn" style={{ textTransform: 'none', width: 'fit-content' }}>{data.expiringSoon} points expire within 30 days</div>}
        <div style={{ display: 'flex', gap: 8 }}><input className="input" type="number" min={s?.minRedeem ?? 1} placeholder="Points" value={pts} onChange={(e) => setPts(e.target.value)} style={{ maxWidth: 140 }} /><button className="btn btn-primary btn-sm" disabled={!(Number(pts) > 0) || redeem.isPending} onClick={() => redeem.mutate()}>Redeem</button></div>
        {hasRole('hr_admin') && <PointsSettings />}
      </section>
      <section data-card className="card span-6" style={{ padding: 20, display: 'grid', gap: 8, alignContent: 'start' }}>
        <h3 style={{ fontSize: 16 }}>Leaderboard <span className="dim" style={{ fontSize: 12, fontWeight: 400 }}>last 90 days</span></h3>
        {!board.length ? <p className="dim" style={{ fontSize: 13 }}>No kudos yet. Thank someone in Community.</p> : board.map((b) => (
          <div key={b.employeeId} style={{ display: 'flex', gap: 10, fontSize: 14, borderTop: '1px solid var(--line)', paddingTop: 6 }}><span className="dim" style={{ width: 22 }}>{b.rank}</span><span style={{ flex: 1 }}>{b.name}</span><strong style={{ fontWeight: 500 }}>{b.points}</strong></div>
        ))}
      </section>
    </div>
  )
}

function PointsSettings() {
  const toast = useToast()
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['incentive-settings'], queryFn: async () => (await api.get('/incentives/settings')).data.data })
  const [f, setF] = useState<any>(null)
  const v = f ?? data
  const save = useMutation({
    mutationFn: () => api.put('/incentives/settings', { kudosPoints: Number(v.kudosPoints), pointValue: Number(v.pointValue), pointsExpireMonths: Number(v.pointsExpireMonths), minRedeem: Number(v.minRedeem), ratingPayout: Object.fromEntries(Object.entries(v.ratingPayout).map(([k, x]) => [k, Number(x)])) }),
    onSuccess: () => { toast('Saved'); setF(null); qc.invalidateQueries({ queryKey: ['incentive-settings'] }); qc.invalidateQueries({ queryKey: ['kudos-points'] }) },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  if (!v) return null
  const set = (k: string, x: any) => setF({ ...v, [k]: x })
  return (
    <details style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>
      <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 500 }}>Company settings (HR)</summary>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 10 }}>
        <label className="field"><span>Points per kudos</span><input className="input" type="number" value={v.kudosPoints} onChange={(e) => set('kudosPoints', e.target.value)} /></label>
        <label className="field"><span>Pay per point</span><input className="input" type="number" value={v.pointValue} onChange={(e) => set('pointValue', e.target.value)} /></label>
        <label className="field"><span>Points expire after (months, 0 = never)</span><input className="input" type="number" value={v.pointsExpireMonths} onChange={(e) => set('pointsExpireMonths', e.target.value)} /></label>
        <label className="field"><span>Smallest redemption</span><input className="input" type="number" value={v.minRedeem} onChange={(e) => set('minRedeem', e.target.value)} /></label>
        {Object.entries(v.ratingPayout as Record<string, number>).map(([k, x]) => <label key={k} className="field"><span>{k}: % of variable pay</span><input className="input" type="number" value={x} onChange={(e) => set('ratingPayout', { ...v.ratingPayout, [k]: e.target.value })} /></label>)}
      </div>
      <button className="btn btn-primary btn-sm" style={{ marginTop: 8 }} disabled={!f || save.isPending} onClick={() => save.mutate()}>Save settings</button>
    </details>
  )
}
