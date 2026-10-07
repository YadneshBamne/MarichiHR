import { useState } from 'react'
import Modal from '../../components/ui/Modal'
import { FormField, inputStyle } from '../../components/ui/FormField'
import { useCreateCycle } from '../../lib/hooks/usePayroll'

function monthDefaults() {
  const now = new Date()
  const y = now.getFullYear(), m = now.getMonth()
  const pad = (n: number) => String(n).padStart(2, '0')
  const last = new Date(y, m + 1, 0).getDate()
  return { start: `${y}-${pad(m + 1)}-01`, end: `${y}-${pad(m + 1)}-${pad(last)}` }
}

export default function CreateCycleModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const create = useCreateCycle()
  const d = monthDefaults()
  const [start, setStart] = useState(d.start)
  const [end, setEnd] = useState(d.end)
  const [error, setError] = useState('')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    try {
      const cycle = await create.mutateAsync({ payPeriodStart: start, payPeriodEnd: end })
      onClose()
      onCreated(cycle.id)
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Failed to create cycle')
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="New Payroll Cycle" width={440}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <FormField label="Period start" required><input style={inputStyle} type="date" value={start} onChange={(e) => setStart(e.target.value)} required /></FormField>
          <FormField label="Period end" required><input style={inputStyle} type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} required /></FormField>
        </div>
        {error && <div style={{ backgroundColor: 'var(--danger-bg)', color: 'var(--danger)', borderRadius: 12, padding: '10px 12px', fontSize: 13 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose} style={{ padding: '9px 18px', backgroundColor: 'var(--well)', border: '1px solid var(--line)', borderRadius: 12, fontSize: 13, cursor: 'pointer' }}>Cancel</button>
          <button type="submit" disabled={create.isPending} style={{ padding: '9px 18px', backgroundColor: 'var(--brand)', color: 'var(--night-ink)', border: 'none', borderRadius: 12, fontSize: 13, fontWeight: 500, cursor: 'pointer', opacity: create.isPending ? 0.7 : 1 }}>
            {create.isPending ? 'Creating...' : 'Create Cycle'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
