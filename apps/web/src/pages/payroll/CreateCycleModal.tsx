import { useState } from 'react'
import Modal from '../../components/ui/Modal'
import { FormField, inputStyle } from '../../components/ui/FormField'
import { useCreateCycle, useCycles } from '../../lib/hooks/usePayroll'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'

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
  const [offCycle, setOffCycle] = useState(false)
  const [entityId, setEntityId] = useState('')
  const [groupId, setGroupId] = useState('')
  const qcCycle = useQueryClient()
  const { data: groups = [] } = useQuery({ queryKey: ['pay-groups'], queryFn: async () => (await api.get('/payroll/pay-groups')).data.data as { id: string; name: string; frequency: string; active: boolean; people: number }[] })
  const { data: entities = [] } = useQuery({ queryKey: ['legal-entities'], queryFn: async () => (await api.get('/company/entities')).data.data as { id: string; name: string; currency: string; active: boolean }[] })
  const [reason, setReason] = useState('')
  const [corrects, setCorrects] = useState('')
  const { data: cycles = [] } = useCycles(offCycle)
  const paid = (cycles as any[]).filter((c) => c.status === 'disbursed' && !c.offCycle)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    try {
      const cycle = await create.mutateAsync({ payPeriodStart: start, payPeriodEnd: end, ...(entityId && { legalEntityId: entityId }), ...(groupId && { payGroupId: groupId }), ...(offCycle && { offCycle: true, reason: reason.trim(), ...(corrects && { correctsCycleId: corrects }) }) })
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
        {groups.some((x) => x.active) && <FormField label="Pay group"><select style={inputStyle} value={groupId} onChange={(e) => setGroupId(e.target.value)}><option value="">All pay groups</option>{groups.filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{x.name} ({x.frequency.replace('_', '-')}, {x.people})</option>)}</select></FormField>}
        <button type="button" className="btn btn-ghost btn-sm" style={{ justifySelf: 'start' }} onClick={async () => { const name = window.prompt('New pay group (e.g. Weekly casual workers)'); if (!name?.trim()) return; const freq = window.prompt('How often are they paid? monthly, bi_weekly or weekly', 'monthly')?.trim(); try { const g = (await api.post('/payroll/pay-groups', { name: name.trim(), frequency: ['monthly', 'bi_weekly', 'weekly'].includes(freq ?? '') ? freq : 'monthly' })).data.data; setGroupId(g.id); qcCycle.invalidateQueries({ queryKey: ['pay-groups'] }) } catch (err: any) { setError(err?.response?.data?.message || 'Could not add the group') } }}>+ Pay group</button>
        {entities.some((x) => x.active) && <FormField label="Who it pays"><select style={inputStyle} value={entityId} onChange={(e) => setEntityId(e.target.value)}><option value="">Everyone in the company</option>{entities.filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{x.name} ({x.currency})</option>)}</select></FormField>}
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13 }}><input type="checkbox" checked={offCycle} onChange={(e) => setOffCycle(e.target.checked)} style={{ marginTop: 3 }} /> <span><strong>Off-cycle run</strong>: pays only the inputs you add to it (a bonus, arrears, a correction). No salary, no attendance lock, same two approvals.</span></label>
        {offCycle && <>
          <FormField label="What is it for?" required><input style={inputStyle} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="e.g. Correction to October: missed overtime" /></FormField>
          <FormField label="Correcting a paid run (optional)"><select style={inputStyle} value={corrects} onChange={(e) => setCorrects(e.target.value)}><option value="">No</option>{paid.map((c: any) => <option key={c.id} value={c.id}>{String(c.payPeriodStart).slice(0, 7)}</option>)}</select></FormField>
        </>}
        {error && <div style={{ backgroundColor: 'var(--danger-bg)', color: 'var(--danger)', borderRadius: 12, padding: '10px 12px', fontSize: 13 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose} style={{ padding: '9px 18px', backgroundColor: 'var(--well)', border: '1px solid var(--line)', borderRadius: 12, fontSize: 13, cursor: 'pointer' }}>Cancel</button>
          <button type="submit" disabled={create.isPending || (offCycle && reason.trim().length < 3)} style={{ padding: '9px 18px', backgroundColor: 'var(--brand)', color: 'var(--night-ink)', border: 'none', borderRadius: 12, fontSize: 13, fontWeight: 500, cursor: 'pointer', opacity: create.isPending ? 0.7 : 1 }}>
            {create.isPending ? 'Creating...' : 'Create Cycle'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
