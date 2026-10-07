import { usePendingRegularisations, useApproveRegularisation, useRejectRegularisation, usePendingOvertime, useApproveOvertime, useRejectOvertime } from '../../lib/hooks/useAttendance'
import Badge from '../../components/ui/Badge'

export default function ApprovalsPanel() {
  const { data: regularisations = [] } = usePendingRegularisations()
  const { data: overtimes = [] } = usePendingOvertime()
  const approveReg = useApproveRegularisation()
  const rejectReg = useRejectRegularisation()
  const approveOT = useApproveOvertime()
  const rejectOT = useRejectOvertime()

  const formatDate = (iso: string) => new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })

  const total = regularisations.length + overtimes.length
  if (total === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--dim)' }}>
        <div style={{ fontSize: '28px', marginBottom: '8px' }}>✓</div>
        <div style={{ fontSize: '14px', fontWeight: '500', color: 'var(--ink)' }}>All caught up</div>
        <div style={{ fontSize: '13px', marginTop: '4px' }}>No pending regularisations or overtime requests</div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {regularisations.length > 0 && (
        <div>
          <div style={s.sectionTitle}>Regularisation Requests ({regularisations.length})</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {regularisations.map((reg: any) => (
              <div key={reg.id} style={s.card}>
                <div style={s.cardRow}>
                  <div style={s.avatar}>{reg.employee?.user?.fullName?.charAt(0)}</div>
                  <div style={s.info}>
                    <div style={s.name}>{reg.employee?.user?.fullName}</div>
                    <div style={s.sub}>{formatDate(reg.date)}</div>
                  </div>
                  <Badge label="regularisation" variant="pending" />
                </div>
                <div style={s.detailRow}>
                  <span style={s.detailLabel}>Actual In:</span>
                  <span style={s.detailVal}>{reg.actualIn}</span>
                  <span style={s.detailLabel}>Actual Out:</span>
                  <span style={s.detailVal}>{reg.actualOut}</span>
                </div>
                <div style={s.reason}>"{reg.reason}"</div>
                <div style={s.actions}>
                  <button style={s.approveBtn} onClick={() => approveReg.mutate(reg.id)} disabled={approveReg.isPending}>✓ Approve</button>
                  <button style={s.rejectBtn} onClick={() => rejectReg.mutate(reg.id)} disabled={rejectReg.isPending}>✕ Reject</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {overtimes.length > 0 && (
        <div>
          <div style={s.sectionTitle}>Overtime Requests ({overtimes.length})</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {overtimes.map((ot: any) => (
              <div key={ot.id} style={s.card}>
                <div style={s.cardRow}>
                  <div style={s.avatar}>{ot.employee?.user?.fullName?.charAt(0)}</div>
                  <div style={s.info}>
                    <div style={s.name}>{ot.employee?.user?.fullName}</div>
                    <div style={s.sub}>{formatDate(ot.date)}</div>
                  </div>
                  <span style={{ fontSize: '16px', fontWeight: '500', color: 'var(--info)' }}>{ot.overtimeHours}h OT</span>
                </div>
                <div style={s.reason}>"{ot.reason}"</div>
                <div style={s.actions}>
                  <button style={s.approveBtn} onClick={() => approveOT.mutate({ id: ot.id, approvedRate: 1.5 })} disabled={approveOT.isPending}>✓ Approve (1.5×)</button>
                  <button style={s.rejectBtn} onClick={() => rejectOT.mutate(ot.id)} disabled={rejectOT.isPending}>✕ Reject</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  sectionTitle: { fontSize: '13px', fontWeight: '500', color: 'var(--ink)', marginBottom: '10px' },
  card: { backgroundColor: 'var(--card)', backdropFilter: 'blur(18px)', border: '1px solid var(--hair)', boxShadow: 'var(--shadow)', borderRadius: 'var(--r-card)', padding: '14px' },
  cardRow: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' },
  avatar: { width: '30px', height: '30px', borderRadius: '50%', backgroundColor: 'var(--honey-soft)', color: 'var(--brand)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: '600', flexShrink: 0 },
  info: { flex: 1 },
  name: { fontSize: '13px', fontWeight: '500', color: 'var(--ink)' },
  sub: { fontSize: '12px', color: 'var(--faint)' },
  detailRow: { display: 'flex', gap: '12px', alignItems: 'center', marginBottom: '8px', fontSize: '13px' },
  detailLabel: { color: 'var(--faint)', fontSize: '12px' },
  detailVal: { fontWeight: '500', color: 'var(--ink)' },
  reason: { fontSize: '12px', color: 'var(--dim)', fontStyle: 'italic', marginBottom: '12px' },
  actions: { display: 'flex', gap: '8px' },
  approveBtn: { flex: 1, padding: '8px', backgroundColor: 'var(--ok-bg)', color: 'var(--ok)', border: '1px solid var(--ok-line)', borderRadius: 999, fontSize: '13px', fontWeight: '500', cursor: 'pointer' },
  rejectBtn: { flex: 1, padding: '8px', backgroundColor: 'var(--danger-bg)', color: 'var(--danger)', border: '1px solid var(--danger-line)', borderRadius: 999, fontSize: '13px', fontWeight: '500', cursor: 'pointer' },
}
