import type { CSSProperties } from 'react'

const COLOR_MAP: Record<string, { bg: string; color: string }> = {
  active:        { bg: 'var(--ok-bg)', color: 'var(--ok)' },
  present:       { bg: 'var(--ok-bg)', color: 'var(--ok)' },
  approved:      { bg: 'var(--ok-bg)', color: 'var(--ok)' },
  running:       { bg: 'var(--ok-bg)', color: 'var(--ok)' },
  pending:       { bg: 'var(--warn-bg)', color: 'var(--warn)' },
  probation:     { bg: 'var(--warn-bg)', color: 'var(--warn)' },
  confirmed:     { bg: 'var(--honey-2)', color: 'var(--honey-ink)' },
  rejected:      { bg: 'var(--danger-bg)', color: 'var(--danger)' },
  submitted:     { bg: 'var(--warn-bg)', color: 'var(--warn)' },
  manager_approved: { bg: 'var(--honey-2)', color: 'var(--honey-ink)' },
  finance_approved: { bg: 'var(--ok-bg)', color: 'var(--ok)' },
  paid:          { bg: 'var(--ok-bg)', color: 'var(--ok)' },
  initiated:     { bg: 'var(--warn-bg)', color: 'var(--warn)' },
  computed:      { bg: 'var(--honey-2)', color: 'var(--honey-ink)' },
  cleared:       { bg: 'var(--ok-bg)', color: 'var(--ok)' },
  withdrawn:     { bg: 'var(--well)', color: 'var(--dim)' },
  absent:        { bg: 'var(--danger-bg)', color: 'var(--danger)' },
  terminated:    { bg: 'var(--danger-bg)', color: 'var(--danger)' },
  cancelled:     { bg: 'var(--well)', color: 'var(--dim)' },
  expired:       { bg: 'var(--well)', color: 'var(--dim)' },
  archived:      { bg: 'var(--well)', color: 'var(--dim)' },
  full_time:     { bg: 'var(--info-bg)', color: 'var(--info)' },
  part_time:     { bg: 'var(--honey-2)', color: 'var(--honey-ink)' },
  contractor:    { bg: 'var(--warn-bg)', color: 'var(--warn)' },
  intern:        { bg: 'var(--info-bg)', color: 'var(--info)' },
}

interface BadgeProps {
  label: string
  variant?: string
  style?: CSSProperties
}

export default function Badge({ label, variant, style }: BadgeProps) {
  const key = variant || label.toLowerCase().replace(/ /g, '_')
  const colors = COLOR_MAP[key] || { bg: 'var(--well)', color: 'var(--dim)' }

  return (
    <span className="pill" style={{ backgroundColor: colors.bg, color: colors.color, ...style }}>
      {label.replace(/_/g, ' ')}
    </span>
  )
}
