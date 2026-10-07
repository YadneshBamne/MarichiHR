import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../lib/api'
import { gsap, reduced } from '../lib/motion'
import Icon from './ui/Icon'
import Popover from './ui/Popover'

interface Note { id: string; title: string; body: string; link: string | null; readAt: string | null; createdAt: string }

const ago = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`
}

export default function NotificationBell() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const icoRef = useRef<HTMLSpanElement>(null)
  const lastUnread = useRef<number | null>(null)
  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: async () => (await api.get('/notifications')).data.data as { items: Note[]; unread: number },
    refetchInterval: 45000,
  })
  const refresh = () => qc.invalidateQueries({ queryKey: ['notifications'] })
  const readOne = useMutation({ mutationFn: (id: string) => api.post(`/notifications/${id}/read`), onSuccess: refresh })
  const readAll = useMutation({ mutationFn: () => api.post('/notifications/read-all'), onSuccess: refresh })
  const unread = data?.unread ?? 0

  // The bell swings when something new arrives
  useEffect(() => {
    if (lastUnread.current != null && unread > lastUnread.current && icoRef.current && !reduced()) {
      gsap.fromTo(icoRef.current, { rotation: 0 }, { keyframes: { rotation: [0, 18, -14, 10, -6, 0] }, duration: 0.8, ease: 'power1.out', transformOrigin: '50% 10%' })
    }
    lastUnread.current = unread
  }, [unread])

  const openNote = (n: Note) => {
    if (!n.readAt) readOne.mutate(n.id)
    setOpen(false)
    if (n.link) navigate(n.link)
  }

  return (
    <div style={{ position: 'relative' }} data-tour="notifications">
      <button className="btn btn-ghost btn-icon" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} aria-expanded={open} onClick={() => setOpen(!open)} style={{ position: 'relative' }}>
        <span ref={icoRef} style={{ display: 'inline-flex' }}><Icon name="bell" size={17} /></span>
        {unread > 0 && <span style={s.badge}>{unread > 99 ? '99+' : unread}</span>}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} label="Notifications" width={380}>
        <div style={s.head}>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: 18 }}>Notifications</span>
          {unread > 0 ? <button className="link" onClick={() => readAll.mutate()}>Mark all read</button> : <span className="muted" style={{ fontSize: 12 }}>All caught up</span>}
        </div>
        <ul className="scroll-y" style={{ maxHeight: 420, listStyle: 'none', padding: 8 }}>
          {!data?.items.length && <li style={s.empty}><Icon name="sparkle" size={22} style={{ color: 'var(--honey)' }} /><div style={{ marginTop: 8 }}>Nothing new. Updates on leave, payroll and approvals land here.</div></li>}
          {data?.items.map((n) => (
            <li key={n.id}>
              <button onClick={() => openNote(n)} style={{ ...s.item, background: n.readAt ? 'transparent' : 'var(--honey-soft)' }}>
                <span style={{ ...s.ico, background: n.readAt ? 'var(--well)' : 'var(--honey)' }}><Icon name="bell" size={14} /></span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'flex', gap: 8 }}>
                    <span style={{ flex: 1, fontSize: 13, fontWeight: n.readAt ? 400 : 500 }}>{n.title}</span>
                    <span className="muted" style={{ fontSize: 11 }}>{ago(n.createdAt)}</span>
                  </span>
                  <span className="dim" style={{ display: 'block', fontSize: 12, marginTop: 2, lineHeight: 1.45 }}>{n.body}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Popover>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  badge: { position: 'absolute', top: -3, right: -3, background: 'var(--honey)', color: 'var(--ink)', fontSize: 10, fontWeight: 600, minWidth: 17, height: 17, padding: '0 4px', borderRadius: 9, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 0 2px var(--app-1)' },
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 18px 10px' },
  empty: { padding: '30px 24px', textAlign: 'center', fontSize: 13, color: 'var(--faint)' },
  item: { display: 'flex', gap: 12, width: '100%', textAlign: 'left', padding: '10px 10px', border: 'none', borderRadius: 16, marginBottom: 2, transition: 'background-color .3s' },
  ico: { width: 30, height: 30, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
}
