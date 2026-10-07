// Warm initials avatar (or the real photo when there is one); the tint is stable per name
const TINTS = ['#f6c343', '#e9c9a1', '#cfd9c4', '#d9cbe6', '#f2b8a2', '#c7dbe6', '#e6dcc0', '#bfd8d2']

export default function Avatar({ name, src, size = 32, ring }: { name: string; src?: string | null; size?: number; ring?: boolean }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?'
  const tint = TINTS[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % TINTS.length]
  const common = { width: size, height: size, borderRadius: '50%', flexShrink: 0, boxShadow: ring ? '0 0 0 3px var(--card-2)' : undefined } as const
  if (src) return <img src={src} alt="" style={{ ...common, objectFit: 'cover' }} />
  return (
    <span aria-hidden="true" style={{ ...common, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: tint, color: 'var(--ink)', fontSize: size * 0.38, fontWeight: 600, fontFamily: 'var(--font-display)' }}>
      {initials}
    </span>
  )
}
