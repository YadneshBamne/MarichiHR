import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import Modal from '../../components/ui/Modal'
import { useBankFilePreview, downloadCsv } from '../../lib/hooks/usePayroll'
import { money } from '../../lib/format'

export default function BankFileModal({ cycleId, open, onClose }: { cycleId: string; open: boolean; onClose: () => void }) {
  const { data, isLoading, error: loadError } = useBankFilePreview(cycleId, open)
  const [partial, setPartial] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const qc = useQueryClient()
  const { data: fm } = useQuery({ queryKey: ['bank-formats'], enabled: open, queryFn: async () => (await api.get('/payroll/bank-formats')).data.data as { formats: any[]; presets: any[] } })
  const [formatId, setFormatId] = useState('')
  const [payDate, setPayDate] = useState(new Date().toISOString().slice(0, 10))
  const [adding, setAdding] = useState('')
  const addFormat = useMutation({
    mutationFn: async () => { const preset = fm!.presets[Number(adding)]; const name = window.prompt('Name of this layout (e.g. your bank)', preset.name); if (!name) return null; return (await api.post('/payroll/bank-formats', { ...preset, name })).data.data },
    onSuccess: (f) => { if (f) { setFormatId(f.id); qc.invalidateQueries({ queryKey: ['bank-formats'] }) } setAdding('') },
    onError: (e: any) => setError(e?.response?.data?.message || 'Could not save the layout'),
  })

  const excluded: any[] = data?.excluded || []
  const included: any[] = data?.included || []
  const blocked = excluded.length > 0 && !partial
  const previewError = (loadError as any)?.response?.data?.message

  const download = async () => {
    setError('')
    setBusy(true)
    try {
      await downloadCsv(`/payroll/cycles/${cycleId}/bank-file`, { ...(excluded.length > 0 && { allowPartial: true }), ...(formatId && { formatId, paymentDate: payDate }) })
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Could not generate the bank file')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Bank payment file" width={640}>
      {isLoading ? (
        <div style={{ color: 'var(--faint)', fontSize: 13 }}>Loading preview...</div>
      ) : previewError ? (
        <div style={{ backgroundColor: 'var(--danger-bg)', color: 'var(--danger)', borderRadius: 12, padding: '10px 12px', fontSize: 13 }}>{previewError}</div>
      ) : data ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ border: '1px solid var(--line)', borderRadius: 14, overflow: 'hidden' }}>
            {included.length === 0 ? (
              <div style={{ padding: 20, textAlign: 'center', color: 'var(--faint)', fontSize: 13 }}>No employees are payable yet.</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>{['Employee', 'Bank', 'Account', 'Amount'].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
                <tbody>
                  {included.map((r) => (
                    <tr key={r.employeeCode} style={{ borderBottom: '1px solid var(--well)' }}>
                      <td style={td}>{r.name} <span style={{ color: 'var(--faint)', fontSize: 11 }}>{r.employeeCode}</span></td>
                      <td style={td}>{r.bankName}</td>
                      <td style={td}>•••• {r.accountLast4}</td>
                      <td style={{ ...td, textAlign: 'right' }}>{money(r.amount, r.currency)}</td>
                    </tr>
                  ))}
                  <tr><td style={{ ...td, fontWeight: 600 }} colSpan={3}>Total</td><td style={{ ...td, fontWeight: 600, textAlign: 'right' }}>{money(data.totalAmount, data.currency)}</td></tr>
                </tbody>
              </table>
            )}
          </div>

          {excluded.length > 0 && (
            <div style={{ backgroundColor: 'var(--danger-bg)', border: '1px solid var(--danger-line)', borderRadius: 14, padding: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--danger)', marginBottom: 6 }}>{excluded.length} employee(s) excluded</div>
              {excluded.map((e) => (
                <div key={e.employeeCode} style={{ fontSize: 12, color: 'var(--danger)' }}>• {e.name} ({e.employeeCode}) — {e.reason}</div>
              ))}
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, fontSize: 13, color: 'var(--ink)', cursor: 'pointer' }}>
                <input type="checkbox" checked={partial} onChange={(e) => setPartial(e.target.checked)} />
                Download without the excluded employees
              </label>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 160px', gap: 8, alignItems: 'end' }}>
            <label className="field"><span>Layout</span><select className="input" value={formatId} onChange={(e) => setFormatId(e.target.value)}><option value="">Generic CSV</option>{(fm?.formats ?? []).filter((f) => f.active).map((f) => <option key={f.id} value={f.id}>{f.name} ({f.kind === 'fixed' ? 'fixed width' : 'delimited'})</option>)}</select></label>
            <label className="field"><span>Payment date</span><input className="input" type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} disabled={!formatId} /></label>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }} className="dim">
            <span>Your bank needs another layout? Start from</span>
            <select className="input" value={adding} onChange={(e) => setAdding(e.target.value)} style={{ height: 30, width: 'auto' }}><option value="">choose…</option>{(fm?.presets ?? []).map((p, i) => <option key={p.name} value={i}>{p.name}</option>)}</select>
            <button className="btn btn-ghost btn-sm" disabled={adding === '' || addFormat.isPending} onClick={() => addFormat.mutate()}>Add layout</button>
          </div>

          {error && <div style={{ backgroundColor: 'var(--danger-bg)', color: 'var(--danger)', borderRadius: 12, padding: '10px 12px', fontSize: 13 }}>{error}</div>}

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button onClick={onClose} style={{ padding: '9px 18px', backgroundColor: 'var(--well)', border: '1px solid var(--line)', borderRadius: 12, fontSize: 13, cursor: 'pointer' }}>Close</button>
            <button
              onClick={download}
              disabled={blocked || busy || included.length === 0}
              style={{ padding: '9px 18px', backgroundColor: 'var(--brand)', color: 'var(--night-ink)', border: 'none', borderRadius: 12, fontSize: 13, fontWeight: 500, cursor: blocked ? 'not-allowed' : 'pointer', opacity: blocked || busy || included.length === 0 ? 0.5 : 1 }}
            >{busy ? 'Preparing...' : 'Download file'}</button>
          </div>
        </div>
      ) : null}
    </Modal>
  )
}
const th: React.CSSProperties = { padding: '8px 12px', textAlign: 'left', fontSize: 11, fontWeight: 500, color: 'var(--faint)', borderBottom: '1px solid var(--line)', backgroundColor: 'var(--solid)' }
const td: React.CSSProperties = { padding: '10px 12px', fontSize: 13, color: 'var(--ink)' }
