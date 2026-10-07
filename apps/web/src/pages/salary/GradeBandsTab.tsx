import { useState } from 'react'
import { useGradeBands, useSalaryWrite, errMsg } from '../../lib/hooks/useSalary'
import Modal from '../../components/ui/Modal'
import { FormField, inputStyle } from '../../components/ui/FormField'
import { money } from '../../lib/format'
import { card, th, td, empty, primaryBtn, ghostBtn, linkBtn, errorBox, grid2, footer } from './styles'

export default function GradeBandsTab({ canEdit }: { canEdit: boolean }) {
  const { data: bands = [], isLoading } = useGradeBands()
  const write = useSalaryWrite()
  const [f, setF] = useState<any>(null)
  const [error, setError] = useState('')

  const valid = f && f.code.trim() && f.name.trim() && Number(f.salaryMin) <= Number(f.salaryMid) && Number(f.salaryMid) <= Number(f.salaryMax)

  const save = async () => {
    setError('')
    const body = { name: f.name.trim(), salaryMin: Number(f.salaryMin), salaryMid: Number(f.salaryMid), salaryMax: Number(f.salaryMax), currency: f.currency.trim().toUpperCase() }
    try {
      await write.mutateAsync(f.id ? { method: 'patch', path: `/salary/grade-bands/${f.id}`, body } : { method: 'post', path: '/salary/grade-bands', body: { ...body, code: f.code.trim() } })
      setF(null)
    } catch (err) { setError(errMsg(err)) }
  }
  const archive = async (id: string) => {
    setError('')
    try { await write.mutateAsync({ method: 'patch', path: `/salary/grade-bands/${id}`, body: { active: false } }) } catch (err) { setError(errMsg(err)) }
  }

  return (
    <>
      {canEdit && <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}><button style={primaryBtn} onClick={() => setF({ code: '', name: '', salaryMin: '', salaryMid: '', salaryMax: '', currency: 'ZMW' })}>+ New band</button></div>}
      <div style={card}>
        {isLoading ? <div style={empty}>Loading...</div> : bands.length === 0 ? <div style={empty}>No grade bands yet.</div> : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>{['Code', 'Name', 'Minimum', 'Midpoint', 'Maximum', ''].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {bands.map((b: any) => (
                <tr key={b.id}>
                  <td style={td}><strong>{b.code}</strong></td>
                  <td style={td}>{b.name}</td>
                  <td style={td}>{money(b.salaryMin, b.currency)}</td>
                  <td style={td}>{money(b.salaryMid, b.currency)}</td>
                  <td style={td}>{money(b.salaryMax, b.currency)}</td>
                  <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {canEdit && <><button style={linkBtn} onClick={() => setF({ ...b })}>Edit</button><button style={{ ...linkBtn, color: 'var(--danger)' }} onClick={() => archive(b.id)}>Archive</button></>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p style={{ fontSize: 12, color: 'var(--faint)', marginTop: 8 }}>Bands are annual CTC ranges. Contracts outside their band are flagged on the Contracts tab.</p>
      {error && !f && <div style={errorBox}>{error}</div>}

      <Modal open={!!f} onClose={() => setF(null)} title={f?.id ? `Edit band ${f.code}` : 'New grade band'} width={520}>
        {f && (
          <div style={grid2}>
            <FormField label="Code" required><input style={inputStyle} value={f.code} disabled={!!f.id} onChange={(e) => setF({ ...f, code: e.target.value })} /></FormField>
            <FormField label="Name" required><input style={inputStyle} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></FormField>
            <FormField label="Minimum (annual)" required><input type="number" style={inputStyle} value={f.salaryMin} onChange={(e) => setF({ ...f, salaryMin: e.target.value })} /></FormField>
            <FormField label="Midpoint" required><input type="number" style={inputStyle} value={f.salaryMid} onChange={(e) => setF({ ...f, salaryMid: e.target.value })} /></FormField>
            <FormField label="Maximum" required><input type="number" style={inputStyle} value={f.salaryMax} onChange={(e) => setF({ ...f, salaryMax: e.target.value })} /></FormField>
            <FormField label="Currency" required><input style={inputStyle} maxLength={3} value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })} /></FormField>
          </div>
        )}
        {f && f.salaryMin !== '' && f.salaryMax !== '' && !valid && <div style={{ fontSize: 12, color: 'var(--danger)', marginTop: 8 }}>Minimum ≤ midpoint ≤ maximum</div>}
        {error && <div style={errorBox}>{error}</div>}
        <div style={footer}><button style={ghostBtn} onClick={() => setF(null)}>Cancel</button><button style={{ ...primaryBtn, opacity: valid ? 1 : 0.5 }} disabled={!valid || write.isPending} onClick={save}>Save</button></div>
      </Modal>
    </>
  )
}
