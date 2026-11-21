import { useEffect, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import api from '../lib/api'
import { useCompany } from '../lib/hooks/useCompany'
import { useToast } from './ui/Toast'
import Icon from './ui/Icon'

type Proposal = { type: 'helpdesk_ticket'; categoryId: string; categoryName: string; subject: string; description: string; priority: string; sent?: string }
type Msg = { role: 'user' | 'assistant'; content: string; proposals?: Proposal[] }
const errText = (e: any) => e?.response?.data?.message || 'The assistant could not answer. Try again.'

// The company's own assistant: a button that opens a chat. It only appears when the company's plan includes it.
// It cannot change anything itself: a helpdesk ticket it prepares is sent only when the person presses Send.
export default function AssistantPanel() {
  const { data: company } = useCompany()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [text, setText] = useState('')
  const end = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [msgs, open])
  useEffect(() => { if (open) field.current?.focus() }, [open])
  useEffect(() => { if (!open) return; const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k) }, [open])

  const ask = useMutation({
    mutationFn: async (history: Msg[]) => (await api.post('/assistant/chat', { messages: history.map(({ role, content }) => ({ role, content })).slice(-20) })).data.data as { reply: string; proposals: Proposal[] },
    onSuccess: (d) => setMsgs((m) => [...m, { role: 'assistant', content: d.reply, proposals: d.proposals }]),
    onError: (e) => setMsgs((m) => [...m, { role: 'assistant', content: e instanceof Error && (e as any).response?.status === 404 ? "The assistant isn't available on this server." : errText(e) }]),
  })
  const send = () => {
    const t = text.trim()
    if (!t || ask.isPending) return
    const next = [...msgs, { role: 'user' as const, content: t }]
    setMsgs(next); setText(''); ask.mutate(next)
  }
  const sendTicket = useMutation({
    mutationFn: async (p: Proposal) => (await api.post('/helpdesk/tickets', { categoryId: p.categoryId, subject: p.subject, description: p.description, priority: p.priority })).data.data,
    onSuccess: (t, p) => { toast(`${t.number} sent to HR`); setMsgs((m) => m.map((x) => ({ ...x, proposals: x.proposals?.map((q) => (q === p ? { ...q, sent: t.number } : q)) }))) },
    onError: (e) => toast(errText(e), 'error'),
  })

  if (!company?.entitlements?.features?.includes('assistant')) return null
  return (
    <>
      <button type="button" aria-label="Open the assistant" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        style={{ position: 'fixed', right: 20, bottom: 20, zIndex: 40, width: 56, height: 56, borderRadius: '50%', border: 0, background: 'var(--honey)', color: 'var(--ink)', display: 'grid', placeItems: 'center', cursor: 'pointer', boxShadow: 'none' }}>
        <Icon name={open ? 'x' : 'sparkle'} size={22} />
      </button>
      {open && (
        <div role="dialog" aria-label="Assistant" style={{ position: 'fixed', right: 20, bottom: 88, zIndex: 40, width: 'min(400px, calc(100vw - 32px))', height: 'min(560px, calc(100vh - 120px))', display: 'flex', flexDirection: 'column', background: '#fff', border: '1.5px solid var(--line-2)', borderRadius: 28, overflow: 'hidden' }}>
          <div style={{ padding: '16px 20px', borderBottom: '1.5px solid var(--line-2)', fontWeight: 700 }}>Assistant <span style={{ fontWeight: 400, opacity: 0.6, fontSize: 13 }}>· {company.name}</span></div>
          <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'grid', gap: 10, alignContent: 'start' }}>
            {msgs.length === 0 && <p style={{ margin: 0, opacity: 0.7 }}>Ask about your payslips, your tickets, your timesheet or your team. For HR questions I can prepare a ticket for you to send.</p>}
            {msgs.map((m, i) => (
              <div key={i} style={{ justifySelf: m.role === 'user' ? 'end' : 'start', maxWidth: '88%' }}>
                <div style={{ padding: '10px 14px', borderRadius: 20, background: m.role === 'user' ? 'var(--ink)' : '#f4f1e8', color: m.role === 'user' ? '#fff' : 'var(--ink)', whiteSpace: 'pre-wrap' }}>{m.content}</div>
                {m.proposals?.map((p, j) => (
                  <div key={j} style={{ marginTop: 8, padding: 14, borderRadius: 20, border: '1.5px solid var(--line-2)', display: 'grid', gap: 6 }}>
                    <strong>Ticket to HR · {p.categoryName}</strong>
                    <div>{p.subject}</div>
                    <div style={{ fontSize: 13, opacity: 0.75, whiteSpace: 'pre-wrap' }}>{p.description}</div>
                    {p.sent ? <span className="pill ok">{p.sent} sent</span> : <button className="btn btn-primary btn-sm" disabled={sendTicket.isPending} onClick={() => sendTicket.mutate(p)}>Send to HR</button>}
                  </div>
                ))}
              </div>
            ))}
            {ask.isPending && <div style={{ opacity: 0.6 }}>Thinking…</div>}
            <div ref={end} />
          </div>
          <div style={{ padding: 12, borderTop: '1.5px solid var(--line-2)', display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <textarea ref={field} aria-label="Message" className="input" rows={1} maxLength={2000} placeholder="Ask something…" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} style={{ height: 'auto', minHeight: 44, padding: '11px 18px', borderRadius: 22, resize: 'none', flex: 1 }} />
            <button className="btn btn-primary btn-sm" style={{ height: 44 }} disabled={!text.trim() || ask.isPending} onClick={send}>Send</button>
          </div>
        </div>
      )}
    </>
  )
}
