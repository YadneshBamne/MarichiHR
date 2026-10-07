import type { ReactNode } from 'react'

// Large display title on the left, actions on the right (the People-view header)
export default function PageHeader({ title, sub, actions, children }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <header data-rise style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 260px', minWidth: 0 }}>
          <h1 style={{ fontSize: 'clamp(34px, 4.2vw, 50px)', lineHeight: 1.05 }}>{title}</h1>
          {sub && <p className="dim" style={{ marginTop: 6, fontSize: 14 }}>{sub}</p>}
        </div>
        {actions && <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>{actions}</div>}
      </div>
      {children && <div style={{ marginTop: 16 }}>{children}</div>}
    </header>
  )
}

export function SearchField({ value, onChange, placeholder = 'Search', width = 260 }: { value: string; onChange: (v: string) => void; placeholder?: string; width?: number }) {
  return (
    <label style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" style={{ position: 'absolute', left: 14, color: 'var(--faint)' }}><path d="M11 18.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15M20.5 20.5l-4.2-4.2" /></svg>
      <input className="input" type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} style={{ width, borderRadius: 999, paddingLeft: 38 }} />
    </label>
  )
}

export function EmptyState({ icon, title, body, action }: { icon: ReactNode; title: string; body?: string; action?: ReactNode }) {
  return (
    <div style={{ textAlign: 'center', padding: '48px 20px' }}>
      <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'var(--well)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--dim)' }}>{icon}</div>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 20, marginTop: 14 }}>{title}</div>
      {body && <p className="dim" style={{ fontSize: 13, marginTop: 6, maxWidth: 380, marginInline: 'auto', lineHeight: 1.5 }}>{body}</p>}
      {action && <div style={{ marginTop: 16 }}>{action}</div>}
    </div>
  )
}
