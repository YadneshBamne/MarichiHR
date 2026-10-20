import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import Modal from '../../components/ui/Modal'
import { useToast } from '../../components/ui/Toast'

// HR: one person's leave balances with Adjust (add or remove days, reason required), and the credit history.
interface Row { leaveTypeId: string; leaveType: string; creditMethod: string; creditAmount: number | null; balance: number; used: number; pending: number; available: number }
interface Hist { id: string; leaveType: string; type: string; days: number; reason: string | null; at: string }
const METHOD: Record<string, (n: number | null) => string> = {
  monthly_prorate: (n) => `${n ?? 0}/month, automatic`,
  annual_lumpsum: (n) => `${n ?? 0}/year, automatic`,
  manual: () => 'Given by HR',
}
const KIND: Record<string, string> = { accrual: 'Monthly credit', annual: 'Yearly credit', adjustment: 'HR adjustment', manual: 'HR allocation' }
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'

export default function LeaveBalancesPanel({ employeeId, name }: { employeeId: string; name: string }) {
  const { data, isLoading } = useQuery({ queryKey: ['leave-admin-balances', employeeId], queryFn: async () => (await api.get(`/leave/admin/balances/${employeeId}`)).data.data as { balances: Row[]; history: Hist[] } })
  const [adjusting, setAdjusting] = useState<Row | null>(null)
  if (isLoading || !data) return <div className="skeleton" style={{ height: 160, borderRadius: 14 }} />
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <section className="card" style={{ padding: 8, overflowX: 'auto' }}>
        <table className="tbl" style={{ width: '100%', minWidth: 640 }}>
          <thead><tr><th>Leave type</th><th>How it is credited</th><th style={{ textAlign: 'right' }}>Balance</th><th style={{ textAlign: 'right' }}>Used</th><th style={{ textAlign: 'right' }}>Pending</th><th style={{ textAlign: 'right' }}>Available</th><th /></tr></thead>
          <tbody>{data.balances.map((r) => (
            <tr key={r.leaveTypeId}>
              <td><strong style={{ fontWeight: 600 }}>{r.leaveType}</strong></td>
              <td className="dim" style={{ fontSize: 13 }}>{(METHOD[r.creditMethod] ?? METHOD.manual)(r.creditAmount)}</td>
              <td className="num" style={{ textAlign: 'right' }}>{r.balance}</td>
              <td className="num" style={{ textAlign: 'right' }}>{r.used}</td>
              <td className="num" style={{ textAlign: 'right' }}>{r.pending}</td>
              <td className="num" style={{ textAlign: 'right', fontWeight: 600, color: r.available < 0 ? 'var(--danger)' : undefined }}>{r.available}</td>
              <td style={{ textAlign: 'right' }}><button className="btn btn-ghost btn-sm" onClick={() => setAdjusting(r)}>Adjust</button></td>
            </tr>
          ))}</tbody>
        </table>
      </section>
      <p className="dim" style={{ fontSize: 12, margin: 0 }}>Automatic credits come from each leave type's settings (Time &amp; Attendance › Leave policies). Use Adjust for anything else: opening balances, corrections, special grants.</p>
      <section className="card" style={{ padding: 16 }}>
        <h3 style={{ fontSize: 15, marginBottom: 8 }}>Credit history</h3>
        {!data.history.length ? <p className="dim" style={{ fontSize: 13 }}>Nothing credited yet.</p> : (
          <div style={{ overflowX: 'auto' }}>
            <table className="tbl" style={{ width: '100%', minWidth: 520 }}>
              <thead><tr><th>When</th><th>Leave type</th><th>Kind</th><th style={{ textAlign: 'right' }}>Days</th><th>Reason</th></tr></thead>
              <tbody>{data.history.map((h) => <tr key={h.id}><td style={{ whiteSpace: 'nowrap' }}>{new Date(h.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</td><td>{h.leaveType}</td><td>{KIND[h.type] ?? h.type}</td><td className="num" style={{ textAlign: 'right' }}>{h.days > 0 ? '+' : ''}{h.days}</td><td className="dim" style={{ fontSize: 13 }}>{h.reason}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </section>
      {adjusting && <AdjustModal employeeId={employeeId} name={name} row={adjusting} onClose={() => setAdjusting(null)} />}
    </div>
  )
}

function AdjustModal({ employeeId, name, row, onClose }: { employeeId: string; name: string; row: Row; onClose: () => void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const [mode, setMode] = useState<'add' | 'remove'>('add')
  const [days, setDays] = useState('')
  const [reason, setReason] = useState('')
  const [confirmNegative, setConfirmNegative] = useState<string | null>(null)
  const n = Number(days)
  const delta = mode === 'add' ? n : -n
  const valid = n > 0 && Number.isInteger(n * 2) && reason.trim().length >= 3
  const save = useMutation({
    mutationFn: async (allowNegative: boolean) => (await api.post(`/leave/admin/balances/${employeeId}/adjust`, { leaveTypeId: row.leaveTypeId, days: delta, reason: reason.trim(), ...(allowNegative && { allowNegative: true }) })).data.data,
    onSuccess: (r) => { toast(`${row.leaveType}: ${delta > 0 ? '+' : ''}${delta} days. Available now ${r.available}`); qc.invalidateQueries({ queryKey: ['leave-admin-balances', employeeId] }); onClose() },
    onError: (e: any) => { if (e?.response?.status === 409) setConfirmNegative(errMsg(e)); else toast(errMsg(e), 'error') },
  })
  return (
    <Modal open onClose={onClose} title={`Adjust ${row.leaveType} for ${name}`}>
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(false) }} style={{ display: 'grid', gap: 12 }}>
        <p className="dim" style={{ margin: 0, fontSize: 13 }}>Available now: <b>{row.available}</b> days</p>
        <div style={{ display: 'flex', gap: 6 }}>
          {(['add', 'remove'] as const).map((m) => <button type="button" key={m} className="chip" aria-pressed={mode === m} style={mode === m ? { background: 'var(--night)', color: 'var(--night-ink)' } : undefined} onClick={() => { setMode(m); setConfirmNegative(null) }}>{m === 'add' ? 'Add days' : 'Remove days'}</button>)}
        </div>
        <label className="field"><span>Days</span><input className="input" type="number" min={0.5} max={366} step={0.5} required value={days} onChange={(e) => { setDays(e.target.value); setConfirmNegative(null) }} placeholder="e.g. 3" /></label>
        <label className="field"><span>Reason (the employee sees it)</span><input className="input" required minLength={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Opening balance from previous system" /></label>
        {valid && <p style={{ margin: 0, fontSize: 13 }}>After this: <b>{Math.round((row.available + delta) * 100) / 100}</b> days available</p>}
        {confirmNegative && <p className="pill warn" style={{ whiteSpace: 'normal', margin: 0 }}>{confirmNegative}</p>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          {confirmNegative
            ? <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate(true)}>Allow negative and save</button>
            : <button className="btn btn-primary" disabled={!valid || save.isPending}>Save</button>}
        </div>
      </form>
    </Modal>
  )
}

// Approvals: employees' requests for extra leave days (manager for direct reports, HR for everyone)
interface Req { id: string; employee: string; employeeCode: string; leaveType: string; requestedDays: number; reason: string | null; createdAt: string }
export function usePendingAllocationRequests(enabled: boolean) {
  return useQuery({ queryKey: ['leave-allocation-requests'], enabled, queryFn: async () => (await api.get('/leave/allocation-requests/pending')).data.data as Req[] })
}
export function AllocationRequestsPanel() {
  const toast = useToast()
  const qc = useQueryClient()
  const { data = [] } = usePendingAllocationRequests(true)
  const [days, setDays] = useState<Record<string, string>>({})
  const act = useMutation({
    mutationFn: async ({ r, approve }: { r: Req; approve: boolean }) => {
      if (approve) return api.post(`/leave/allocation-requests/${r.id}/approve`, { approvedDays: Number(days[r.id] ?? r.requestedDays) })
      const note = prompt('Why is this request rejected?')
      if (!note) throw new Error('cancelled')
      return api.post(`/leave/allocation-requests/${r.id}/reject`, { note })
    },
    onSuccess: (_d, v) => { toast(v.approve ? 'Approved; the days are added' : 'Rejected'); qc.invalidateQueries({ queryKey: ['leave-allocation-requests'] }) },
    onError: (e: any) => { if (e?.message !== 'cancelled') toast(errMsg(e), 'error') },
  })
  if (!data.length) return null
  return (
    <section className="card" style={{ padding: 16, marginTop: 16 }}>
      <h3 style={{ fontSize: 15, marginBottom: 8 }}>Requests for extra leave days ({data.length})</h3>
      <div style={{ display: 'grid', gap: 10 }}>
        {data.map((r) => (
          <div key={r.id} className="well" style={{ padding: 12, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <strong style={{ fontWeight: 600 }}>{r.employee}</strong> <span className="dim">{r.employeeCode}</span>
              <div style={{ fontSize: 13 }}>{r.requestedDays} day(s) of {r.leaveType}{r.reason ? ` · ${r.reason}` : ''}</div>
            </div>
            <label className="field" style={{ width: 90 }}><span>Days</span><input className="input" type="number" min={0.5} step={0.5} value={days[r.id] ?? String(r.requestedDays)} onChange={(e) => setDays({ ...days, [r.id]: e.target.value })} /></label>
            <button className="btn btn-primary btn-sm" disabled={act.isPending} onClick={() => act.mutate({ r, approve: true })}>Approve</button>
            <button className="btn btn-ghost btn-sm" disabled={act.isPending} onClick={() => act.mutate({ r, approve: false })}>Reject</button>
          </div>
        ))}
      </div>
    </section>
  )
}
