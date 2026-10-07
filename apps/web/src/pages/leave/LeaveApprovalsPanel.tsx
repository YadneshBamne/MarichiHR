import { useState } from 'react'
import { usePendingLeaveApprovals, useApproveLeave, useRejectLeave } from '../../lib/hooks/useLeave'
import Badge from '../../components/ui/Badge'
import Modal from '../../components/ui/Modal'

export default function LeaveApprovalsPanel() {
  const { data: requests = [], isLoading } = usePendingLeaveApprovals()
  const approveLeave = useApproveLeave()
  const rejectLeave = useRejectLeave()
  const [rejectModal, setRejectModal] = useState<{ id: string; name: string } | null>(null)
  const [rejectReason, setRejectReason] = useState('')

  const handleApprove = async (id: string) => {
    await approveLeave.mutateAsync({ id, comments: 'Approved' })
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

          {req.reason && <div style={s.reason}>"{req.reason}"</div>}

          <div style={s.appliedAt}>Applied {formatDate(req.appliedAt)}</div>

          <div style={s.actions}>
            <button
              style={s.approveBtn}
              onClick={() => handleApprove(req.id)}
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
