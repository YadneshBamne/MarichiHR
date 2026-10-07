import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { gsap, reduced } from '../../lib/motion'
import Icon from './Icon'

type Kind = 'ok' | 'error' | 'info'
type T = { id: number; text: string; kind: Kind }
const Ctx = createContext<(text: string, kind?: Kind) => void>(() => {})

export const useToast = () => useContext(Ctx)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<T[]>([])
  const seq = useRef(0)
  const toast = useCallback((text: string, kind: Kind = 'ok') => {
    const id = ++seq.current
    setItems((x) => [...x.slice(-2), { id, text, kind }])
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), kind === 'error' ? 5200 : 3200)
  }, [])
  return (
    <Ctx.Provider value={toast}>
      {children}
      <div aria-live="polite" style={{ position: 'fixed', left: '50%', bottom: 26, transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center', zIndex: 1000, pointerEvents: 'none' }}>
        {items.map((t) => <ToastItem key={t.id} t={t} />)}
      </div>
    </Ctx.Provider>
  )
}

function ToastItem({ t }: { t: T }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!reduced()) gsap.fromTo(ref.current, { opacity: 0, y: 18, scale: 0.96 }, { opacity: 1, y: 0, scale: 1, duration: 0.45, ease: 'back.out(1.8)' })
  }, [])
  const icon = t.kind === 'error' ? 'alert' : t.kind === 'info' ? 'info' : 'checkCircle'
  return (
    <div ref={ref} role={t.kind === 'error' ? 'alert' : 'status'} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 18px 10px 14px', borderRadius: 999, background: 'var(--night)', color: 'var(--night-ink)', fontSize: 13, boxShadow: 'var(--shadow-pop)', maxWidth: 520 }}>
      <Icon name={icon} size={17} style={{ color: t.kind === 'error' ? '#f2a48d' : 'var(--honey)' }} />
      {t.text}
    </div>
  )
}
