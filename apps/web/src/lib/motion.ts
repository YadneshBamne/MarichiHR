import { useLayoutEffect, useEffect, useRef } from 'react'
import { gsap } from 'gsap'

// One motion language for the whole app: things rise in softly, numbers count up, bars grow.
export const reduced = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
export const EASE = 'power3.out'

// Stagger every [data-card] inside the container up into place when the page mounts (or `key` changes)
export function useReveal<T extends HTMLElement>(key: unknown = null) {
  const ref = useRef<T>(null)
  useLayoutEffect(() => {
    const root = ref.current
    if (!root || reduced()) return
    const ctx = gsap.context(() => {
      const head = root.querySelectorAll('[data-rise]')
      const cards = root.querySelectorAll('[data-card]')
      if (head.length) gsap.fromTo(head, { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.5, ease: EASE, stagger: 0.05, clearProps: 'opacity,transform' })
      if (cards.length) gsap.fromTo(cards, { opacity: 0, y: 34, scale: 0.985 }, { opacity: 1, y: 0, scale: 1, duration: 0.8, ease: EASE, stagger: 0.06, delay: 0.06, clearProps: 'transform,opacity' })
    }, root)
    return () => ctx.revert()
  }, [key])
  return ref
}

// Rows of a table or list slide in after their card
export function useRowsIn<T extends HTMLElement>(key: unknown) {
  const ref = useRef<T>(null)
  useLayoutEffect(() => {
    const root = ref.current
    if (!root || reduced()) return
    const rows = root.querySelectorAll('[data-row]')
    if (!rows.length) return
    const t = gsap.fromTo(rows, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.45, ease: EASE, stagger: 0.03, delay: 0.15, clearProps: 'opacity,transform' })
    return () => { t.kill() }
  }, [key])
  return ref
}

// Animate a number up to `value` whenever it changes
export function useCountUp(value: number | null | undefined, format: (n: number) => string = (n) => Math.round(n).toLocaleString()) {
  const ref = useRef<HTMLSpanElement>(null)
  const last = useRef(0)
  useEffect(() => {
    const el = ref.current
    if (!el || value == null || !Number.isFinite(value)) return
    if (reduced()) { el.textContent = format(value); last.current = value; return }
    const o = { v: last.current }
    const t = gsap.to(o, { v: value, duration: 1.1, ease: EASE, onUpdate: () => { el.textContent = format(o.v) } })
    last.current = value
    return () => { t.kill() }
  }, [value]) // eslint-disable-line react-hooks/exhaustive-deps
  return ref
}

// Little "pop" used on ticks, badges and confirmations
export function pop(el: Element | null, from = 0.6) {
  if (!el || reduced()) return
  gsap.fromTo(el, { scale: from }, { scale: 1, duration: 0.55, ease: 'back.out(3)', clearProps: 'transform' })
}

export { gsap }

// Dev only: lets the browser console speed up or inspect motion (gsap.globalTimeline.timeScale(10))
if (import.meta.env.DEV && typeof window !== 'undefined') (window as any).gsap = gsap
