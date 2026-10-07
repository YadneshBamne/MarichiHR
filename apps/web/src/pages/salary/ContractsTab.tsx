import { useState } from 'react'
import { useContracts, useStructures, useGradeBands, useSalaryWrite, errMsg } from '../../lib/hooks/useSalary'
import { useEmployees } from '../../lib/hooks/useEmployees'
import Modal from '../../components/ui/Modal'
import Badge from '../../components/ui/Badge'
import { FormField, inputStyle, selectStyle } from '../../components/ui/FormField'
import { money, fmtDate } from '../../lib/format'
import { card, th, td, empty, primaryBtn, ghostBtn, linkBtn, errorBox, grid2, footer } from './styles'

// Mirrors CONTRACT_TRANSITIONS on the API: [label, endpoint]
const NEXT: Record<string, [string, string][]> = {
  new: [['Move to draft', 'draft']],
  draft: [['Confirm', 'confirm']],
  confirmed: [['Activate', 'activate']],
}
const LIVE = ['new', 'draft', 'confirmed', 'running']

function outOfBand(c: any): string | null {
  const b = c.gradeBand
  if (!b) return null
  if (b.currency !== c.currency) return `band is in ${b.currency}`
  if (c.ctcAnnual < b.salaryMin) return 'below band minimum'
  if (c.ctcAnnual > b.salaryMax) return 'above band maximum'
  return null
}

export default function ContractsTab({ canEdit }: { canEdit: boolean }) {
  const { data: contracts = [], isLoading } = useContracts()
  const write = useSalaryWrite()
  const [creating, setCreating] = useState(false)
  const [linking, setLinking] = useState<any>(null)
  const [cancelling, setCancelling] = useState<any>(null)
  const [reason, setReason] = useState('')
  const [statusFilter, setStatusFilter] = useState('live')
  const [error, setError] = useState('')

  const act = async (id: string, step: string, body: Record<string, unknown> = {}) => {
    setError('')
    try { await write.mutateAsync({ method: 'post', path: `/leave/contracts/${id}/${step}`, body }) } catch (err) { setError(errMsg(err)) }
  }

  const shown = contracts.filter((c: any) => statusFilter === 'all' || (statusFilter === 'live' ? LIVE.includes(c.status) : c.status === statusFilter))

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12, gap: 12 }}>
        <select style={{ ...selectStyle, width: 200 }} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="live">Live (new → running)</option>
          {['new', 'draft', 'confirmed', 'running', 'expired', 'cancelled'].map((s) => <option key={s} value={s}>{s}</option>)}
          <option value="all">All</option>
        </select>
        {canEdit && <button style={primaryBtn} onClick={() => setCreating(true)}>+ New contract</button>}
      </div>
      <div style={card}>
        {isLoading ? <div style={empty}>Loading...</div> : shown.length === 0 ? <div style={empty}>No contracts.</div> : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>{['Employee', 'Monthly wage', 'Structure', 'Grade band', 'Effective', 'Notice', 'Status', ''].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {shown.map((c: any) => {
                const flag = outOfBand(c)
                return (
                  <tr key={c.id}>
                    <td style={td}><strong>{c.employee.firstName} {c.employee.lastName}</strong><div style={{ fontSize: 11, color: 'var(--faint)' }}>{c.employee.employeeCode}{!c.employee.active && ' · archived'}</div></td>
                    <td style={td}>{money(c.wageMonthly, c.currency)}<div style={{ fontSize: 11, color: 'var(--faint)' }}>CTC {money(c.ctcAnnual, c.currency)}</div></td>
                    <td style={td}>{c.salaryStructure ? c.salaryStructure.code : <span style={{ color: 'var(--danger)' }}>none — payroll skips</span>}</td>
                    <td style={td}>{c.gradeBand?.code ?? '—'}{flag && <div style={{ fontSize: 11, color: 'var(--warn)' }}>⚠ {flag}</div>}</td>
                    <td style={td}>{fmtDate(c.effectiveFrom)}<div style={{ fontSize: 11, color: 'var(--faint)' }}>{c.effectiveUntil ? `to ${fmtDate(c.effectiveUntil)}` : 'open-ended'}</div></td>
                    <td style={td}>{c.noticePeriodDays}d</td>
                    <td style={td}><Badge label={c.status} /></td>
                    <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {canEdit && (
                        <>
                          {(NEXT[c.status] || []).map(([label, step]) => <button key={step} style={linkBtn} disabled={write.isPending} onClick={() => act(c.id, step)}>{label}</button>)}
                          {LIVE.includes(c.status) && <button style={linkBtn} onClick={() => setLinking({ id: c.id, salaryStructureId: c.salaryStructureId || '', gradeBandId: c.gradeBandId || '' })}>Link</button>}
                          {LIVE.includes(c.status) && <button style={{ ...linkBtn, color: 'var(--danger)' }} onClick={() => { setReason(''); setCancelling(c) }}>Cancel</button>}
                        </>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
      {error && <div style={errorBox}>{error}</div>}

      {creating && <NewContractModal onClose={() => setCreating(false)} />}
      {linking && <LinkModal form={linking} onClose={() => setLinking(null)} />}
      <Modal open={!!cancelling} onClose={() => setCancelling(null)} title="Cancel contract" width={440}>
        <p style={{ fontSize: 13, color: 'var(--dim)', marginTop: 0 }}>
          {cancelling?.status === 'running' ? 'This contract is running: cancelling stops payroll for this employee from the next cycle.' : 'The contract moves to cancelled and cannot be reopened.'}
        </p>
        <input style={inputStyle} placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        <div style={footer}>
          <button style={ghostBtn} onClick={() => setCancelling(null)}>Back</button>
          <button style={{ ...primaryBtn, backgroundColor: 'var(--danger)' }} onClick={() => { act(cancelling.id, 'cancel', reason.trim() ? { reason: reason.trim() } : {}); setCancelling(null) }}>Cancel contract</button>
        </div>
      </Modal>
    </>
  )
}

function NewContractModal({ onClose }: { onClose: () => void }) {
  const { data: empRes } = useEmployees({ limit: 200 })
  const { data: structures = [] } = useStructures()
  const { data: bands = [] } = useGradeBands()
  const write = useSalaryWrite()
  const [f, setF] = useState({ employeeId: '', wageMonthly: '', ctcAnnual: '', currency: 'ZMW', effectiveFrom: '', effectiveUntil: '', noticePeriodDays: '30', salaryStructureId: '', gradeBandId: '', revisionReason: '' })
  const [error, setError] = useState('')
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }))
  const employees: any[] = empRes?.data ?? []
  const band = bands.find((b: any) => b.id === f.gradeBandId)
  const ctc = Number(f.ctcAnnual || Number(f.wageMonthly) * 12)
  const flag = band && f.wageMonthly ? outOfBand({ gradeBand: band, ctcAnnual: ctc, currency: f.currency }) : null

  const save = async () => {
    setError('')
    try {
      await write.mutateAsync({
        method: 'post', path: '/leave/contracts', body: {
          employeeId: f.employeeId, wageMonthly: Number(f.wageMonthly), ctcAnnual: ctc, currency: f.currency.toUpperCase(), effectiveFrom: f.effectiveFrom,
          noticePeriodDays: Number(f.noticePeriodDays),
          ...(f.effectiveUntil && { effectiveUntil: f.effectiveUntil }),
          ...(f.salaryStructureId && { salaryStructureId: f.salaryStructureId }),
          ...(f.gradeBandId && { gradeBandId: f.gradeBandId }),
          ...(f.revisionReason.trim() && { revisionReason: f.revisionReason.trim() }),
        },
      })
      onClose()
    } catch (err) { setError(errMsg(err)) }
  }

  const ready = f.employeeId && Number(f.wageMonthly) > 0 && f.effectiveFrom && /^[A-Za-z]{3}$/.test(f.currency)

  return (
    <Modal open onClose={onClose} title="New contract" width={600}>
      <div style={grid2}>
        <FormField label="Employee" required style={{ gridColumn: '1 / -1' }}>
          <select style={selectStyle} value={f.employeeId} onChange={(e) => set('employeeId', e.target.value)}>
            <option value="">Select employee</option>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName} ({e.employeeCode})</option>)}
          </select>
        </FormField>
        <FormField label="Monthly wage" required><input type="number" style={inputStyle} value={f.wageMonthly} onChange={(e) => set('wageMonthly', e.target.value)} /></FormField>
        <FormField label="Annual CTC"><input type="number" style={inputStyle} value={f.ctcAnnual} placeholder={f.wageMonthly ? String(Number(f.wageMonthly) * 12) : '12 × wage'} onChange={(e) => set('ctcAnnual', e.target.value)} /></FormField>
        <FormField label="Currency" required><input style={inputStyle} maxLength={3} value={f.currency} onChange={(e) => set('currency', e.target.value)} /></FormField>
        <FormField label="Notice period (days)"><input type="number" style={inputStyle} value={f.noticePeriodDays} onChange={(e) => set('noticePeriodDays', e.target.value)} /></FormField>
        <FormField label="Effective from" required><input type="date" style={inputStyle} value={f.effectiveFrom} onChange={(e) => set('effectiveFrom', e.target.value)} /></FormField>
        <FormField label="Effective until"><input type="date" style={inputStyle} value={f.effectiveUntil} min={f.effectiveFrom || undefined} onChange={(e) => set('effectiveUntil', e.target.value)} /></FormField>
        <FormField label="Salary structure">
          <select style={selectStyle} value={f.salaryStructureId} onChange={(e) => set('salaryStructureId', e.target.value)}>
            <option value="">None (link later)</option>
            {structures.map((s: any) => <option key={s.id} value={s.id}>{s.name} ({s.code})</option>)}
          </select>
        </FormField>
        <FormField label="Grade band">
          <select style={selectStyle} value={f.gradeBandId} onChange={(e) => set('gradeBandId', e.target.value)}>
            <option value="">None</option>
            {bands.map((b: any) => <option key={b.id} value={b.id}>{b.code} — {b.name}</option>)}
          </select>
        </FormField>
        <FormField label="Revision reason" style={{ gridColumn: '1 / -1' }}><input style={inputStyle} value={f.revisionReason} onChange={(e) => set('revisionReason', e.target.value)} /></FormField>
      </div>
      {flag && <div style={{ fontSize: 12, color: 'var(--warn)', marginTop: 10 }}>⚠ Annual CTC {money(ctc, f.currency)} is {flag} ({band.code}: {money(band.salaryMin, band.currency)}–{money(band.salaryMax, band.currency)})</div>}
      <p style={{ fontSize: 12, color: 'var(--faint)', marginBottom: 0 }}>New contracts start in “new”. Move them through draft → confirmed → running from the list.</p>
      {error && <div style={errorBox}>{error}</div>}
      <div style={footer}><button style={ghostBtn} onClick={onClose}>Cancel</button><button style={{ ...primaryBtn, opacity: ready ? 1 : 0.5 }} disabled={!ready || write.isPending} onClick={save}>Create contract</button></div>
    </Modal>
  )
}

function LinkModal({ form, onClose }: { form: any; onClose: () => void }) {
  const { data: structures = [] } = useStructures()
  const { data: bands = [] } = useGradeBands()
  const write = useSalaryWrite()
  const [f, setF] = useState(form)
  const [error, setError] = useState('')

  const save = async () => {
    setError('')
    try {
      await write.mutateAsync({ method: 'post', path: `/salary/contracts/${f.id}/link-structure`, body: { salaryStructureId: f.salaryStructureId, ...(f.gradeBandId && { gradeBandId: f.gradeBandId }) } })
      onClose()
    } catch (err) { setError(errMsg(err)) }
  }

  return (
    <Modal open onClose={onClose} title="Link structure and grade band" width={460}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <FormField label="Salary structure" required>
          <select style={selectStyle} value={f.salaryStructureId} onChange={(e) => setF({ ...f, salaryStructureId: e.target.value })}>
            <option value="">Select structure</option>
            {structures.map((s: any) => <option key={s.id} value={s.id}>{s.name} ({s.code})</option>)}
          </select>
        </FormField>
        <FormField label="Grade band">
          <select style={selectStyle} value={f.gradeBandId} onChange={(e) => setF({ ...f, gradeBandId: e.target.value })}>
            <option value="">Keep current / none</option>
            {bands.map((b: any) => <option key={b.id} value={b.id}>{b.code} — {b.name}</option>)}
          </select>
        </FormField>
      </div>
      {error && <div style={errorBox}>{error}</div>}
      <div style={footer}><button style={ghostBtn} onClick={onClose}>Cancel</button><button style={primaryBtn} disabled={!f.salaryStructureId || write.isPending} onClick={save}>Save</button></div>
    </Modal>
  )
}
