import { useState } from 'react'
import Badge from '../../components/ui/Badge'
import Modal from '../../components/ui/Modal'
import { useAuth } from '../../contexts/AuthContext'
import { useUpdateBank, useVerifyBank } from '../../lib/hooks/useEmployees'
import MasterSelect from '../../components/ui/MasterSelect'
import { useMasters } from '../../lib/hooks/useMasters'

// Bank details of one person. HR (and system admins) enter them; a payroll admin verifies them, and never the same person who entered them.
export default function BankDetailsCard({ employee }: { employee: any }) {
  const { hasRole } = useAuth()
  const canEdit = hasRole('hr_admin') || hasRole('system_admin')
  const canVerify = hasRole('payroll_admin')
  const update = useUpdateBank(employee.id)
  const verify = useVerifyBank(employee.id)
  const [editing, setEditing] = useState(false)
  const { label: master } = useMasters()
  const [form, setForm] = useState({ bankName: '', bankAccountNo: '', bankIfscSwift: '' })
  const [error, setError] = useState('')
  const [verifyError, setVerifyError] = useState('')

  const hasDetails = !!employee.bankName && !!employee.bankAccountLast4

  const openEdit = () => {
    setError('')
    setForm({ bankName: employee.bankName || '', bankAccountNo: '', bankIfscSwift: employee.bankIfscSwift || '' })
    setEditing(true)
  }

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    try {
      await update.mutateAsync({
        bankName: form.bankName.trim(),
        bankAccountNo: form.bankAccountNo.trim(),
        bankIfscSwift: form.bankIfscSwift.trim() || undefined,
      })
      setEditing(false)
      setForm({ bankName: '', bankAccountNo: '', bankIfscSwift: '' })
    } catch (err: any) {
      const issues = err?.response?.data?.errors
      setError(err?.response?.data?.message || (Array.isArray(issues) && issues[0]?.message) || 'Failed to save bank details')
    }
  }

  const doVerify = async () => {
    setVerifyError('')
    try {
      await verify.mutateAsync()
    } catch (err: any) {
      setVerifyError(err?.response?.data?.message || 'Verification failed')
    }
  }

  return (
    <div style={{ gridColumn: '1 / -1', marginTop: 16 }}>
      <div className="dim" style={{ fontSize: 11, fontWeight: 500, marginBottom: 8 }}>Bank details</div>
      <div className="well" style={{ padding: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {hasDetails ? (
            <div>
              <div style={{ fontSize: 15, fontWeight: 500 }}>{master('bank', employee.bankName)} <span className="dim" style={{ fontWeight: 400 }}>•••• {employee.bankAccountLast4}</span></div>
              {employee.bankIfscSwift && <div className="dim" style={{ fontSize: 12, marginTop: 2 }}>{employee.bankIfscSwift}</div>}
            </div>
          ) : (
            <div className="dim" style={{ fontSize: 13 }}>No bank details on file.</div>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {hasDetails && <Badge label={employee.bankVerified ? 'Verified' : 'Unverified'} variant={employee.bankVerified ? 'approved' : 'pending'} />}
            {canVerify && hasDetails && !employee.bankVerified && (
              <button type="button" className="btn btn-primary btn-sm" onClick={doVerify} disabled={verify.isPending}>{verify.isPending ? 'Verifying…' : 'Verify'}</button>
            )}
            {canEdit && <button type="button" className="btn btn-ghost btn-sm" onClick={openEdit}>{hasDetails ? 'Edit' : 'Add'}</button>}
          </div>
        </div>
        {verifyError && <div role="alert" style={{ marginTop: 10, background: 'var(--danger-bg)', color: 'var(--danger)', borderRadius: 12, padding: '8px 10px', fontSize: 12 }}>{verifyError}</div>}
        {hasDetails && !employee.bankVerified && !verifyError && (
          <div className="dim" style={{ marginTop: 8, fontSize: 12 }}>{canVerify ? 'You can verify these unless you entered them: it takes a different person.' : 'A payroll admin verifies these details (a different person from whoever entered them). Nothing is paid to an unverified account.'}</div>
        )}
      </div>

      {canEdit && (
        <Modal open={editing} onClose={() => setEditing(false)} title="Bank details" width={440}>
          <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <label className="field"><span>Bank</span><MasterSelect list="bank" value={form.bankName} onChange={(v) => setForm({ ...form, bankName: v })} placeholder="Choose a bank" required /></label>
            <label className="field"><span>Account number</span>
              <input className="input" inputMode="numeric" autoComplete="off" pattern="\d{6,34}" title="6 to 34 digits" placeholder={hasDetails ? 'Enter the full number to replace' : ''} value={form.bankAccountNo} onChange={(e) => setForm({ ...form, bankAccountNo: e.target.value })} required />
            </label>
            <label className="field"><span>SWIFT / branch code</span><input className="input" maxLength={20} value={form.bankIfscSwift} onChange={(e) => setForm({ ...form, bankIfscSwift: e.target.value })} /></label>
            <div className="dim" style={{ fontSize: 12 }}>The account number is write-only and is never shown again. Saving resets verification.</div>
            {error && <div role="alert" style={{ background: 'var(--danger-bg)', color: 'var(--danger)', borderRadius: 12, padding: '10px 12px', fontSize: 13 }}>{error}</div>}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={update.isPending}>{update.isPending ? 'Saving…' : 'Save'}</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  )
}
