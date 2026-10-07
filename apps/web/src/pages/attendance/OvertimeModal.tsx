import { useState } from 'react'
import Modal from '../../components/ui/Modal'
import { FormField, inputStyle } from '../../components/ui/FormField'
import { useRequestOvertime } from '../../lib/hooks/useAttendance'

interface Props {
  open: boolean
  onClose: () => void
}

export default function OvertimeModal({ open, onClose }: Props) {
  const requestOT = useRequestOvertime()
  const today = new Date().toISOString().split('T')[0]
  const [form, setForm] = useState({ date: today, overtimeHours: '', reason: '' })
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    try {
      await requestOT.mutateAsync({
        date: form.date,
        overtimeHours: parseFloat(form.overtimeHours),
        reason: form.reason,
      })
      setSuccess(true)
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Failed to submit')
    }
  }

  const handleClose = () => {
    setForm({ date: today, overtimeHours: '', reason: '' })
    setError('')
    setSuccess(false)
    onClose()
  }

  if (success) {
    return (
      <Modal open={open} onClose={handleClose} title="Overtime Requested">
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <div style={{ fontSize: '32px', marginBottom: '12px' }}>✅</div>
          <div style={{ fontSize: '15px', fontWeight: '500', color: 'var(--ink)', marginBottom: '6px' }}>Overtime request submitted</div>
          <div style={{ fontSize: '13px', color: 'var(--dim)', marginBottom: '20px' }}>Your manager will review and approve the hours.</div>
          <button onClick={handleClose} style={{ padding: '9px 24px', backgroundColor: 'var(--brand)', color: 'var(--night-ink)', border: 'none', borderRadius: '12px', fontSize: '13px', cursor: 'pointer' }}>Done</button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal open={open} onClose={handleClose} title="Request Overtime" width={420}>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
          <FormField label="Date" required>
            <input style={inputStyle} type="date" value={form.date} max={today}
              onChange={(e) => setForm({ ...form, date: e.target.value })} required />
          </FormField>
          <FormField label="Overtime hours" required>
            <input style={inputStyle} type="number" min="0.5" step="0.5" max="12"
              value={form.overtimeHours} placeholder="e.g. 2.5"
              onChange={(e) => setForm({ ...form, overtimeHours: e.target.value })} required />
          </FormField>
        </div>

        <FormField label="Reason" required>
          <textarea style={{ ...inputStyle, resize: 'vertical' } as React.CSSProperties}
            rows={3} value={form.reason} required
            onChange={(e) => setForm({ ...form, reason: e.target.value })}
            placeholder="e.g. Client deliverable due at midnight" />
        </FormField>

        {error && <div style={{ backgroundColor: 'var(--danger-bg)', color: 'var(--danger)', borderRadius: '12px', padding: '10px 12px', fontSize: '13px' }}>{error}</div>}

        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <button type="button" onClick={handleClose} style={{ padding: '9px 18px', backgroundColor: 'var(--well)', border: '1px solid var(--line)', borderRadius: '12px', fontSize: '13px', cursor: 'pointer' }}>Cancel</button>
          <button type="submit" disabled={requestOT.isPending} style={{ padding: '9px 18px', backgroundColor: 'var(--brand)', color: 'var(--night-ink)', border: 'none', borderRadius: '12px', fontSize: '13px', fontWeight: '500', cursor: 'pointer', opacity: requestOT.isPending ? 0.7 : 1 }}>
            {requestOT.isPending ? 'Submitting...' : 'Submit Request'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
