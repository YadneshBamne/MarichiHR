import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import Modal from '../../components/ui/Modal'
import Icon from '../../components/ui/Icon'
import { useToast } from '../../components/ui/Toast'
import { useAuth } from '../../contexts/AuthContext'
import { useEmployees } from '../../lib/hooks/useEmployees'
import { fmtDate } from '../../lib/format'

// Salary revisions: raised by one person, approved by another; approval makes the next contract version. Months already
// paid at the old wage become arrears, which payroll posts into an open run.
interface Rev { id: string; employee: string; employeeCode: string; currency: string; oldWageMonthly: number; newWageMonthly: number; oldCtcAnnual: number; newCtcAnnual: number; changePct: number | null; effectiveFrom: string; reason: string; status: string; requestedBy: string; requestedById: string; decidedBy: string | null; decisionNote: string | null; arrearsAmount: number | null; arrearsDetail: { month: string; difference: number }[] | null; arrearsPosted: boolean }
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
const n = (v: number, c: string) => `${v.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${c ?? ''}`
const STATUS: Record<string, string> = { pending: 'warn', approved: 'ok', rejected: 'danger', cancelled: 'mute' }

export default function RevisionsTab() {
  const { user } = useAuth()
  const qc = useQueryClient()
  const toast = useToast()
  const [status, setStatus] = useState('pending')
  const [raising, setRaising] = useState(false)
  const [posting, setPosting] = useState<Rev | null>(null)
  const { data = [], isLoading } = useQuery({ queryKey: ['salary-revisions', status], queryFn: async () => (await api.get('/salary-revisions', { params: status ? { status } : {} })).data.data as Rev[] })
  const refresh = () => qc.invalidateQueries({ queryKey: ['salary-revisions'] })
  const act = useMutation({ mutationFn: async (f: () => Promise<unknown>) => f(), onSuccess: () => { toast('Done'); refresh() }, onError: (e) => toast(errMsg(e), 'error') })
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 6 }}>{[['pending', 'Waiting'], ['approved', 'Approved'], ['', 'All']].map(([k, l]) => <button key={k} className="chip" aria-pressed={status === k} onClick={() => setStatus(k)} style={status === k ? { background: 'var(--night)', color: 'var(--night-ink)' } : undefined}>{l}</button>)}</div>
        <button className="btn btn-primary btn-sm" onClick={() => setRaising(true)}><Icon name="plus" size={14} /> Raise a revision</button>
      </div>
      {isLoading ? <div className="skeleton" style={{ height: 120, borderRadius: 14 }} /> : !data.length ? <p className="dim" style={{ fontSize: 13 }}>No revisions here.</p> : data.map((r) => (
        <div key={r.id} className="well" style={{ padding: 14, display: 'grid', gap: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <strong style={{ fontWeight: 600 }}>{r.employee} <span className="dim" style={{ fontWeight: 400 }}>{r.employeeCode}</span></strong>
            <span className={`pill ${STATUS[r.status]}`}>{r.status}</span>
          </div>
          <div style={{ fontSize: 13 }}>{n(r.oldWageMonthly, r.currency)} → <b>{n(r.newWageMonthly, r.currency)}</b> a month{r.changePct != null && ` (${r.changePct > 0 ? '+' : ''}${r.changePct}%)`} · from {fmtDate(r.effectiveFrom)} · {r.reason}</div>
          <div className="dim" style={{ fontSize: 12 }}>Raised by {r.requestedBy}{r.decidedBy ? ` · ${r.status} by ${r.decidedBy}` : ''}{r.decisionNote ? `: ${r.decisionNote}` : ''}</div>
          {r.arrearsAmount != null && r.arrearsAmount !== 0 && <div style={{ fontSize: 13 }}>Arrears for months already paid: <b>{n(r.arrearsAmount, r.currency)}</b> ({r.arrearsDetail?.map((d) => d.month).join(', ')}){r.arrearsPosted && <span className="pill ok" style={{ marginLeft: 6 }}>posted to payroll</span>}</div>}
          <div style={{ display: 'flex', gap: 6 }}>
            {r.status === 'pending' && r.requestedById !== user?.id && <>
              <button className="btn btn-primary btn-sm" onClick={() => act.mutate(() => api.post(`/salary-revisions/${r.id}/approve`, {}))}>Approve</button>
              <button className="btn btn-ghost btn-sm" onClick={() => { const note = prompt('Reason for rejecting'); if (note) act.mutate(() => api.post(`/salary-revisions/${r.id}/reject`, { note })) }}>Reject</button>
            </>}
            {r.status === 'pending' && r.requestedById === user?.id && <span className="dim" style={{ fontSize: 12 }}>Waiting for someone else to approve.</span>}
            {r.status === 'pending' && <button className="btn btn-ghost btn-sm" onClick={() => act.mutate(() => api.post(`/salary-revisions/${r.id}/cancel`))}>Cancel</button>}
            {r.status === 'approved' && (r.arrearsAmount ?? 0) > 0 && !r.arrearsPosted && <button className="btn btn-honey btn-sm" onClick={() => setPosting(r)}>Post arrears to payroll</button>}
          </div>
        </div>
      ))}
      {raising && <RaiseModal onClose={(ok) => { setRaising(false); if (ok) refresh() }} />}
      {posting && <PostModal r={posting} onClose={(ok) => { setPosting(null); if (ok) refresh() }} />}
    </div>
  )
}

function RaiseModal({ onClose }: { onClose: (ok?: boolean) => void }) {
  const toast = useToast()
  const { data: people } = useEmployees({ limit: 500 })
  const next = new Date(); next.setUTCMonth(next.getUTCMonth() + 1)
  const [f, setF] = useState({ employeeId: '', newWageMonthly: '', newCtcAnnual: '', month: next.toISOString().slice(0, 7), reason: '' })
  const save = useMutation({
    mutationFn: () => api.post('/salary-revisions', { employeeId: f.employeeId, newWageMonthly: Number(f.newWageMonthly), newCtcAnnual: Number(f.newCtcAnnual || Number(f.newWageMonthly) * 12), effectiveFrom: `${f.month}-01`, reason: f.reason }),
    onSuccess: () => { toast('Revision sent for approval'); onClose(true) }, onError: (e) => toast(errMsg(e), 'error'),
  })
  return (
    <Modal open onClose={() => onClose()} title="Raise a salary revision">
      <form onSubmit={(e) => { e.preventDefault(); save.mutate() }} style={{ display: 'grid', gap: 12 }}>
        <label className="field"><span>Employee</span><select className="input select" required value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value })}><option value="">Choose…</option>{((people?.data ?? []) as any[]).map((p) => <option key={p.id} value={p.id}>{p.firstName} {p.lastName} ({p.employeeCode})</option>)}</select></label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 12 }}>
          <label className="field"><span>New monthly wage</span><input className="input" type="number" min={1} required value={f.newWageMonthly} onChange={(e) => setF({ ...f, newWageMonthly: e.target.value })} /></label>
          <label className="field"><span>New annual CTC</span><input className="input" type="number" min={1} placeholder={f.newWageMonthly ? String(Number(f.newWageMonthly) * 12) : ''} value={f.newCtcAnnual} onChange={(e) => setF({ ...f, newCtcAnnual: e.target.value })} /></label>
          <label className="field"><span>From the start of</span><input className="input" type="month" required value={f.month} onChange={(e) => setF({ ...f, month: e.target.value })} /></label>
        </div>
        <label className="field"><span>Reason</span><input className="input" required minLength={3} maxLength={300} placeholder="Annual increment, promotion…" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></label>
        <span className="dim" style={{ fontSize: 12 }}>Someone other than you approves it. A start month already paid creates arrears for those months.</span>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><button type="button" className="btn btn-ghost" onClick={() => onClose()}>Cancel</button><button className="btn btn-primary" disabled={save.isPending}>Send for approval</button></div>
      </form>
    </Modal>
  )
}

function PostModal({ r, onClose }: { r: Rev; onClose: (ok?: boolean) => void }) {
  const toast = useToast()
  const { data: cycles = [] } = useQuery({ queryKey: ['payroll-cycles'], queryFn: async () => (await api.get('/payroll/cycles')).data.data as any[] })
  const open = cycles.filter((c) => ['draft', 'review'].includes(c.status))
  const [cycleId, setCycleId] = useState('')
  const save = useMutation({ mutationFn: () => api.post(`/salary-revisions/${r.id}/post-arrears`, { cycleId }), onSuccess: () => { toast('Arrears added to the run; approve the input there'); onClose(true) }, onError: (e) => toast(errMsg(e), 'error') })
  return (
    <Modal open onClose={() => onClose()} title={`Post ${n(r.arrearsAmount ?? 0, r.currency)} arrears`}>
      <form onSubmit={(e) => { e.preventDefault(); save.mutate() }} style={{ display: 'grid', gap: 12 }}>
        {!open.length ? <p className="dim">There is no open payroll run. Create one first.</p> : <label className="field"><span>Payroll run</span><select className="input select" required value={cycleId} onChange={(e) => setCycleId(e.target.value)}><option value="">Choose…</option>{open.map((c) => <option key={c.id} value={c.id}>{String(c.payPeriodStart).slice(0, 7)} · {c.status}</option>)}</select></label>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><button type="button" className="btn btn-ghost" onClick={() => onClose()}>Cancel</button><button className="btn btn-primary" disabled={!cycleId || save.isPending}>Post</button></div>
      </form>
    </Modal>
  )
}
