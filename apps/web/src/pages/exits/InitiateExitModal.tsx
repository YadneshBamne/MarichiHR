import { useEffect, useState } from 'react'
import Modal from '../../components/ui/Modal'
import { useEmployees } from '../../lib/hooks/useEmployees'
import { useAssignableUsers, useInitiateExit } from '../../lib/hooks/useExits'
import MasterSelect from '../../components/ui/MasterSelect'
import { useMasters } from '../../lib/hooks/useMasters'

const DEPTS = [
  { key: 'IT', label: 'IT (assets, accounts)' },
  { key: 'FINANCE', label: 'Finance (advances, dues)' },
  { key: 'ADMIN', label: 'Admin (ID card, facilities)' },
  { key: 'MANAGER', label: 'Manager (handover)' },
] as const

export const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 14 }

// The four sign-offs, each by a different user (used when HR starts an exit and when HR accepts a resignation)
export function ClearanceFields({ users, exitingUserId, value, onChange }: { users: any[]; exitingUserId?: string; value: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  return (
    <>
      <h3 style={{ fontSize: 14, margin: '18px 0 4px' }}>Clearance sign-offs</h3>
      <p className="dim" style={{ fontSize: 12, margin: '0 0 10px' }}>Each item is signed off by a different user. The settlement cannot be computed until all four are cleared.</p>
      <div style={grid}>
        {DEPTS.map((d) => (
          <label key={d.key} className="field"><span>{d.label}{d.key !== 'MANAGER' && ' *'}</span>
            <select className="input" value={value[d.key] ?? ''} onChange={(e) => onChange({ ...value, [d.key]: e.target.value })}>
              <option value="">{d.key === 'MANAGER' ? 'Default: direct manager' : 'Select user'}</option>
              {users.filter((u: any) => u.id !== exitingUserId).map((u: any) => <option key={u.id} value={u.id}>{u.fullName} — {u.userRoles.map((r: any) => r.role.name).join(', ') || u.email}</option>)}
            </select>
          </label>
        ))}
      </div>
    </>
  )
}
export const clearancesReady = (c: Record<string, string>) => !!(c.IT && c.FINANCE && c.ADMIN)
export const pickedClearances = (c: Record<string, string>) => Object.fromEntries(Object.entries(c).filter(([, v]) => v))
export const duplicateClearance = (c: Record<string, string>) => { const p = Object.values(c).filter(Boolean); return new Set(p).size !== p.length }

interface Props { open: boolean; onClose: () => void; onCreated: (id: string) => void; employeeId?: string }

export default function InitiateExitModal({ open, onClose, onCreated, employeeId }: Props) {
  const { data: empRes } = useEmployees({ limit: 200 })
  const { data: users = [] } = useAssignableUsers(open)
  const initiate = useInitiateExit()
  const [f, setF] = useState({ employeeId: '', exitType: 'resignation', noticeDate: '', lastWorkingDate: '', reason: '', shortfallAction: '' })
  const [clearance, setClearance] = useState<Record<string, string>>({ IT: '', FINANCE: '', ADMIN: '', MANAGER: '' })
  useEffect(() => { if (open && employeeId) setF((p) => ({ ...p, employeeId })) }, [open, employeeId])
  const [error, setError] = useState('')
  const [left, setLeft] = useState(false)
  const [reasonCode, setReasonCode] = useState('')
  const { values, label: master } = useMasters()
  // Who ended employment decides the default for short notice (exit types carry it in their master meta)
  const endedBy = values('exit_type').find((t) => t.code === f.exitType)?.meta?.endedBy ?? (f.exitType === 'resignation' ? 'employee' : 'employer')

  const employees: any[] = empRes?.data ?? []
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }))
  const exiting = employees.find((e) => e.id === f.employeeId)
  const past = !!f.lastWorkingDate && f.lastWorkingDate < localDay()

  const submit = async () => {
    setError('')
    if (duplicateClearance(clearance)) return setError('Each clearance needs a different user')
    try {
      const exit = await initiate.mutateAsync({
        employeeId: f.employeeId, exitType: f.exitType, noticeDate: f.noticeDate, lastWorkingDate: f.lastWorkingDate, reason: f.reason,
        ...(f.shortfallAction && { shortfallAction: f.shortfallAction }), ...(past && left && { backdated: true }),
        clearance: pickedClearances(clearance),
      })
      onClose()
      onCreated(exit.id)
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Could not initiate the exit')
    }
  }

  const ready = f.employeeId && f.noticeDate && f.lastWorkingDate && f.reason.trim() && clearancesReady(clearance) && (!past || left)

  return (
    <Modal open={open} onClose={onClose} title="Initiate exit" width={640}>
      <div style={grid}>
        <label className="field" style={{ gridColumn: '1 / -1' }}><span>Employee *</span>
          <select className="input" value={f.employeeId} onChange={(e) => set('employeeId', e.target.value)}>
            <option value="">Select employee</option>
            {employees.filter((e) => e.active !== false).map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName} ({e.employeeCode})</option>)}
          </select>
        </label>
        <label className="field"><span>Exit type *</span><MasterSelect list="exit_type" className="input" value={f.exitType} onChange={(v) => set('exitType', v)} /></label>
        <label className="field"><span>Notice shortfall</span>
          <select className="input" value={f.shortfallAction} onChange={(e) => set('shortfallAction', e.target.value)}>
            <option value="">Default ({endedBy === 'employee' ? 'recover from employee' : 'pay in lieu'})</option>
            <option value="recover">Recover from employee</option>
            <option value="buyout">Pay in lieu (buyout)</option>
            <option value="waive">Waive</option>
          </select>
        </label>
        <label className="field"><span>Notice date *</span><input type="date" className="input" value={f.noticeDate} onChange={(e) => set('noticeDate', e.target.value)} /></label>
        <label className="field"><span>Last working day *</span><input type="date" className="input" value={f.lastWorkingDate} min={f.noticeDate || undefined} onChange={(e) => set('lastWorkingDate', e.target.value)} /></label>
        <label className="field"><span>Main reason</span><MasterSelect list="exit_reason" className="input" value={reasonCode} placeholder="Choose…" onChange={(v) => { setReasonCode(v); if (!f.reason.trim() || f.reason === master('exit_reason', reasonCode)) set('reason', master('exit_reason', v)) }} /></label>
        <label className="field" style={{ gridColumn: '1 / -1' }}><span>Reason *</span><textarea className="input" style={{ minHeight: 60, height: 'auto', padding: 12 }} value={f.reason} onChange={(e) => set('reason', e.target.value)} /></label>
      </div>
      {past && (
        <label className="well" style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: 12, marginTop: 14, fontSize: 13 }}>
          <input type="checkbox" checked={left} onChange={(e) => setLeft(e.target.checked)} style={{ marginTop: 3 }} />
          <span><strong>The person has already left.</strong> The last working day is in the past, so this exit is backdated. Tick to confirm.</span>
        </label>
      )}

      <ClearanceFields users={users} exitingUserId={exiting?.userId} value={clearance} onChange={setClearance} />

      {error && <div role="alert" className="pill danger" style={{ marginTop: 14, whiteSpace: 'normal', textTransform: 'none' }}>{error}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20, flexWrap: 'wrap' }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={!ready || initiate.isPending}>{initiate.isPending ? 'Saving…' : 'Initiate exit'}</button>
      </div>
    </Modal>
  )
}
