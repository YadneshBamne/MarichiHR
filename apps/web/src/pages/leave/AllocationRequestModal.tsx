import { useState } from 'react'
import Modal from '../../components/ui/Modal'
import { FormField, inputStyle, selectStyle } from '../../components/ui/FormField'
import { useLeaveTypes, useRequestAllocation } from '../../lib/hooks/useLeave'

interface Props {
  open: boolean
  onClose: () => void
}

export default function AllocationRequestModal({ open, onClose }: Props) {
  const { data: leaveTypes = [] } = useLeaveTypes()
  const requestAllocation = useRequestAllocation()
  const [form, setForm] = useState({ leaveTypeId: '', requestedDays: '', reason: '' })
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    try {
      await requestAllocation.mutateAsync({
        leaveTypeId: form.leaveTypeId,
        requestedDays: parseFloat(form.requestedDays),
        reason: form.reason,
      })
      setSuccess(true)
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Failed to submit request')
    }
  }

  const handleClose = () => {
    setForm({ leaveTypeId: '', requestedDays: '', reason: '' })
    setError('')
    setSuccess(false)
    onClose()
  }

  if (success) {
    return (
      <Modal open={open} onClose={handleClose} title="Request Submitted">
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <div style={{ fontSize: '32px', marginBottom: '12px' }}>✅</div>
          <div style={{ fontSize: '15px', fontWeight: '500', marginBottom: '6px', color: '#1a1a18' }}>Allocation request submitted</div>
          <div style={{ fontSize: '13px', color: '#5c5c58', marginBottom: '20px' }}>Your manager will review and credit the days to your balance.</div>
          <button onClick={handleClose} style={{ padding: '9px 24px', backgroundColor: '#534AB7', color: '#fff', border: 'none', borderRadius: '6px', fontSize: '13px', cursor: 'pointer' }}>Done</button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal open={open} onClose={handleClose} title="Request Leave Allocation" width={460}>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <p style={{ fontSize: '13px', color: '#5c5c58', margin: 0 }}>
          Use this to request comp-off credits, carry-forward exceptions, or any leave allocation that needs manager approval.
        </p>

        <FormField label="Leave type" required>
          <select style={selectStyle} value={form.leaveTypeId} onChange={(e) => setForm({ ...form, leaveTypeId: e.target.value })} required>
            <option value="">Select...</option>
            {leaveTypes.map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </FormField>

        <FormField label="Days requested" required>
          <input style={inputStyle} type="number" min="0.5" step="0.5" value={form.requestedDays} onChange={(e) => setForm({ ...form, requestedDays: e.target.value })} required placeholder="e.g. 1 or 0.5" />
        </FormField>

        <FormField label="Reason" required>
          <textarea style={{ ...inputStyle, resize: 'vertical' }} rows={3} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} required placeholder="Explain why you need this allocation..." />
        </FormField>

        {error && <div style={{ backgroundColor: '#faece7', color: '#993C1D', borderRadius: '6px', padding: '10px 12px', fontSize: '13px' }}>{error}</div>}

        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <button type="button" onClick={handleClose} style={{ padding: '9px 18px', backgroundColor: '#f5f4f0', border: '0.5px solid #e2e0da', borderRadius: '6px', fontSize: '13px', cursor: 'pointer' }}>Cancel</button>
          <button type="submit" disabled={requestAllocation.isPending} style={{ padding: '9px 18px', backgroundColor: '#534AB7', color: '#fff', border: 'none', borderRadius: '6px', fontSize: '13px', fontWeight: '500', cursor: 'pointer', opacity: requestAllocation.isPending ? 0.7 : 1 }}>
            {requestAllocation.isPending ? 'Submitting...' : 'Submit Request'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
