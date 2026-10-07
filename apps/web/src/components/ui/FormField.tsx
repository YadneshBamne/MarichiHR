import type { ReactNode, CSSProperties } from 'react'

interface FormFieldProps {
  label: string
  error?: string
  required?: boolean
  children: ReactNode
  style?: CSSProperties
}

export function FormField({ label, error, required, children, style }: FormFieldProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', ...style }}>
      <label style={{ fontSize: '12px', fontWeight: '500', color: 'var(--dim)' }}>
        {label} {required && <span style={{ color: 'var(--danger)' }}>*</span>}
      </label>
      {children}
      {error && <span style={{ fontSize: '12px', color: 'var(--danger)' }}>{error}</span>}
    </div>
  )
}

export const inputStyle: CSSProperties = {
  height: 40, padding: '0 14px', borderRadius: 14,
  border: '1px solid var(--line)', fontSize: 13,
  outline: 'none', color: 'var(--ink)', backgroundColor: 'var(--card-2)',
  width: '100%',
}

export const selectStyle: CSSProperties = {
  ...inputStyle,
  cursor: 'pointer',
}
