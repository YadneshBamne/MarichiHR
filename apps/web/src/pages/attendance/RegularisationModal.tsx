import { useState } from 'react'
import Modal from '../../components/ui/Modal'
import { FormField, inputStyle } from '../../components/ui/FormField'
import { useRaiseRegularisation } from '../../lib/hooks/useAttendance'

interface Props {
  open: boolean
  onClose: () => void
  prefillDate?: string
}

export default function RegularisationModal({ open, onClose, prefillDate }: Props) {
  const raise = useRaiseRegularisation()
  const today = new Date().toISOString().split('T')[0]
  const [form, setForm] = useState({
    date: prefillDate || today,
    actualIn: '09:00',
    actualOut: '18:00',
    reason: '',
  })
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    try {
      await raise.mutateAsync(form)
      setSuccess(true)
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Failed to submit regularisation')
    }
  }

  const handleClose = () => {
    setForm({ date: prefillDate || today, actualIn: '09:00', actualOut: '18:00', reason: '' })
    setError('')
    setSuccess(false)
    onClose()
  }

  if (success) {
    return (
      <Modal open={open} onClose={handleClose} title="Regularisation Submitted">
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <div style={{ fontSize: '32px', marginBottom: '12px' }}>✅</div>
          <div style={{ fontSize: '15px', fontWeight: '500', color: 'var(--ink)', marginBottom: '6px' }}>Request submitted</div>
          <div style={{ fontSize: '13px', color: 'var(--dim)', marginBottom: '20px' }}>Your manager will review and correct your attendance record.</div>
          <button onClick={handleClose} style={{ padding: '9px 24px', backgroundColor: 'var(--brand)', color: 'var(--night-ink)', border: 'none', borderRadius: '12px', fontSize: '13px', cursor: 'pointer' }}>Done</button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal open={open} onClose={handleClose} title="Raise Attendance Regularisation" width={460}>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <p style={{ fontSize: '13px', color: 'var(--dim)', margin: 0 }}>
          Use this if you forgot to punch in/out or the system recorded incorrect times.
        </p>

        <FormField label="Date" required>
          <input style={inputStyle} type="date" value={form.date} max={today}
            onChange={(e) => setForm({ ...form, date: e.target.value })} required />
        </FormField>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
          <FormField label="Actual clock-in time" required>
            <input style={inputStyle} type="time" value={form.actualIn}
              onChange={(e) => setForm({ ...form, actualIn: e.target.value })} required />
          </FormField>
          <FormField label="Actual clock-out time" required>
            <input style={inputStyle} type="time" value={form.actualOut}
              onChange={(e) => setForm({ ...form, actualOut: e.target.value })} required />
          </FormField>
        </div>

        <FormField label="Reason" required>
          <textarea style={{ ...inputStyle, resize: 'vertical' } as React.CSSProperties}
            rows={3} value={form.reason} required
            onChange={(e) => setForm({ ...form, reason: e.target.value })}
            placeholder="e.g. Forgot to punch in — was working from the site office" />
        </FormField>

        {error && <div style={{ backgroundColor: 'var(--danger-bg)', color: 'var(--danger)', borderRadius: '12px', padding: '10px 12px', fontSize: '13px' }}>{error}</div>}

        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <button type="button" onClick={handleClose} style={{ padding: '9px 18px', backgroundColor: 'var(--well)', border: '1px solid var(--line)', borderRadius: '12px', fontSize: '13px', cursor: 'pointer' }}>Cancel</button>
          <button type="submit" disabled={raise.isPending} style={{ padding: '9px 18px', backgroundColor: 'var(--brand)', color: 'var(--night-ink)', border: 'none', borderRadius: '12px', fontSize: '13px', fontWeight: '500', cursor: 'pointer', opacity: raise.isPending ? 0.7 : 1 }}>
            {raise.isPending ? 'Submitting...' : 'Submit Request'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
