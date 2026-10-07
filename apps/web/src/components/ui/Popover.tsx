import { useEffect, useLayoutEffect, useRef, type ReactNode, type CSSProperties } from 'react'
import { gsap, reduced } from '../../lib/motion'

// Floating panel anchored under its trigger: pops in, closes on outside click or Escape
export default function Popover({ open, onClose, children, align = 'right', width = 340, style, label }: {
  open: boolean; onClose: () => void; children: ReactNode; align?: 'left' | 'right'; width?: number; style?: CSSProperties; label: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const click = (e: MouseEvent) => { if (!ref.current?.parentElement?.contains(e.target as Node)) onClose() }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', click)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', click); document.removeEventListener('keydown', key) }
  }, [open, onClose])
  useLayoutEffect(() => {
    if (open && ref.current && !reduced()) gsap.fromTo(ref.current, { opacity: 0, y: -10, scale: 0.94 }, { opacity: 1, y: 0, scale: 1, duration: 0.45, ease: 'back.out(1.6)', transformOrigin: align === 'right' ? '90% 0' : '10% 0' })
  }, [open, align])
  if (!open) return null
  return (
    <div ref={ref} role="dialog" aria-label={label} className="card" style={{ position: 'absolute', top: 'calc(100% + 10px)', [align]: 0, width, zIndex: 60, background: 'var(--solid)', boxShadow: 'var(--shadow-pop)', overflow: 'hidden', ...style }}>
      {children}
    </div>
  )
}
