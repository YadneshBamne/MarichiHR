import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { usePendingLeaveApprovals, useApproveLeave, useRejectLeave } from '../../lib/hooks/useLeave'
import Avatar from '../../components/ui/Avatar'
import Icon from '../../components/ui/Icon'
import Modal from '../../components/ui/Modal'
import { useToast } from '../../components/ui/Toast'
import api from '../../lib/api'

const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
// Opens the attached certificate (a short-lived link; managers in the reporting line and HR only)
const openAttachment = async (id: string, fail: (m: string) => void) => { try { window.open((await api.get(`/leave/requests/${id}/attachment`)).data.data.url, '_blank', 'noopener') } catch { fail('Could not open the attachment') } }
const formatDate = (iso: string) => new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })

type Ask = { id: string; name: string; kind: 'reject' | 'return' }

export default function LeaveApprovalsPanel() {
  const toast = useToast()
  const qc = useQueryClient()
  const { data: requests = [], isLoading } = usePendingLeaveApprovals()
  const approveLeave = useApproveLeave()
  const rejectLeave = useRejectLeave()
  // Send back: the person is asked to change the request and send it again
  const sendBack = useMutation({
    mutationFn: async (v: { id: string; note: string }) => (await api.post(`/leave/requests/${v.id}/return`, { note: v.note })).data.data,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['leave-pending-approvals'] }); qc.invalidateQueries({ queryKey: ['leave-requests-me'] }); qc.invalidateQueries({ queryKey: ['dashboard'] }) },
  })
  const [ask, setAsk] = useState<Ask | null>(null)
  const [reason, setReason] = useState('')
  const [treatment, setTreatment] = useState<Record<string, 'paid' | 'unpaid'>>({})
  const [notes, setNotes] = useState<Record<string, string | undefined>>({}) // an optional note per request on approve (undefined = field closed)

  const approve = async (id: string, shortfall = 0) => {
    try {
      await approveLeave.mutateAsync({ id, comments: notes[id]?.trim() || 'Approved', ...(shortfall > 0 && { shortfall: treatment[id] ?? 'paid' }) })
      toast('Approved')
    } catch (e) { toast(errMsg(e), 'error') }
  }
  const close = () => { setAsk(null); setReason('') }
  const submitAsk = async () => {
    if (!ask || reason.trim().length < 3) return
    try {
      if (ask.kind === 'reject') await rejectLeave.mutateAsync({ id: ask.id, comments: reason.trim() })
      else await sendBack.mutateAsync({ id: ask.id, note: reason.trim() })
      toast(ask.kind === 'reject' ? 'Rejected' : 'Sent back')
      close()
    } catch (e) { toast(errMsg(e), 'error') }
  }
  const busy = rejectLeave.isPending || sendBack.isPending

  if (isLoading) return <div className="skeleton" style={{ height: 120, borderRadius: 18 }} />

  if (requests.length === 0) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: '40px 20px' }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 20 }}>All caught up</div>
        <div className="dim" style={{ fontSize: 13, marginTop: 4 }}>No pending leave requests</div>
      </div>
    )
  }

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {requests.map((req: any) => {
        const name = req.employee?.user?.fullName ?? 'Someone'
        return (
          <article key={req.id} className="card" style={{ padding: 16, display: 'grid', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <Avatar name={name} size={34} />
              <div style={{ flex: '1 1 160px', minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{name}</div>
                <div className="dim" style={{ fontSize: 12 }}>Applied {formatDate(req.appliedAt)}</div>
              </div>
              <span className="pill warn" style={{ textTransform: 'none' }}>{req.leaveType?.name || 'Leave'}</span>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13, flexWrap: 'wrap' }}>
              <span>{formatDate(req.startDate)} → {formatDate(req.endDate)}</span>
              <strong style={{ fontWeight: 600 }}>{req.totalDays} day{req.totalDays !== 1 ? 's' : ''}</strong>
            </div>

            {req.shortfallDays > 0 && (
              <div className="well" style={{ fontSize: 12.5, padding: '10px 12px', display: 'grid', gap: 6, background: 'var(--honey-soft)' }}>
                <span><strong>{req.shortfallDays} day{req.shortfallDays === 1 ? '' : 's'}</strong> beyond the balance. If you approve, treat them as:</span>
                <span style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                  <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="radio" name={`short-${req.id}`} checked={(treatment[req.id] ?? 'paid') === 'paid'} onChange={() => setTreatment({ ...treatment, [req.id]: 'paid' })} /> Paid (balance goes negative; HR is told)</label>
                  <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="radio" name={`short-${req.id}`} checked={treatment[req.id] === 'unpaid'} onChange={() => setTreatment({ ...treatment, [req.id]: 'unpaid' })} /> Unpaid (deducted in payroll)</label>
                </span>
              </div>
            )}
            {req.reason && <div className="dim" style={{ fontSize: 13, fontStyle: 'italic' }}>“{req.reason}”</div>}
            {req.attachmentUrl && <div><button type="button" className="link" onClick={() => openAttachment(req.id, (m) => toast(m, 'error'))}>View certificate</button></div>}

            {notes[req.id] !== undefined ? (
              <label className="field"><span>Note for {name.split(' ')[0]} (optional)</span><textarea className="input textarea" rows={2} maxLength={500} value={notes[req.id]} onChange={(e) => setNotes({ ...notes, [req.id]: e.target.value })} /></label>
            ) : (
              <div><button type="button" className="link" onClick={() => setNotes({ ...notes, [req.id]: '' })}>Add a note</button></div>
            )}

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn btn-primary btn-sm" onClick={() => approve(req.id, req.shortfallDays)} disabled={approveLeave.isPending}><Icon name="checkCircle" size={14} /> Approve</button>
              <button className="btn btn-ghost btn-sm" onClick={() => { setAsk({ id: req.id, name, kind: 'return' }); setReason('') }}>Send back</button>
              <button className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} onClick={() => { setAsk({ id: req.id, name, kind: 'reject' }); setReason('') }}>Reject</button>
            </div>
          </article>
        )
      })}

      {ask && (
        <Modal open onClose={close} title={ask.kind === 'reject' ? 'Reject leave request' : 'Send the request back'} width={440}>
          <div style={{ display: 'grid', gap: 12 }}>
            <p className="dim" style={{ margin: 0, fontSize: 13 }}>
              {ask.kind === 'reject' ? `Rejecting ${ask.name}'s leave request. They will see your reason.` : `${ask.name} will be asked to change the request and send it again. Say what should change.`}
            </p>
            <label className="field"><span>{ask.kind === 'reject' ? 'Reason' : 'What should they change?'} (at least 3 characters)</span>
              <textarea className="input textarea" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
            </label>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={close}>Cancel</button>
              <button className="btn btn-primary" style={ask.kind === 'reject' ? { background: 'var(--danger)', color: 'var(--night-ink)' } : undefined} disabled={reason.trim().length < 3 || busy} onClick={submitAsk}>
                {busy ? 'Saving…' : ask.kind === 'reject' ? 'Reject request' : 'Send back'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
