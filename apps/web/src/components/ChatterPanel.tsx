import { useState } from 'react'
import { useChatter, usePostChatterMessage } from '../lib/hooks/useChatter'
import { useAuth } from '../contexts/AuthContext'

interface Props {
  entityType: string
  entityId: string
}

export default function ChatterPanel({ entityType, entityId }: Props) {
  const { isHR } = useAuth()
  const [body, setBody] = useState('')
  const [isInternal, setIsInternal] = useState(false)
  const { data: messages = [], isLoading } = useChatter(entityType, entityId)
  const postMessage = usePostChatterMessage(entityType, entityId)

  const handlePost = async () => {
    if (!body.trim()) return
    await postMessage.mutateAsync({ body: body.trim(), messageType: 'comment', isInternal })
    setBody('')
    setIsInternal(false)
  }

  const formatTime = (iso: string) =>
    new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

  return (
    <div style={s.root}>
      <div style={s.title}>Activity & Comments</div>

      {isLoading ? (
        <div style={s.empty}>Loading...</div>
      ) : messages.length === 0 ? (
        <div style={s.empty}>No activity yet.</div>
      ) : (
        <div style={s.messages}>
          {messages.map((msg: any) => (
            <div key={msg.id} style={{
              ...s.message,
              ...(msg.messageType === 'system_log' ? s.systemMessage : {}),
              ...(msg.isInternal ? s.internalMessage : {}),
            }}>
              <div style={s.msgHeader}>
                <span style={s.author}>
                  {msg.messageType === 'system_log' ? '⚙ System' : msg.authorName || 'Unknown'}
                </span>
                {msg.isInternal && <span style={s.internalBadge}>Internal</span>}
                <span style={s.time}>{formatTime(msg.createdAt)}</span>
              </div>
              <div style={s.msgBody}>{msg.body}</div>
            </div>
          ))}
        </div>
      )}

      <div style={s.compose}>
        <textarea
          style={s.textarea}
          placeholder="Add a comment..."
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={2}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handlePost()
          }}
        />
        <div style={s.composeFooter}>
          {isHR && (
            <label style={s.internalToggle}>
              <input
                type="checkbox"
                checked={isInternal}
                onChange={(e) => setIsInternal(e.target.checked)}
              />
              <span style={{ marginLeft: '6px', fontSize: '12px', color: 'var(--dim)' }}>Internal note</span>
            </label>
          )}
          <button
            style={{ ...s.postBtn, opacity: !body.trim() || postMessage.isPending ? 0.5 : 1 }}
            onClick={handlePost}
            disabled={!body.trim() || postMessage.isPending}
          >
            {postMessage.isPending ? 'Posting...' : 'Post'}
          </button>
        </div>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', gap: '12px' },
  title: { fontSize: '13px', fontWeight: '500', color: 'var(--ink)' },
  empty: { fontSize: '13px', color: 'var(--faint)', padding: '12px 0' },
  messages: { display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '400px', overflowY: 'auto' },
  message: { backgroundColor: 'var(--solid)', borderRadius: '14px', padding: '10px 12px', border: '1px solid var(--line)' },
  systemMessage: { backgroundColor: 'var(--well)', border: '1px solid var(--line)' },
  internalMessage: { backgroundColor: 'var(--warn-bg)', border: '1px solid var(--honey-2)' },
  msgHeader: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' },
  author: { fontSize: '12px', fontWeight: '500', color: 'var(--ink)' },
  internalBadge: { fontSize: '10px', backgroundColor: 'var(--warn)', color: 'var(--night-ink)', padding: '1px 6px', borderRadius: '14px' },
  time: { fontSize: '11px', color: 'var(--faint)', marginLeft: 'auto' },
  msgBody: { fontSize: '13px', color: 'var(--dim)', lineHeight: 1.5 },
  compose: { borderTop: '1px solid var(--line)', paddingTop: '12px' },
  textarea: { width: '100%', padding: '10px 12px', borderRadius: '12px', border: '1px solid var(--line-2)', fontSize: '13px', resize: 'vertical', fontFamily: 'inherit', outline: 'none' },
  composeFooter: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '8px' },
  internalToggle: { display: 'flex', alignItems: 'center', cursor: 'pointer' },
  postBtn: { padding: '7px 16px', backgroundColor: 'var(--brand)', color: 'var(--night-ink)', border: 'none', borderRadius: 999, fontSize: '13px', fontWeight: '500', cursor: 'pointer' },
}
