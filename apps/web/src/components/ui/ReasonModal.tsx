import { useState, type ReactNode } from 'react'
import Modal from './Modal'

// A dialog that asks for a reason (or a note) before something that matters: withdrawing a goal, removing someone from a review cycle, cancelling a review.
// Replaces the browser's prompt box. The button stays off until the text is long enough.
export default function ReasonModal({ title, label, help, min = 5, confirmLabel, busy, optional, onSubmit, onClose }: {
  title: string; label: string; help?: ReactNode; min?: number; confirmLabel: string; busy?: boolean; optional?: boolean; onSubmit: (text: string) => void; onClose: () => void
}) {
  const [text, setText] = useState('')
  const ok = optional ? true : text.trim().length >= min
  return (
    <Modal open onClose={onClose} title={title} width={460}>
      <div style={{ display: 'grid', gap: 12 }}>
        {help && <p className="dim" style={{ margin: 0, fontSize: 13 }}>{help}</p>}
        <label className="field"><span>{label}{optional ? ' (optional)' : ''}</span>
          <textarea className="input" rows={3} value={text} onChange={(e) => setText(e.target.value)} maxLength={500} style={{ height: 'auto', padding: 12 }} autoFocus />
        </label>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!ok || busy} onClick={() => onSubmit(text.trim())}>{busy ? 'Saving…' : confirmLabel}</button>
        </div>
      </div>
    </Modal>
  )
}
