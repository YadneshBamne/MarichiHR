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
  // Phones (or any screen too narrow for the panel): pin it under the trigger, full width with 12px gutters,
  // scrolling inside if it's taller than the space left, so it never runs off either edge
  useLayoutEffect(() => {
    const el = ref.current
    if (!open || !el?.parentElement) return
    const vw = document.documentElement.clientWidth
    if (vw >= 640 && vw >= width + 24) return
    const top = el.parentElement.getBoundingClientRect().bottom + 8
    Object.assign(el.style, { position: 'fixed', top: `${top}px`, left: '12px', right: '12px', width: 'auto', maxHeight: `${window.innerHeight - top - 12}px`, overflowY: 'auto' })
  }, [open, width])
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
