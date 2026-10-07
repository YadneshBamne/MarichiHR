// The MarichiHR mark: a sun half-lit in honey (Marichi = a ray of light)
export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="13" fill="var(--night)" />
      <path d="M16 3a13 13 0 0 0 0 26z" fill="var(--honey)" />
      <circle cx="16" cy="16" r="5" fill="var(--night-ink)" />
    </svg>
  )
}

export default function Logo({ size = 22, text = true }: { size?: number; text?: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
      <Mark size={size} />
      {text && <span style={{ fontFamily: 'var(--font-display)', fontSize: size * 0.82, fontWeight: 500, letterSpacing: '-0.02em' }}>Marichi<span style={{ color: 'var(--faint)' }}>HR</span></span>}
    </span>
  )
}
