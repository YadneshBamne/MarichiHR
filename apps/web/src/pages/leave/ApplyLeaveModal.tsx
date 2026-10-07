import { useState } from 'react'
import Modal from '../../components/ui/Modal'
import { FormField, inputStyle, selectStyle } from '../../components/ui/FormField'
import { useLeaveTypes, useMyLeaveBalances, useApplyLeave } from '../../lib/hooks/useLeave'

interface Props {
  open: boolean
  onClose: () => void
}

function getWorkingDays(start: string, end: string): number {
  if (!start || !end) return 0
  const s = new Date(start)
  const e = new Date(end)
  if (s > e) return 0
  let count = 0
  const cur = new Date(s)
  while (cur <= e) {
    const dow = cur.getDay()
    if (dow !== 0 && dow !== 6) count++
    cur.setDate(cur.getDate() + 1)
  }
  return count
}

export default function ApplyLeaveModal({ open, onClose }: Props) {
  const { data: leaveTypes = [] } = useLeaveTypes()
  const { data: balances = [] } = useMyLeaveBalances()
  const applyLeave = useApplyLeave()

  const [form, setForm] = useState({
    leaveTypeId: '',
    startDate: '',
    endDate: '',
    startHalf: '',
    endHalf: '',
    reason: '',
  })
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

  const selectedBalance = balances.find((b: any) => b.leaveTypeId === form.leaveTypeId)
  const selectedType = leaveTypes.find((t: any) => t.id === form.leaveTypeId)
  const workingDays = getWorkingDays(form.startDate, form.endDate)
  const available = selectedBalance
    ? Math.max(0, selectedBalance.balanceDays - selectedBalance.usedDays - selectedBalance.pendingDays)
    : null
  const insufficient = available !== null && selectedType?.isPaid && workingDays > available

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!form.leaveTypeId || !form.startDate || !form.endDate) {
      setError('Please fill in all required fields')
      return
    }
    if (insufficient) {
      setError(`Insufficient balance. Available: ${available?.toFixed(1)} days, Requested: ${workingDays} days`)
      return
    }
    try {
      await applyLeave.mutateAsync({
        leaveTypeId: form.leaveTypeId,
        startDate: form.startDate,
        endDate: form.endDate,
        startHalf: form.startHalf || undefined,
        endHalf: form.endHalf || undefined,
        reason: form.reason || undefined,
      })
      setSuccess(true)
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Failed to apply for leave')
    }
  }

  const handleClose = () => {
    setForm({ leaveTypeId: '', startDate: '', endDate: '', startHalf: '', endHalf: '', reason: '' })
    setError('')
    setSuccess(false)
    onClose()
  }

  if (success) {
    return (
      <Modal open={open} onClose={handleClose} title="Leave Applied">
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <div style={{ fontSize: '32px', marginBottom: '12px' }}>✅</div>
          <div style={{ fontSize: '16px', fontWeight: '500', color: '#1a1a18', marginBottom: '6px' }}>Leave request submitted</div>
          <div style={{ fontSize: '13px', color: '#5c5c58', marginBottom: '20px' }}>
            Your manager has been notified and will action it within 24 hours.
          </div>
          <button onClick={handleClose} style={{ padding: '9px 24px', backgroundColor: '#534AB7', color: '#fff', border: 'none', borderRadius: '6px', fontSize: '13px', cursor: 'pointer' }}>
            Done
          </button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal open={open} onClose={handleClose} title="Apply for Leave" width={520}>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <FormField label="Leave type" required>
          <select style={selectStyle} value={form.leaveTypeId} onChange={(e) => setForm({ ...form, leaveTypeId: e.target.value })} required>
            <option value="">Select leave type...</option>
            {leaveTypes.map((t: any) => (
              <option key={t.id} value={t.id}>{t.name} {t.isPaid ? '' : '(Unpaid)'}</option>
            ))}
          </select>
        </FormField>

        {form.leaveTypeId && available !== null && (
          <div style={{
            padding: '10px 12px', borderRadius: '6px',
            backgroundColor: insufficient ? '#faece7' : '#e1f5ee',
            border: `0.5px solid ${insufficient ? '#f5c6b8' : '#b8e8d4'}`,
            fontSize: '13px',
            color: insufficient ? '#993C1D' : '#0F6E56',
          }}>
            Balance available: <strong>{available.toFixed(1)} days</strong>
            {workingDays > 0 && ` · Requesting: ${workingDays} working day${workingDays !== 1 ? 's' : ''}`}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
          <FormField label="Start date" required>
            <input style={inputStyle} type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} required />
          </FormField>
          <FormField label="End date" required>
            <input style={inputStyle} type="date" value={form.endDate} min={form.startDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} required />
          </FormField>
        </div>

        {selectedType?.halfDayAllowed && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
            <FormField label="Start half">
              <select style={selectStyle} value={form.startHalf} onChange={(e) => setForm({ ...form, startHalf: e.target.value })}>
                <option value="">Full day</option>
                <option value="first_half">First half</option>
                <option value="second_half">Second half</option>
              </select>
            </FormField>
            <FormField label="End half">
              <select style={selectStyle} value={form.endHalf} onChange={(e) => setForm({ ...form, endHalf: e.target.value })}>
                <option value="">Full day</option>
                <option value="first_half">First half</option>
                <option value="second_half">Second half</option>
              </select>
            </FormField>
          </div>
        )}

        <FormField label="Reason">
          <textarea
            style={{ ...inputStyle, resize: 'vertical' }}
            rows={2}
            value={form.reason}
            onChange={(e) => setForm({ ...form, reason: e.target.value })}
            placeholder="Optional — add a reason for your leave"
          />
        </FormField>

        {error && (
          <div style={{ backgroundColor: '#faece7', color: '#993C1D', borderRadius: '6px', padding: '10px 12px', fontSize: '13px', border: '0.5px solid #f5c6b8' }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <button type="button" onClick={handleClose} style={{ padding: '9px 18px', backgroundColor: '#f5f4f0', border: '0.5px solid #e2e0da', borderRadius: '6px', fontSize: '13px', cursor: 'pointer' }}>
            Cancel
          </button>
          <button type="submit" disabled={applyLeave.isPending || !!insufficient} style={{ padding: '9px 18px', backgroundColor: '#534AB7', color: '#fff', border: 'none', borderRadius: '6px', fontSize: '13px', fontWeight: '500', cursor: 'pointer', opacity: applyLeave.isPending || insufficient ? 0.6 : 1 }}>
            {applyLeave.isPending ? 'Submitting...' : 'Submit Request'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
