import type { ReactNode } from 'react'

interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  width?: number
}

export default function Modal({ open, onClose, title, children, width = 560 }: ModalProps) {
  if (!open) return null

  return (
    <div style={s.overlay} onClick={onClose}>
      <div style={{ ...s.modal, width }} onClick={(e) => e.stopPropagation()}>
        <div style={s.header}>
          <span style={s.title}>{title}</span>
          <button style={s.close} onClick={onClose}>✕</button>
        </div>
        <div style={s.body}>{children}</div>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.3)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 1000, padding: '16px',
  },
  modal: {
    backgroundColor: '#fff', borderRadius: '12px',
    border: '0.5px solid #e2e0da', maxHeight: '90vh',
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '16px 20px', borderBottom: '0.5px solid #e2e0da', flexShrink: 0,
  },
  title: { fontSize: '15px', fontWeight: '500', color: '#1a1a18' },
  close: {
    background: 'none', border: 'none', fontSize: '16px',
    color: '#8c8c88', cursor: 'pointer', padding: '4px',
  },
  body: { padding: '20px', overflowY: 'auto', flex: 1 },
}
