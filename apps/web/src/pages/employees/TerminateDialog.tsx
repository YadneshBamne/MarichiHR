import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Modal from '../../components/ui/Modal'
import PersonPicker from '../../components/ui/PersonPicker'
import { useArchiveEmployee } from '../../lib/hooks/useEmployees'

// Ending someone's employment. With the Exits app the exit process (notice, clearances, final settlement) starts there;
// without it the person is archived here with a last working day and a reason. Anyone who reports to them needs a new manager first.
export default function TerminateDialog({ employee, hasExits, onClose }: { employee: any; hasExits: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const archive = useArchiveEmployee()
  const reports: any[] = employee.directReports ?? []
  const [lastDay, setLastDay] = useState(new Date().toISOString().slice(0, 10))
  const [reason, setReason] = useState('')
  const [newManager, setNewManager] = useState('')
  const [error, setError] = useState('')
  const name = `${employee.firstName} ${employee.lastName}`

  if (hasExits) {
    return (
      <Modal open onClose={onClose} title={`End ${name}'s employment`} width={480}>
        <div style={{ display: 'grid', gap: 14 }}>
          <p style={{ margin: 0 }}>Your company uses the Exits app, so leaving goes through an exit: notice, the sign-offs from IT, Finance and Admin, and the final settlement. {name} is archived when that is paid.</p>
          {reports.length > 0 && <p className="well" style={{ margin: 0, padding: '10px 14px', fontSize: 13 }}>{reports.length} {reports.length === 1 ? 'person reports' : 'people report'} to {employee.firstName}. They will need a new manager when the exit is paid.</p>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" onClick={() => navigate(`/exits?initiate=${employee.id}`)}>Start the exit</button>
          </div>
        </div>
      </Modal>
    )
  }

  const ready = reason.trim() && lastDay && (reports.length === 0 || newManager)
  const go = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    try { await archive.mutateAsync({ id: employee.id, reason: reason.trim(), lastWorkingDay: lastDay, ...(newManager && { newManagerId: newManager }) }); navigate('/employees') } catch (err: any) { setError(err?.response?.data?.message || 'Could not end this employment') }
  }
  return (
    <Modal open onClose={onClose} title={`End ${name}'s employment`} width={520}>
      <form onSubmit={go} style={{ display: 'grid', gap: 14 }}>
        <p className="dim" style={{ margin: 0, fontSize: 13 }}>{name} is removed from the active lists and their login is switched off. History is kept, and you can reinstate them later.</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
          <label className="field"><span>Last working day</span><input className="input" type="date" required value={lastDay} onChange={(e) => setLastDay(e.target.value)} /></label>
          <label className="field" style={{ gridColumn: '1 / -1' }}><span>Reason</span><textarea className="input" rows={2} required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        </div>
        {reports.length > 0 && (
          <div className="field">
            <span>{reports.length} {reports.length === 1 ? 'person reports' : 'people report'} to {employee.firstName}. Who is their new manager?</span>
            <PersonPicker value={newManager} onChange={(id) => setNewManager(id)} excludeIds={[employee.id]} placeholder="Search for the new manager" />
          </div>
        )}
        {error && <div role="alert" style={{ background: 'var(--danger-bg)', color: 'var(--danger)', borderRadius: 14, padding: '10px 14px', fontSize: 13 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-danger" disabled={!ready || archive.isPending}>{archive.isPending ? 'Ending…' : 'End employment'}</button>
        </div>
      </form>
    </Modal>
  )
}
