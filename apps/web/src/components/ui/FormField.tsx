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
      <label style={{ fontSize: '13px', fontWeight: '500', color: '#1a1a18' }}>
        {label} {required && <span style={{ color: '#993C1D' }}>*</span>}
      </label>
      {children}
      {error && <span style={{ fontSize: '12px', color: '#993C1D' }}>{error}</span>}
    </div>
  )
}

export const inputStyle: CSSProperties = {
  padding: '9px 12px', borderRadius: '6px',
  border: '0.5px solid #ccc9c1', fontSize: '13px',
  outline: 'none', color: '#1a1a18', backgroundColor: '#fff',
  width: '100%',
}

export const selectStyle: CSSProperties = {
  ...inputStyle,
  cursor: 'pointer',
}
