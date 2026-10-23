import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import api from '../../lib/api'
import Modal from '../../components/ui/Modal'
import { FormField, inputStyle, selectStyle } from '../../components/ui/FormField'
import { useLeaveTypes, useMyLeaveBalances, useApplyLeave } from '../../lib/hooks/useLeave'
import { useAuth } from '../../contexts/AuthContext'

interface Props {
  open: boolean
  onClose: () => void
}

// Weekdays in the range minus public holidays (date-only values: UTC throughout); matches the server's count
function getWorkingDays(start: string, end: string, holidays: Set<string>): number {
  if (!start || !end || start > end) return 0
  let count = 0
  for (let cur = new Date(`${start}T00:00:00Z`); cur <= new Date(`${end}T00:00:00Z`); cur = new Date(cur.getTime() + 86_400_000)) {
    const day = cur.toISOString().slice(0, 10)
    if (cur.getUTCDay() !== 0 && cur.getUTCDay() !== 6 && !holidays.has(day)) count++
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
  const { user } = useAuth()
  const [cert, setCert] = useState<{ id: string; name: string } | null>(null)
  const [uploading, setUploading] = useState(false)

  const selectedBalance = balances.find((b: any) => b.leaveTypeId === form.leaveTypeId)
  const selectedType = leaveTypes.find((t: any) => t.id === form.leaveTypeId)
  const ranged = !!form.startDate && !!form.endDate && form.startDate <= form.endDate
  const { data: holidaysInRange = [] } = useQuery({
    queryKey: ['holidays-mine', form.startDate, form.endDate],
    queryFn: async () => (await api.get('/holidays/mine', { params: { from: form.startDate, to: form.endDate } })).data.data as { date: string; name: string; isOptional: boolean }[],
    enabled: ranged,
  })
  const offDays = holidaysInRange.filter((h) => !h.isOptional)
  // Teammates already off, and blackout dates, for the chosen range (a heads-up before submitting)
  const { data: overlaps = [] } = useQuery({ queryKey: ['leave-overlap', form.startDate, form.endDate], enabled: ranged, queryFn: async () => (await api.get('/leave/overlap', { params: { startDate: form.startDate, endDate: form.endDate } })).data.data as { name: string; startDate: string; endDate: string; status: string }[] })
  const { data: blackouts = [] } = useQuery({ queryKey: ['leave-blackouts'], queryFn: async () => (await api.get('/leave/blackouts')).data.data as { name: string; startDate: string; endDate: string; leaveTypeIds: string[] }[] })
  const blackout = ranged ? blackouts.find((b) => b.startDate <= form.endDate && b.endDate >= form.startDate && (!b.leaveTypeIds.length || b.leaveTypeIds.includes(form.leaveTypeId))) : undefined
  const uploadCert = async (file: File) => {
    if (!user?.employee?.id) return
    setUploading(true); setError('')
    try {
      const fd = new FormData()
      fd.append('file', file); fd.append('category', 'medical'); fd.append('title', `Medical certificate ${form.startDate || ''}`.trim())
      const doc = (await api.post(`/employees/${user.employee.id}/documents`, fd)).data.data
      setCert({ id: doc.id, name: file.name })
    } catch (err: any) { setError(err?.response?.data?.message || 'Could not upload the certificate') } finally { setUploading(false) }
  }
  const workingDays = getWorkingDays(form.startDate, form.endDate, new Set(offDays.map((h) => h.date)))
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
        ...(cert && { attachmentDocumentId: cert.id }),
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
    setCert(null)
    onClose()
  }

  if (success) {
    return (
      <Modal open={open} onClose={handleClose} title="Leave Applied">
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <div style={{ fontSize: '32px', marginBottom: '12px' }}>✅</div>
          <div style={{ fontSize: '16px', fontWeight: '500', color: 'var(--ink)', marginBottom: '6px' }}>Leave request submitted</div>
          <div style={{ fontSize: '13px', color: 'var(--dim)', marginBottom: '20px' }}>
            Your manager has been notified and will action it within 24 hours.
          </div>
          <button onClick={handleClose} style={{ padding: '9px 24px', backgroundColor: 'var(--brand)', color: 'var(--night-ink)', border: 'none', borderRadius: '12px', fontSize: '13px', cursor: 'pointer' }}>
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
            padding: '10px 12px', borderRadius: '12px',
            backgroundColor: insufficient ? 'var(--danger-bg)' : 'var(--ok-bg)',
            border: `1px solid ${insufficient ? 'var(--danger-line)' : 'var(--ok-line)'}`,
            fontSize: '13px',
            color: insufficient ? 'var(--danger)' : 'var(--ok)',
          }}>
            Balance available: <strong>{available.toFixed(1)} days</strong>
            {workingDays > 0 && ` · Requesting: ${workingDays} working day${workingDays !== 1 ? 's' : ''}`}
            {ranged && offDays.length > 0 && ` · ${offDays.map((h) => h.name).join(', ')} ${offDays.length === 1 ? 'is a holiday' : 'are holidays'} (not counted)`}
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

        {blackout && (
          <div style={{ padding: '10px 12px', borderRadius: '12px', backgroundColor: 'var(--danger-bg)', color: 'var(--danger)', fontSize: '13px' }}>
            {blackout.startDate} to {blackout.endDate} is a blackout period ({blackout.name}): this leave can't be taken then.
          </div>
        )}
        {overlaps.length > 0 && (
          <div style={{ padding: '10px 12px', borderRadius: '12px', backgroundColor: 'var(--honey-soft)', fontSize: '13px' }}>
            Also off then: {overlaps.map((o) => `${o.name} (${o.startDate === o.endDate ? o.startDate : `${o.startDate} – ${o.endDate}`}${o.status === 'pending' ? ', pending' : ''})`).join(', ')}. You can still apply.
          </div>
        )}

        {(selectedType?.attachmentRequiredAfterDays != null || cert) && (
          <FormField label={selectedType?.attachmentRequiredAfterDays != null && workingDays > selectedType.attachmentRequiredAfterDays ? 'Certificate (required for this many days)' : 'Certificate (optional)'}>
            <label style={{ ...inputStyle, display: 'flex', alignItems: 'center', cursor: 'pointer' } as any}>
              <span style={{ flex: 1 }}>{uploading ? 'Uploading…' : cert ? `Attached: ${cert.name}` : 'Choose a PDF or photo'}</span>
              <input type="file" hidden accept=".pdf,.jpg,.jpeg,.png,.webp" onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadCert(f); e.target.value = '' }} />
            </label>
          </FormField>
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
          <div style={{ backgroundColor: 'var(--danger-bg)', color: 'var(--danger)', borderRadius: '12px', padding: '10px 12px', fontSize: '13px', border: '1px solid var(--danger-line)' }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <button type="button" onClick={handleClose} style={{ padding: '9px 18px', backgroundColor: 'var(--well)', border: '1px solid var(--line)', borderRadius: '12px', fontSize: '13px', cursor: 'pointer' }}>
            Cancel
          </button>
          <button type="submit" disabled={applyLeave.isPending || !!insufficient || !!blackout || uploading} style={{ padding: '9px 18px', backgroundColor: 'var(--brand)', color: 'var(--night-ink)', border: 'none', borderRadius: '12px', fontSize: '13px', fontWeight: '500', cursor: 'pointer', opacity: applyLeave.isPending || insufficient ? 0.6 : 1 }}>
            {applyLeave.isPending ? 'Submitting...' : 'Submit Request'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
