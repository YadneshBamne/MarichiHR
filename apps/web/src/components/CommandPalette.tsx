import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { ALL_ITEMS, canSee } from '../lib/nav'
import { gsap, reduced } from '../lib/motion'
import Icon, { type IconName } from './ui/Icon'

type Cmd = { id: string; label: string; hint: string; icon: IconName; run: () => void; soon?: boolean; keywords?: string }

// ⌘K / Ctrl+K: jump to any page or run a quick action
export default function CommandPalette({ open, onClose, onTour }: { open: boolean; onClose: () => void; onTour: () => void }) {
  const navigate = useNavigate()
  const { user, logout } = useAuth()
  const [q, setQ] = useState('')
  const [i, setI] = useState(0)
  const panel = useRef<HTMLDivElement>(null)
  const roles = user?.roles?.map((r) => r.name) ?? []

  const cmds: Cmd[] = useMemo(() => [
    ...ALL_ITEMS.filter((it) => canSee(it, roles)).map((it) => ({
      id: it.path, label: it.label, hint: it.section.label, icon: it.icon, soon: !!it.soon, keywords: it.keywords,
      run: () => navigate(it.path),
    })),
    { id: 'security', label: 'Security & two-factor', hint: 'Account', icon: 'lock', run: () => navigate('/security'), keywords: 'mfa password totp' },
    { id: 'settings', label: 'Settings', hint: 'Workspace', icon: 'settings', run: () => navigate('/settings') },
    ...(user?.employee ? [{ id: 'profile', label: 'My profile', hint: 'Account', icon: 'user' as IconName, run: () => navigate(`/employees/${user.employee!.id}`) }] : []),
    { id: 'tour', label: 'Take the product tour', hint: 'Help', icon: 'compass', run: onTour, keywords: 'help guide onboarding' },
    { id: 'logout', label: 'Sign out', hint: 'Account', icon: 'logout', run: () => { logout().then(() => navigate('/login')) } },
  ], [roles.join(','), user?.employee?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const list = useMemo(() => {
    const t = q.trim().toLowerCase()
    return t ? cmds.filter((c) => `${c.label} ${c.hint} ${c.keywords ?? ''}`.toLowerCase().includes(t)) : cmds
  }, [q, cmds])

  useEffect(() => { if (open) { setQ(''); setI(0) } }, [open])
  useEffect(() => setI(0), [q])
  useLayoutEffect(() => {
    if (open && panel.current && !reduced()) gsap.fromTo(panel.current, { opacity: 0, y: -14, scale: 0.97 }, { opacity: 1, y: 0, scale: 1, duration: 0.45, ease: 'back.out(1.5)' })
  }, [open])
  if (!open) return null

  const go = (c?: Cmd) => { if (!c) return; onClose(); c.run() }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(x + 1, list.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(x - 1, 0)) }
    else if (e.key === 'Enter') go(list[i])
    else if (e.key === 'Escape') onClose()
  }

  return (
    <div onMouseDown={onClose} style={{ position: 'fixed', inset: 0, zIndex: 900, background: 'rgba(37,37,35,0.28)', backdropFilter: 'blur(3px)', display: 'flex', justifyContent: 'center', paddingTop: '12vh' }}>
      <div ref={panel} role="dialog" aria-label="Search" onMouseDown={(e) => e.stopPropagation()} className="card" style={{ width: 'min(620px, calc(100vw - 32px))', alignSelf: 'flex-start', background: 'var(--solid)', boxShadow: 'var(--shadow-pop)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px', borderBottom: '1px solid var(--line)' }}>
          <Icon name="search" size={19} style={{ color: 'var(--faint)' }} />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder="Search pages and actions…" aria-label="Search pages and actions"
            style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontSize: 16 }} role="combobox" aria-expanded="true" aria-controls="cmd-list" aria-activedescendant={list[i] ? `cmd-${list[i].id}` : undefined} />
          <kbd style={kbd}>Esc</kbd>
        </div>
        <ul id="cmd-list" role="listbox" className="scroll-y" style={{ maxHeight: 380, listStyle: 'none', padding: 8 }}>
          {list.length === 0 && <li style={{ padding: 24, textAlign: 'center', fontSize: 13 }} className="muted">No matches for “{q}”.</li>}
          {list.map((c, n) => (
            <li key={c.id} id={`cmd-${c.id}`} role="option" aria-selected={n === i} onMouseEnter={() => setI(n)} onClick={() => go(c)}
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 14, cursor: 'pointer', background: n === i ? 'var(--night)' : 'transparent', color: n === i ? 'var(--night-ink)' : 'var(--ink)', transition: 'background-color .2s' }}>
              <Icon name={c.icon} size={17} />
              <span style={{ flex: 1, fontSize: 14 }}>{c.label}</span>
              {c.soon && <span className="pill honey" style={{ height: 20 }}>Soon</span>}
              <span style={{ fontSize: 12, opacity: 0.6 }}>{c.hint}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

const kbd: React.CSSProperties = { fontSize: 11, padding: '3px 7px', borderRadius: 7, border: '1px solid var(--line-2)', color: 'var(--faint)', fontFamily: 'var(--font-body)' }
