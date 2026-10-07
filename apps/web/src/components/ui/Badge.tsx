import type { CSSProperties } from 'react'

const COLOR_MAP: Record<string, { bg: string; color: string }> = {
  active:        { bg: '#e1f5ee', color: '#0F6E56' },
  present:       { bg: '#e1f5ee', color: '#0F6E56' },
  approved:      { bg: '#e1f5ee', color: '#0F6E56' },
  running:       { bg: '#e1f5ee', color: '#0F6E56' },
  pending:       { bg: '#faeeda', color: '#BA7517' },
  probation:     { bg: '#faeeda', color: '#BA7517' },
  confirmed:     { bg: '#eeedfe', color: '#534AB7' },
  rejected:      { bg: '#faece7', color: '#993C1D' },
  submitted:     { bg: '#faeeda', color: '#BA7517' },
  manager_approved: { bg: '#eeedfe', color: '#534AB7' },
  finance_approved: { bg: '#e1f5ee', color: '#0F6E56' },
  paid:          { bg: '#e1f5ee', color: '#0F6E56' },
  initiated:     { bg: '#faeeda', color: '#BA7517' },
  computed:      { bg: '#eeedfe', color: '#534AB7' },
  cleared:       { bg: '#e1f5ee', color: '#0F6E56' },
  withdrawn:     { bg: '#f5f4f0', color: '#5c5c58' },
  absent:        { bg: '#faece7', color: '#993C1D' },
  terminated:    { bg: '#faece7', color: '#993C1D' },
  cancelled:     { bg: '#f5f4f0', color: '#5c5c58' },
  expired:       { bg: '#f5f4f0', color: '#5c5c58' },
  archived:      { bg: '#f5f4f0', color: '#5c5c58' },
  full_time:     { bg: '#e6f1fb', color: '#185FA5' },
  part_time:     { bg: '#eeedfe', color: '#534AB7' },
  contractor:    { bg: '#faeeda', color: '#BA7517' },
  intern:        { bg: '#e6f1fb', color: '#185FA5' },
}

interface BadgeProps {
  label: string
  variant?: string
  style?: CSSProperties
}

export default function Badge({ label, variant, style }: BadgeProps) {
  const key = variant || label.toLowerCase().replace(/ /g, '_')
  const colors = COLOR_MAP[key] || { bg: '#f5f4f0', color: '#5c5c58' }

  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: '2px 10px', borderRadius: '12px',
      fontSize: '11px', fontWeight: '500',
      backgroundColor: colors.bg, color: colors.color,
      whiteSpace: 'nowrap',
      ...style,
    }}>
      {label.replace(/_/g, ' ')}
    </span>
  )
}
