import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../lib/api'

interface Note { id: string; title: string; body: string; link: string | null; readAt: string | null; createdAt: string }

const ago = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

export default function NotificationBell() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: async () => (await api.get('/notifications')).data.data as { items: Note[]; unread: number },
    refetchInterval: 60000,
  })
  const refresh = () => qc.invalidateQueries({ queryKey: ['notifications'] })
  const readOne = useMutation({ mutationFn: (id: string) => api.post(`/notifications/${id}/read`), onSuccess: refresh })
  const readAll = useMutation({ mutationFn: () => api.post('/notifications/read-all'), onSuccess: refresh })

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc) }
  }, [open])

  const unread = data?.unread ?? 0
  const openNote = (n: Note) => {
    if (!n.readAt) readOne.mutate(n.id)
    setOpen(false)
    if (n.link) navigate(n.link)
  }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} aria-expanded={open} onClick={() => setOpen(!open)} style={s.bell}>
        🔔
        {unread > 0 && <span style={s.badge}>{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div role="dialog" aria-label="Notifications" style={s.panel}>
          <div style={s.head}>
            <strong style={{ fontSize: 13, fontWeight: 500 }}>Notifications</strong>
            {unread > 0 && <button style={s.link} onClick={() => readAll.mutate()}>Mark all read</button>}
          </div>
          <div style={{ maxHeight: 380, overflowY: 'auto' }}>
            {!data?.items.length ? <div style={s.empty}>You're all caught up.</div> : data.items.map((n) => (
              <button key={n.id} onClick={() => openNote(n)} style={{ ...s.item, backgroundColor: n.readAt ? '#fff' : '#f7f6fe' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                  {!n.readAt && <span style={s.dot} />}
                  <span style={{ fontSize: 13, fontWeight: n.readAt ? 400 : 500, color: '#1a1a18', flex: 1 }}>{n.title}</span>
                  <span style={{ fontSize: 11, color: '#8c8c88', whiteSpace: 'nowrap' }}>{ago(n.createdAt)}</span>
                </div>
                <div style={{ fontSize: 12, color: '#5c5c58', marginTop: 3, lineHeight: 1.4 }}>{n.body}</div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  bell: { position: 'relative', background: 'none', border: 'none', fontSize: 17, cursor: 'pointer', padding: '4px 6px', lineHeight: 1 },
  badge: { position: 'absolute', top: -2, right: -4, backgroundColor: '#993C1D', color: '#fff', fontSize: 10, fontWeight: 600, padding: '1px 5px', borderRadius: 10, minWidth: 16, textAlign: 'center' },
  panel: { position: 'absolute', right: 0, top: 'calc(100% + 8px)', width: 360, backgroundColor: '#fff', border: '0.5px solid #e2e0da', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.08)', zIndex: 50, overflow: 'hidden' },
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderBottom: '0.5px solid #e2e0da' },
  link: { background: 'none', border: 'none', color: '#534AB7', fontSize: 12, cursor: 'pointer' },
  empty: { padding: 32, textAlign: 'center', fontSize: 13, color: '#8c8c88' },
  item: { display: 'block', width: '100%', textAlign: 'left', padding: '11px 14px', border: 'none', borderBottom: '0.5px solid #f5f4f0', cursor: 'pointer', fontFamily: 'inherit' },
  dot: { width: 7, height: 7, borderRadius: '50%', backgroundColor: '#534AB7', flexShrink: 0, alignSelf: 'center' },
}
