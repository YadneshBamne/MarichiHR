import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import api from '../lib/api'
import { useAuth } from '../contexts/AuthContext'
import { gsap, reduced } from '../lib/motion'
import Icon from './ui/Icon'
import { Mark } from './brand/Logo'

// Step-by-step walkthrough shown on first sign-in (and from the profile menu). Steps whose target isn't on screen
// for this user (role-gated parts) are skipped automatically. Finishing or skipping is saved on the account.
type Step = { target?: string; title: string; body: string; roles?: string[] }

const STEPS: Step[] = [
  { title: 'Welcome to {company}', body: 'Your people, time, leave and pay in one place. This quick tour shows you around; it takes about a minute and you can skip it any time.' },
  { target: 'sections', title: 'Everything in six sections', body: 'Overview, People, Time, Pay, Work and Insights. Pick a section here; its pages appear as chips just below.' },
  { target: 'search', title: 'Jump anywhere', body: 'Search finds any page or action. Press Ctrl K (⌘ K on Mac) from anywhere in the app.' },
  { target: 'kpis', title: 'Your month at a glance', body: 'Leave used, attendance and the headline numbers for you and, if you manage people, your team.' },
  { target: 'clock', title: 'Clock in and out', body: 'Start your day here. The timer runs while you are clocked in and your hours flow into attendance and payroll.' },
  { target: 'tasks', title: 'Your task list', body: 'Activities assigned to you show up here. Tick one off when it is done; the record is updated straight away.' },
  { target: 'week', title: 'Your week', body: 'Approved leave for you and your team, and public holidays, laid out by day.' },
  { target: 'section-work', title: 'Approvals', body: 'Leave, attendance and expense requests waiting for you are in Work → Approvals. A dot appears here when something is pending.', roles: ['manager', 'hr_admin', 'system_admin'] },
  { target: 'notifications', title: 'Notifications', body: 'Approvals, payslips, contract reminders and anything that needs you lands here.' },
  { target: 'profile', title: 'Your account', body: 'Your profile, two-factor security, settings and this tour live here. Sign out from here too.' },
  { title: 'You are all set', body: 'Modules marked “Soon” are on the roadmap and open a preview of what is coming. Enjoy {company}.' },
]

const PAD = 8

export default function ProductTour({ onClose }: { onClose: () => void }) {
  const { user, updateUser } = useAuth()
  const roles = user?.roles?.map((r) => r.name) ?? []
  const company = user?.tenant?.name || 'MarichiHR'
  const steps = useMemo(() => STEPS.map((s) => ({ ...s, title: s.title.replace('{company}', company), body: s.body.replace('{company}', company) })).filter((s) => (!s.roles || s.roles.some((r) => roles.includes(r))) && (!s.target || document.querySelector(`[data-tour="${s.target}"]`))), []) // eslint-disable-line react-hooks/exhaustive-deps
  const [i, setI] = useState(0)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const spot = useRef<HTMLDivElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const step = steps[i]

  const finish = useCallback(async () => {
    onClose()
    try {
      const r = await api.post('/auth/me/tour', { status: 'done' })
      updateUser({ tourDoneAt: r.data.data.tourDoneAt })
    } catch { /* the tour simply shows again next time */ }
  }, [onClose, updateUser])

  const measure = useCallback(() => {
    const el = step?.target ? document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`) : null
    if (el) el.scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' })
    setRect(el ? el.getBoundingClientRect() : null)
  }, [step])

  useLayoutEffect(() => { measure() }, [measure])
  useEffect(() => {
    const t = setTimeout(measure, 350) // after smooth scroll settles
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => { clearTimeout(t); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true) }
  }, [measure])

  // Spotlight glides between targets; the card pops in for each step
  useLayoutEffect(() => {
    if (!spot.current) return
    const to = rect
      ? { x: rect.left - PAD, y: rect.top - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2, borderRadius: Math.min(30, rect.height / 2 + PAD), opacity: 1 }
      : { x: window.innerWidth / 2, y: window.innerHeight / 2, width: 0, height: 0, borderRadius: 0, opacity: 1 }
    if (reduced()) gsap.set(spot.current, to)
    else gsap.to(spot.current, { ...to, duration: 0.6, ease: 'expo.out' })
  }, [rect])
  useLayoutEffect(() => {
    if (card.current && !reduced()) gsap.fromTo(card.current, { opacity: 0, y: 12, scale: 0.97 }, { opacity: 1, y: 0, scale: 1, duration: 0.5, ease: 'back.out(1.6)', delay: 0.12 })
  }, [i])

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish()
      else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); i < steps.length - 1 ? setI(i + 1) : finish() }
      else if (e.key === 'ArrowLeft' && i > 0) setI(i - 1)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [i, steps.length, finish])

  if (!step) return null
  const last = i === steps.length - 1
  const W = 360
  const vw = window.innerWidth, vh = window.innerHeight
  let pos: React.CSSProperties
  if (!rect) pos = { left: vw / 2 - W / 2, top: vh / 2 - 130 }
  else {
    const below = rect.bottom + PAD + 14
    const fitsBelow = below + 230 < vh
    const left = Math.max(16, Math.min(vw - W - 16, rect.left + rect.width / 2 - W / 2))
    pos = fitsBelow ? { left, top: below } : { left, top: Math.max(16, rect.top - PAD - 14 - 230) }
  }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="tour-title" style={{ position: 'fixed', inset: 0, zIndex: 1100 }}>
      <div onClick={() => {}} style={{ position: 'absolute', inset: 0 }} />
      <div ref={spot} aria-hidden="true" style={{ position: 'fixed', left: 0, top: 0, width: 0, height: 0, opacity: 0, boxShadow: '0 0 0 9999px rgba(37,37,35,0.55), 0 0 0 2px var(--honey), 0 0 30px 6px rgba(246,195,67,.35)', pointerEvents: 'none' }} />
      <div ref={card} className="card" style={{ position: 'fixed', width: W, maxWidth: 'calc(100vw - 32px)', padding: 22, background: 'var(--solid)', boxShadow: 'var(--shadow-pop)', ...pos }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          {!step.target ? <Mark size={26} /> : <span className="pill honey" style={{ textTransform: 'none' }}>Step {i} of {steps.length - 2}</span>}
          <button onClick={finish} className="link" style={{ marginLeft: 'auto', color: 'var(--faint)' }}>Skip tour</button>
        </div>
        <h2 id="tour-title" style={{ fontSize: 22, marginBottom: 6 }}>{step.title}</h2>
        <p className="dim" style={{ fontSize: 13.5, lineHeight: 1.55 }}>{step.body}</p>
        <div style={{ display: 'flex', alignItems: 'center', marginTop: 18, gap: 8 }}>
          <div style={{ display: 'flex', gap: 5, flex: 1 }} aria-hidden="true">
            {steps.map((_, n) => <span key={n} style={{ width: n === i ? 18 : 6, height: 6, borderRadius: 3, background: n === i ? 'var(--night)' : n < i ? 'var(--honey)' : 'var(--line-2)', transition: 'all .4s var(--ease)' }} />)}
          </div>
          {i > 0 && <button className="btn btn-ghost btn-sm" onClick={() => setI(i - 1)}><Icon name="chevronLeft" size={14} /> Back</button>}
          <button autoFocus className="btn btn-primary btn-sm" onClick={() => (last ? finish() : setI(i + 1))}>
            {i === 0 ? 'Show me around' : last ? 'Finish' : 'Next'} {!last && <Icon name="arrowRight" size={14} />}
          </button>
        </div>
      </div>
    </div>
  )
}
