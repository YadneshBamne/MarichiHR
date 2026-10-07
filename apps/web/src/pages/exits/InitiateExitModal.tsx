import { useState } from 'react'
import Modal from '../../components/ui/Modal'
import { FormField, inputStyle, selectStyle } from '../../components/ui/FormField'
import { useEmployees } from '../../lib/hooks/useEmployees'
import { useAssignableUsers, useInitiateExit } from '../../lib/hooks/useExits'
import { primaryBtn } from './ExitsPage'

const DEPTS = [
  { key: 'IT', label: 'IT (assets, accounts)' },
  { key: 'FINANCE', label: 'Finance (advances, dues)' },
  { key: 'ADMIN', label: 'Admin (ID card, facilities)' },
  { key: 'MANAGER', label: 'Manager (handover)' },
] as const

interface Props { open: boolean; onClose: () => void; onCreated: (id: string) => void }

export default function InitiateExitModal({ open, onClose, onCreated }: Props) {
  const { data: empRes } = useEmployees({ limit: 200 })
  const { data: users = [] } = useAssignableUsers(open)
  const initiate = useInitiateExit()
  const [f, setF] = useState({ employeeId: '', exitType: 'resignation', noticeDate: '', lastWorkingDate: '', reason: '', shortfallAction: '' })
  const [clearance, setClearance] = useState<Record<string, string>>({ IT: '', FINANCE: '', ADMIN: '', MANAGER: '' })
  const [error, setError] = useState('')

  const employees: any[] = empRes?.data ?? []
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }))
  const exiting = employees.find((e) => e.id === f.employeeId)

  const submit = async () => {
    setError('')
    const picked = Object.entries(clearance).filter(([, v]) => v)
    if (new Set(picked.map(([, v]) => v)).size !== picked.length) return setError('Each clearance needs a different user')
    try {
      const exit = await initiate.mutateAsync({
        employeeId: f.employeeId, exitType: f.exitType, noticeDate: f.noticeDate, lastWorkingDate: f.lastWorkingDate, reason: f.reason,
        ...(f.shortfallAction && { shortfallAction: f.shortfallAction }),
        clearance: Object.fromEntries(picked),
      })
      onClose()
      onCreated(exit.id)
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Could not initiate the exit')
    }
  }

  const ready = f.employeeId && f.noticeDate && f.lastWorkingDate && f.reason.trim() && clearance.IT && clearance.FINANCE && clearance.ADMIN

  return (
    <Modal open={open} onClose={onClose} title="Initiate exit" width={620}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <FormField label="Employee" required style={{ gridColumn: '1 / -1' }}>
          <select style={selectStyle} value={f.employeeId} onChange={(e) => set('employeeId', e.target.value)}>
            <option value="">Select employee</option>
            {employees.filter((e) => e.active !== false).map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName} ({e.employeeCode})</option>)}
          </select>
        </FormField>
        <FormField label="Exit type" required>
          <select style={selectStyle} value={f.exitType} onChange={(e) => set('exitType', e.target.value)}>
            <option value="resignation">Resignation</option>
            <option value="termination">Termination</option>
          </select>
        </FormField>
        <FormField label="Notice shortfall">
          <select style={selectStyle} value={f.shortfallAction} onChange={(e) => set('shortfallAction', e.target.value)}>
            <option value="">Default ({f.exitType === 'resignation' ? 'recover from employee' : 'pay in lieu'})</option>
            <option value="recover">Recover from employee</option>
            <option value="buyout">Pay in lieu (buyout)</option>
            <option value="waive">Waive</option>
          </select>
        </FormField>
        <FormField label="Notice date" required>
          <input type="date" style={inputStyle} value={f.noticeDate} onChange={(e) => set('noticeDate', e.target.value)} />
        </FormField>
        <FormField label="Last working day" required>
          <input type="date" style={inputStyle} value={f.lastWorkingDate} min={f.noticeDate || undefined} onChange={(e) => set('lastWorkingDate', e.target.value)} />
        </FormField>
        <FormField label="Reason" required style={{ gridColumn: '1 / -1' }}>
          <textarea style={{ ...inputStyle, minHeight: 60, resize: 'vertical' }} value={f.reason} onChange={(e) => set('reason', e.target.value)} />
        </FormField>
      </div>

      <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--brand)', textTransform: 'uppercase', letterSpacing: '.04em', margin: '20px 0 10px' }}>Clearance sign-offs</div>
      <p style={{ fontSize: 12, color: 'var(--faint)', margin: '0 0 10px' }}>Each item is signed off by a different user. The settlement cannot be computed until all four are cleared.</p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        {DEPTS.map((d) => (
          <FormField key={d.key} label={d.label} required={d.key !== 'MANAGER'}>
            <select style={selectStyle} value={clearance[d.key]} onChange={(e) => setClearance((p) => ({ ...p, [d.key]: e.target.value }))}>
              <option value="">{d.key === 'MANAGER' ? 'Default: direct manager' : 'Select user'}</option>
              {users.filter((u: any) => u.id !== exiting?.userId).map((u: any) => (
                <option key={u.id} value={u.id}>{u.fullName} — {u.userRoles.map((r: any) => r.role.name).join(', ') || u.email}</option>
              ))}
            </select>
          </FormField>
        ))}
      </div>

      {error && <div style={{ marginTop: 14, backgroundColor: 'var(--danger-bg)', color: 'var(--danger)', borderRadius: 12, padding: '10px 12px', fontSize: 13 }}>{error}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
        <button onClick={onClose} style={{ padding: '9px 18px', background: 'var(--well)', border: '1px solid var(--line)', borderRadius: 12, fontSize: 13, cursor: 'pointer' }}>Cancel</button>
        <button onClick={submit} disabled={!ready || initiate.isPending} style={{ ...primaryBtn, opacity: !ready || initiate.isPending ? 0.5 : 1 }}>{initiate.isPending ? 'Saving...' : 'Initiate exit'}</button>
      </div>
    </Modal>
  )
}
