import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import Modal from '../../components/ui/Modal'
import { useToast } from '../../components/ui/Toast'
import { fmtDate } from '../../lib/format'

// Compliance officer tools: a company version of a statutory table, and sign-off of tax overrides asked by Payroll
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'

export function NewVersionModal({ table, onClose }: { table: { code: string; name: string; params: any }; onClose: () => void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const [from, setFrom] = useState(new Date().toISOString().slice(0, 10))
  const [text, setText] = useState(JSON.stringify(table.params, null, 2))
  const [note, setNote] = useState('')
  const [url, setUrl] = useState('')
  let parsed: any = null
  try { parsed = JSON.parse(text) } catch { /* shown below */ }
  const save = useMutation({
    mutationFn: () => api.post('/tax/tables', { code: table.code, effectiveFrom: from, params: parsed, sourceNote: note.trim(), ...(url.trim() && { sourceUrl: url.trim() }) }),
    onSuccess: () => { toast('Saved. Payroll uses it for pay periods ending on or after that date.'); qc.invalidateQueries({ queryKey: ['tax-tables'] }); onClose() },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  return (
    <Modal open onClose={onClose} title={`New figures: ${table.name}`} width={620}>
      <div style={{ display: 'grid', gap: 12 }}>
        <p className="dim" style={{ fontSize: 13 }}>Your company's own version. Payroll uses it instead of the shared one for pay periods ending on or after the date below. Keep the same names; change only the numbers. Rates are fractions: 0.3 means 30%; <code>null</code> in a band means “and above”.</p>
        <label className="field"><span>In force from</span><input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field"><span>Figures</span><textarea className="input" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, minHeight: 220 }} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} /></label>
        {!parsed && <div style={{ color: 'var(--danger)', fontSize: 12 }}>That isn't valid: check commas and brackets.</div>}
        <label className="field"><span>Where the figures come from (e.g. the circular or gazette)</span><input className="input" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} /></label>
        <label className="field"><span>Link (optional)</span><input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" /></label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!parsed || note.trim().length < 5 || save.isPending} onClick={() => save.mutate()}>Save version</button>
        </div>
      </div>
    </Modal>
  )
}

export function OverridesPanel({ canDecide }: { canDecide: boolean }) {
  const toast = useToast()
  const qc = useQueryClient()
  const [status, setStatus] = useState<'pending' | 'approved' | 'rejected'>('pending')
  const { data = [], isLoading } = useQuery({ queryKey: ['tax-overrides', status], queryFn: async () => (await api.get('/tax/overrides', { params: { status } })).data.data as any[] })
  const decide = useMutation({
    mutationFn: (v: { id: string; approve: boolean; note?: string }) => api.post(`/tax/overrides/${v.id}/decide`, { approve: v.approve, ...(v.note && { note: v.note }) }),
    onSuccess: () => { toast('Done'); qc.invalidateQueries({ queryKey: ['tax-overrides'] }) },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  return (
    <section className="card" data-card style={{ padding: 20, display: 'grid', gap: 12 }}>
      <p className="dim" style={{ fontSize: 13 }}>A Payroll admin can ask to change a tax amount on a payslip (Override on the payslip, while the run is in review). It applies only after a Compliance officer who did not ask signs it off, and the run cannot be approved while one is waiting.</p>
      <div style={{ display: 'flex', gap: 6 }}>{(['pending', 'approved', 'rejected'] as const).map((s) => <button key={s} className={`btn btn-sm ${status === s ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setStatus(s)}>{s === 'pending' ? 'Waiting' : s === 'approved' ? 'Signed off' : 'Not approved'}</button>)}</div>
      {isLoading ? <div className="skeleton" style={{ height: 80 }} /> : !data.length ? <p className="dim" style={{ fontSize: 13 }}>Nothing here.</p> : (
        <table className="tbl"><thead><tr><th>Person</th><th>Pay period</th><th>Line</th><th style={{ textAlign: 'right' }}>From → to</th><th>Reason</th><th>Asked by</th><th /></tr></thead>
          <tbody>{data.map((o) => (
            <tr key={o.id}>
              <td>{o.employee}</td><td>{o.period}</td><td>{o.lineCode}</td>
              <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{o.originalAmount.toLocaleString()} → <strong>{o.amount.toLocaleString()}</strong></td>
              <td style={{ maxWidth: 260 }}>{o.reason}{o.decisionNote && <div className="dim" style={{ fontSize: 12 }}>Compliance: {o.decisionNote}</div>}</td>
              <td>{o.requestedByName}<div className="dim" style={{ fontSize: 12 }}>{fmtDate(o.createdAt)}</div></td>
              <td style={{ whiteSpace: 'nowrap' }}>{status === 'pending' && canDecide && (o.mine ? <span className="dim" style={{ fontSize: 12 }}>You asked: another officer signs off</span> : <>
                <button className="btn btn-primary btn-sm" disabled={decide.isPending} onClick={() => decide.mutate({ id: o.id, approve: true })}>Sign off</button>{' '}
                <button className="btn btn-ghost btn-sm" disabled={decide.isPending} onClick={() => { const note = window.prompt('Why not? (Payroll sees this)'); if (note) decide.mutate({ id: o.id, approve: false, note }) }}>Reject</button>
              </>)}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </section>
  )
}
