import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { gsap, reduced } from '../../lib/motion'
import Icon from './Icon'

interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  width?: number
}

// Centered sheet that springs in; Escape or the backdrop closes it, focus moves inside on open
export default function Modal({ open, onClose, title, children, width = 560 }: ModalProps) {
  const sheet = useRef<HTMLDivElement>(null)
  const back = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!open || reduced()) return
    gsap.fromTo(back.current, { opacity: 0 }, { opacity: 1, duration: 0.3, ease: 'power2.out' })
    gsap.fromTo(sheet.current, { opacity: 0, y: 24, scale: 0.97 }, { opacity: 1, y: 0, scale: 1, duration: 0.5, ease: 'back.out(1.4)' })
  }, [open])
  useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', key)
    const first = sheet.current?.querySelector<HTMLElement>('input, select, textarea, button:not([data-close])')
    first?.focus()
    return () => { document.removeEventListener('keydown', key); prev?.focus?.() }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!open) return null

  return (
    <div ref={back} style={s.overlay} onMouseDown={onClose}>
      <div ref={sheet} role="dialog" aria-modal="true" aria-label={title} className="card" style={{ ...s.modal, width }} onMouseDown={(e) => e.stopPropagation()}>
        <div style={s.header}>
          <span style={s.title}>{title}</span>
          <button data-close className="btn btn-ghost btn-icon" style={{ width: 34, height: 34 }} onClick={onClose} aria-label="Close"><Icon name="x" size={15} /></button>
        </div>
        <div className="scroll-y" style={s.body}>{children}</div>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(37,37,35,0.32)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 950, padding: 16 },
  modal: { background: 'var(--solid)', maxWidth: '100%', maxHeight: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: 'var(--shadow-pop)' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 18px 10px 24px', flexShrink: 0 },
  title: { fontFamily: 'var(--font-display)', fontSize: 22, letterSpacing: '-0.02em' },
  body: { padding: '8px 24px 24px', flex: 1 },
}
