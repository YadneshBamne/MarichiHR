import { useState } from 'react'
import Badge from '../../components/ui/Badge'
import Modal from '../../components/ui/Modal'
import { FormField, inputStyle } from '../../components/ui/FormField'
import { useUpdateBank, useVerifyBank } from '../../lib/hooks/useEmployees'

export default function BankDetailsCard({ employee }: { employee: any }) {
  const update = useUpdateBank(employee.id)
  const verify = useVerifyBank(employee.id)
  const [editing, setEditing] = useState(false)
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
    <div style={{ gridColumn: '1 / -1', marginTop: '16px' }}>
      <div style={{ fontSize: 11, color: '#8c8c88', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 8 }}>Bank details</div>
      <div style={{ backgroundColor: '#f9f8f6', border: '0.5px solid #e2e0da', borderRadius: 8, padding: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          {hasDetails ? (
            <div>
              <div style={{ fontSize: 15, fontWeight: 500 }}>{employee.bankName} <span style={{ color: '#5c5c58', fontWeight: 400 }}>•••• {employee.bankAccountLast4}</span></div>
              {employee.bankIfscSwift && <div style={{ fontSize: 12, color: '#8c8c88', marginTop: 2 }}>{employee.bankIfscSwift}</div>}
            </div>
          ) : (
            <div style={{ fontSize: 13, color: '#8c8c88' }}>No bank details on file.</div>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {hasDetails && <Badge label={employee.bankVerified ? 'Verified' : 'Unverified'} variant={employee.bankVerified ? 'approved' : 'pending'} />}
            {hasDetails && !employee.bankVerified && (
              <button onClick={doVerify} disabled={verify.isPending} style={{ padding: '6px 14px', backgroundColor: '#e1f5ee', color: '#0F6E56', border: '0.5px solid #b8e8d4', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}>
                {verify.isPending ? 'Verifying...' : 'Verify'}
              </button>
            )}
            <button onClick={openEdit} style={{ padding: '6px 14px', backgroundColor: '#fff', border: '0.5px solid #e2e0da', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}>{hasDetails ? 'Edit' : 'Add'}</button>
          </div>
        </div>
        {verifyError && <div style={{ marginTop: 10, backgroundColor: '#faece7', color: '#993C1D', borderRadius: 6, padding: '8px 10px', fontSize: 12 }}>{verifyError}</div>}
        {hasDetails && !employee.bankVerified && !verifyError && (
          <div style={{ marginTop: 8, fontSize: 11, color: '#8c8c88' }}>Must be verified by a different user than the one who entered the details.</div>
        )}
      </div>

      <Modal open={editing} onClose={() => setEditing(false)} title="Bank details" width={440}>
        <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <FormField label="Bank name" required><input style={inputStyle} value={form.bankName} onChange={(e) => setForm({ ...form, bankName: e.target.value })} required /></FormField>
          <FormField label="Account number" required>
            <input style={inputStyle} inputMode="numeric" autoComplete="off" pattern="\d{6,34}" title="6 to 34 digits" placeholder={hasDetails ? 'Enter the full number to replace' : ''} value={form.bankAccountNo} onChange={(e) => setForm({ ...form, bankAccountNo: e.target.value })} required />
          </FormField>
          <FormField label="SWIFT / branch code"><input style={inputStyle} value={form.bankIfscSwift} onChange={(e) => setForm({ ...form, bankIfscSwift: e.target.value })} /></FormField>
          <div style={{ fontSize: 12, color: '#8c8c88' }}>The account number is write-only and is never shown again. Saving resets verification.</div>
          {error && <div style={{ backgroundColor: '#faece7', color: '#993C1D', borderRadius: 6, padding: '10px 12px', fontSize: 13 }}>{error}</div>}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button type="button" onClick={() => setEditing(false)} style={{ padding: '9px 18px', backgroundColor: '#f5f4f0', border: '0.5px solid #e2e0da', borderRadius: 6, fontSize: 13, cursor: 'pointer' }}>Cancel</button>
            <button type="submit" disabled={update.isPending} style={{ padding: '9px 18px', backgroundColor: '#534AB7', color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 500, cursor: 'pointer', opacity: update.isPending ? 0.7 : 1 }}>{update.isPending ? 'Saving...' : 'Save'}</button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
