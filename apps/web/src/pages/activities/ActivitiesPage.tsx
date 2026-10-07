import { useState } from 'react'
import { useMyActivities, useCompleteActivity, useCancelActivity } from '../../lib/hooks/useActivities'
import Modal from '../../components/ui/Modal'
import Badge from '../../components/ui/Badge'

type Filter = 'planned' | 'done' | 'cancelled' | 'all'

export default function ActivitiesPage() {
  const [filter, setFilter] = useState<Filter>('planned')
  const [completeModal, setCompleteModal] = useState<{ id: string; title: string } | null>(null)
  const [doneNote, setDoneNote] = useState('')

  const { data: activities = [], isLoading } = useMyActivities(
    filter === 'all' ? undefined : filter
  )
  const completeActivity = useCompleteActivity()
  const cancelActivity = useCancelActivity()

  const handleComplete = async () => {
    if (!completeModal || !doneNote.trim()) return
    await completeActivity.mutateAsync({ id: completeModal.id, doneNote })
    setCompleteModal(null)
    setDoneNote('')
  }

  const formatDate = (iso: string) => {
    const d = new Date(iso)
    const now = new Date()
    const diff = d.getTime() - now.getTime()
    const days = Math.ceil(diff / (1000 * 60 * 60 * 24))
    if (days < 0) return { label: `${Math.abs(days)}d overdue`, color: 'var(--danger)', bg: 'var(--danger-bg)' }
    if (days === 0) return { label: 'Due today', color: 'var(--warn)', bg: 'var(--warn-bg)' }
    if (days === 1) return { label: 'Due tomorrow', color: 'var(--warn)', bg: 'var(--warn-bg)' }
    return { label: `Due ${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}`, color: 'var(--dim)', bg: 'var(--well)' }
  }

  const FILTERS: { key: Filter; label: string }[] = [
    { key: 'planned', label: 'Pending' },
    { key: 'done', label: 'Done' },
    { key: 'cancelled', label: 'Cancelled' },
    { key: 'all', label: 'All' },
  ]

  return (
    <div style={s.page}>
      <div style={s.header}>
        <div>
          <h2 style={s.title}>My Activities</h2>
          <p style={s.sub}>Tasks and follow-ups assigned to you</p>
        </div>
      </div>

      <div style={s.filterRow}>
        {FILTERS.map((f) => (
          <button
            key={f.key}
            style={{ ...s.filterBtn, ...(filter === f.key ? s.filterActive : {}) }}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div style={s.loading}>Loading activities...</div>
      ) : activities.length === 0 ? (
        <div style={s.empty}>
          <div style={{ fontSize: '28px', marginBottom: '8px' }}>
            {filter === 'planned' ? '✓' : '📋'}
          </div>
          <div style={{ fontSize: '14px', fontWeight: '500', color: 'var(--ink)', marginBottom: '4px' }}>
            {filter === 'planned' ? 'No pending activities' : `No ${filter} activities`}
          </div>
          <div style={{ fontSize: '13px', color: 'var(--faint)' }}>
            {filter === 'planned' ? 'All your tasks are up to date.' : ''}
          </div>
        </div>
      ) : (
        <div style={s.list}>
          {activities.map((act: any) => {
            const due = act.dueDate ? formatDate(act.dueDate) : null
            return (
              <div key={act.id} style={s.card}>
                <div style={s.cardTop}>
                  <div style={s.activityIcon}>
                    {act.activityType?.icon === 'phone' ? '📞' :
                     act.activityType?.icon === 'mail' ? '✉️' :
                     act.activityType?.icon === 'users' ? '👥' :
                     act.activityType?.icon === 'file' ? '📄' :
                     act.activityType?.icon === 'clock' ? '⏰' :
                     act.activityType?.icon === 'eye' ? '👁' :
                     act.activityType?.icon === 'file-text' ? '📋' :
                     act.activityType?.icon === 'check-square' ? '✅' : '📌'}
                  </div>
                  <div style={s.cardInfo}>
                    <div style={s.actTitle}>{act.title}</div>
                    {act.note && <div style={s.actNote}>{act.note}</div>}
                    <div style={s.actMeta}>
                      <span style={s.actType}>{act.activityType?.name}</span>
                      <span style={s.dot}>·</span>
                      <span style={s.actEntity}>{act.entityType?.replace(/_/g, ' ')}</span>
                    </div>
                  </div>
                  <div style={s.cardRight}>
                    {due && (
                      <span style={{ ...s.duePill, backgroundColor: due.bg, color: due.color }}>
                        {due.label}
                      </span>
                    )}
                    <Badge label={act.status} />
                  </div>
                </div>

                {act.status === 'done' && act.doneNote && (
                  <div style={s.doneNote}>✓ {act.doneNote}</div>
                )}

                {act.status === 'planned' && (
                  <div style={s.cardActions}>
                    <button
                      style={s.completeBtn}
                      onClick={() => setCompleteModal({ id: act.id, title: act.title })}
                    >
                      Mark as Done
                    </button>
                    <button
                      style={s.cancelBtn}
                      onClick={() => cancelActivity.mutate(act.id)}
                      disabled={cancelActivity.isPending}
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      <Modal open={!!completeModal} onClose={() => setCompleteModal(null)} title="Complete Activity" width={420}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <p style={{ fontSize: '13px', color: 'var(--dim)', margin: 0 }}>
            Completing: <strong>{completeModal?.title}</strong>
          </p>
          <textarea
            style={{ padding: '10px 12px', borderRadius: '12px', border: '1px solid var(--line-2)', fontSize: '13px', resize: 'vertical', fontFamily: 'inherit', outline: 'none' }}
            rows={3}
            value={doneNote}
            onChange={(e) => setDoneNote(e.target.value)}
            placeholder="What did you do? Add a completion note..."
            autoFocus
          />
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
            <button onClick={() => setCompleteModal(null)} style={{ padding: '9px 18px', backgroundColor: 'var(--well)', border: '1px solid var(--line)', borderRadius: '12px', fontSize: '13px', cursor: 'pointer' }}>Cancel</button>
            <button
              onClick={handleComplete}
              disabled={!doneNote.trim() || completeActivity.isPending}
              style={{ padding: '9px 18px', backgroundColor: 'var(--brand)', color: 'var(--night-ink)', border: 'none', borderRadius: '12px', fontSize: '13px', fontWeight: '500', cursor: 'pointer', opacity: !doneNote.trim() ? 0.5 : 1 }}
            >
              {completeActivity.isPending ? 'Completing...' : 'Mark Done'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: {},
  header: { marginBottom: '16px' },
  title: { fontSize: 'clamp(32px, 4vw, 46px)', fontFamily: 'var(--font-display)', letterSpacing: '-0.02em', fontWeight: 400, color: 'var(--ink)', margin: 0 },
  sub: { fontSize: '13px', color: 'var(--faint)', marginTop: '2px' },
  filterRow: { display: 'flex', gap: '6px', marginBottom: '20px' },
  filterBtn: { padding: '6px 16px', borderRadius: '16px', border: '1px solid var(--line)', backgroundColor: 'var(--card-2)', fontSize: '12px', cursor: 'pointer', color: 'var(--dim)' },
  filterActive: { backgroundColor: 'var(--brand)', color: 'var(--night-ink)', borderColor: 'var(--brand)' },
  loading: { color: 'var(--faint)', fontSize: '13px' },
  empty: { textAlign: 'center', padding: '60px 20px', color: 'var(--dim)' },
  list: { display: 'flex', flexDirection: 'column', gap: '10px' },
  card: { backgroundColor: 'var(--card)', backdropFilter: 'blur(18px)', border: '1px solid var(--hair)', boxShadow: 'var(--shadow)', borderRadius: 'var(--r-card)', padding: '16px' },
  cardTop: { display: 'flex', gap: '12px', alignItems: 'flex-start' },
  activityIcon: { fontSize: '20px', flexShrink: 0, marginTop: '2px' },
  cardInfo: { flex: 1 },
  actTitle: { fontSize: '14px', fontWeight: '500', color: 'var(--ink)', marginBottom: '3px' },
  actNote: { fontSize: '12px', color: 'var(--dim)', marginBottom: '4px' },
  actMeta: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '11px', color: 'var(--faint)' },
  actType: { color: 'var(--brand)' },
  dot: { color: 'var(--line-2)' },
  actEntity: {},
  cardRight: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '6px', flexShrink: 0 },
  duePill: { padding: '2px 8px', borderRadius: 'var(--r-card)', fontSize: '11px', fontWeight: '500', whiteSpace: 'nowrap' },
  doneNote: { marginTop: '10px', fontSize: '12px', color: 'var(--ok)', backgroundColor: 'var(--ok-bg)', padding: '8px 10px', borderRadius: '12px' },
  cardActions: { display: 'flex', gap: '8px', marginTop: '12px', paddingTop: '12px', borderTop: '1px solid var(--well)' },
  completeBtn: { padding: '7px 16px', backgroundColor: 'var(--brand)', color: 'var(--night-ink)', border: 'none', borderRadius: 999, fontSize: '12px', fontWeight: '500', cursor: 'pointer' },
  cancelBtn: { padding: '7px 14px', backgroundColor: 'var(--well)', border: '1px solid var(--line)', borderRadius: 999, fontSize: '12px', cursor: 'pointer', color: 'var(--dim)' },
}
