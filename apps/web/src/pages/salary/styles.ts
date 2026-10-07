import type { CSSProperties } from 'react'

export const card: CSSProperties = { backgroundColor: 'var(--card)', backdropFilter: 'blur(18px)', border: '1px solid var(--hair)', boxShadow: 'var(--shadow)', borderRadius: 'var(--r-card)', overflow: 'hidden' }
export const th: CSSProperties = { padding: '10px 16px', textAlign: 'left', fontSize: 11, fontWeight: 500, color: 'var(--faint)', textTransform: 'uppercase', letterSpacing: '.04em', borderBottom: '1px solid var(--line)', backgroundColor: 'var(--solid)' }
export const td: CSSProperties = { padding: '11px 16px', fontSize: 13, color: 'var(--ink)', borderBottom: '1px solid var(--well)' }
export const empty: CSSProperties = { padding: 40, textAlign: 'center', color: 'var(--faint)', fontSize: 13 }
export const primaryBtn: CSSProperties = { padding: '9px 18px', backgroundColor: 'var(--brand)', color: 'var(--night-ink)', border: 'none', borderRadius: 12, fontSize: 13, fontWeight: 500, cursor: 'pointer' }
export const ghostBtn: CSSProperties = { padding: '9px 18px', backgroundColor: 'var(--well)', color: 'var(--ink)', border: '1px solid var(--line)', borderRadius: 12, fontSize: 13, cursor: 'pointer' }
export const linkBtn: CSSProperties = { background: 'none', border: 'none', color: 'var(--brand)', fontSize: 12, cursor: 'pointer', padding: '2px 6px' }
export const errorBox: CSSProperties = { marginTop: 12, backgroundColor: 'var(--danger-bg)', color: 'var(--danger)', borderRadius: 12, padding: '10px 12px', fontSize: 13 }
export const grid2: CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }
export const footer: CSSProperties = { display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }
