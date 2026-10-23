import { useState } from 'react'
import { usePendingLeaveApprovals, useApproveLeave, useRejectLeave } from '../../lib/hooks/useLeave'
import Badge from '../../components/ui/Badge'
import Modal from '../../components/ui/Modal'
import api from '../../lib/api'

// Opens the attached certificate (a short-lived link; managers in the reporting line and HR only)
const openAttachment = async (id: string) => { try { window.open((await api.get(`/leave/requests/${id}/attachment`)).data.data.url, '_blank', 'noopener') } catch { window.alert('Could not open the attachment') } }

export default function LeaveApprovalsPanel() {
  const { data: requests = [], isLoading } = usePendingLeaveApprovals()
  const approveLeave = useApproveLeave()
  const rejectLeave = useRejectLeave()
  const [rejectModal, setRejectModal] = useState<{ id: string; name: string } | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [treatment, setTreatment] = useState<Record<string, 'paid' | 'unpaid'>>({})

  const handleApprove = async (id: string, shortfall = 0) => {
    await approveLeave.mutateAsync({ id, comments: 'Approved', ...(shortfall > 0 && { shortfall: treatment[id] ?? 'paid' }) })
  }

  const handleReject = async () => {
    if (!rejectModal || !rejectReason.trim()) return
    await rejectLeave.mutateAsync({ id: rejectModal.id, comments: rejectReason })
    setRejectModal(null)
    setRejectReason('')
  }

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })

  if (isLoading) return <div style={{ color: 'var(--faint)', fontSize: '13px' }}>Loading...</div>

  if (requests.length === 0) {
    return (
      <div style={s.emptyState}>
        <div style={{ fontSize: '28px', marginBottom: '8px' }}>✓</div>
        <div style={{ fontSize: '14px', fontWeight: '500', color: 'var(--ink)' }}>All caught up</div>
        <div style={{ fontSize: '13px', color: 'var(--faint)', marginTop: '4px' }}>No pending leave requests</div>
      </div>
    )
  }

  return (
    <div style={s.list}>
      {requests.map((req: any) => (
        <div key={req.id} style={s.card}>
          <div style={s.cardTop}>
            <div style={s.avatar}>{req.employee?.user?.fullName?.charAt(0)}</div>
            <div style={s.info}>
              <div style={s.name}>{req.employee?.user?.fullName}</div>
              <div style={s.sub}>{req.leaveType?.name}</div>
            </div>
            <Badge label={req.leaveType?.name || 'Leave'} variant="pending" />
          </div>

          <div style={s.dateRow}>
            <span style={s.dates}>{formatDate(req.startDate)} → {formatDate(req.endDate)}</span>
            <span style={s.days}>{req.totalDays} day{req.totalDays !== 1 ? 's' : ''}</span>
          </div>

          {req.shortfallDays > 0 && (
            <div style={{ fontSize: 12.5, background: 'var(--honey-soft)', borderRadius: 10, padding: '8px 10px', margin: '6px 0', display: 'grid', gap: 6 }}>
              <span><strong>{req.shortfallDays} day{req.shortfallDays === 1 ? '' : 's'}</strong> beyond the balance. If you approve, treat them as:</span>
              <span style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="radio" name={`short-${req.id}`} checked={(treatment[req.id] ?? 'paid') === 'paid'} onChange={() => setTreatment({ ...treatment, [req.id]: 'paid' })} /> Paid (balance goes negative; HR is told)</label>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="radio" name={`short-${req.id}`} checked={treatment[req.id] === 'unpaid'} onChange={() => setTreatment({ ...treatment, [req.id]: 'unpaid' })} /> Unpaid (deducted in payroll)</label>
              </span>
            </div>
          )}
          {req.reason && <div style={s.reason}>"{req.reason}"</div>}
          {req.attachmentUrl && <button className="link" style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', fontSize: 12, marginBottom: 6 }} onClick={() => openAttachment(req.id)}>View certificate</button>}

          <div style={s.appliedAt}>Applied {formatDate(req.appliedAt)}</div>

          <div style={s.actions}>
            <button
              style={s.approveBtn}
              onClick={() => handleApprove(req.id, req.shortfallDays)}
              disabled={approveLeave.isPending}
            >
              ✓ Approve
            </button>
            <button
              style={s.rejectBtn}
              onClick={() => setRejectModal({ id: req.id, name: req.employee?.user?.fullName })}
            >
              ✕ Reject
            </button>
          </div>
        </div>
      ))}

      <Modal open={!!rejectModal} onClose={() => setRejectModal(null)} title="Reject Leave Request" width={420}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <p style={{ fontSize: '13px', color: 'var(--dim)', margin: 0 }}>
            Rejecting {rejectModal?.name}'s leave request. Please provide a reason.
          </p>
          <textarea
            style={{ padding: '10px 12px', borderRadius: '12px', border: '1px solid var(--line-2)', fontSize: '13px', resize: 'vertical', fontFamily: 'inherit', outline: 'none' }}
            rows={3}
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="Reason for rejection..."
            autoFocus
          />
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
            <button onClick={() => setRejectModal(null)} style={{ padding: '9px 18px', backgroundColor: 'var(--well)', border: '1px solid var(--line)', borderRadius: '12px', fontSize: '13px', cursor: 'pointer' }}>Cancel</button>
            <button
              onClick={handleReject}
              disabled={!rejectReason.trim() || rejectLeave.isPending}
              style={{ padding: '9px 18px', backgroundColor: 'var(--danger)', color: 'var(--night-ink)', border: 'none', borderRadius: '12px', fontSize: '13px', cursor: 'pointer', opacity: !rejectReason.trim() ? 0.5 : 1 }}
            >
              {rejectLeave.isPending ? 'Rejecting...' : 'Confirm Reject'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  list: { display: 'flex', flexDirection: 'column', gap: '10px' },
  card: { backgroundColor: 'var(--card)', backdropFilter: 'blur(18px)', border: '1px solid var(--hair)', boxShadow: 'var(--shadow)', borderRadius: 'var(--r-card)', padding: '16px' },
  cardTop: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' },
  avatar: { width: '32px', height: '32px', borderRadius: '50%', backgroundColor: 'var(--honey-soft)', color: 'var(--brand)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '13px', fontWeight: '600', flexShrink: 0 },
  info: { flex: 1 },
  name: { fontSize: '13px', fontWeight: '500', color: 'var(--ink)' },
  sub: { fontSize: '12px', color: 'var(--faint)' },
  dateRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' },
  dates: { fontSize: '13px', color: 'var(--ink)' },
  days: { fontSize: '13px', fontWeight: '500', color: 'var(--brand)' },
  reason: { fontSize: '12px', color: 'var(--dim)', fontStyle: 'italic', marginBottom: '6px' },
  appliedAt: { fontSize: '11px', color: 'var(--faint)', marginBottom: '12px' },
  actions: { display: 'flex', gap: '8px' },
  approveBtn: { flex: 1, padding: '8px', backgroundColor: 'var(--ok-bg)', color: 'var(--ok)', border: '1px solid var(--ok-line)', borderRadius: 999, fontSize: '13px', fontWeight: '500', cursor: 'pointer' },
  rejectBtn: { flex: 1, padding: '8px', backgroundColor: 'var(--danger-bg)', color: 'var(--danger)', border: '1px solid var(--danger-line)', borderRadius: 999, fontSize: '13px', fontWeight: '500', cursor: 'pointer' },
  emptyState: { textAlign: 'center', padding: '40px 20px', color: 'var(--dim)' },
}
