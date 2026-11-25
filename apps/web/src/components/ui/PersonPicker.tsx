import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import api from '../../lib/api'

export interface PersonLite { id: string; name: string; code?: string }
interface Props {
  value: string // the chosen person's id ('' = nobody)
  onChange: (id: string, person: PersonLite | null) => void
  id?: string
  placeholder?: string
  excludeIds?: string[]
  initialName?: string // shown for a value that is set from outside, so it needs no lookup
  includeArchived?: boolean
}

// Searches the server as you type (it never stops at the first 100 people). Pick a person; "Change" lets you search again.
export default function PersonPicker({ value, onChange, id, placeholder = 'Search by name or code', excludeIds = [], initialName, includeArchived }: Props) {
  const [text, setText] = useState('')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<PersonLite | null>(value && initialName ? { id: value, name: initialName } : null)
  useEffect(() => { const t = setTimeout(() => setQ(text.trim()), 250); return () => clearTimeout(t) }, [text])
  // a value set from outside without a name is looked up once
  useEffect(() => {
    if (!value) { setPicked(null); return }
    if (picked?.id === value) return
    let live = true
    api.get(`/employees/${value}`).then((r) => { if (live) setPicked({ id: value, name: `${r.data.data.firstName} ${r.data.data.lastName}`, code: r.data.data.employeeCode }) }).catch(() => { if (live) setPicked({ id: value, name: 'Chosen person' }) })
    return () => { live = false }
  }, [value]) // eslint-disable-line react-hooks/exhaustive-deps
  const found = useQuery({ queryKey: ['person-picker', q, !!includeArchived], enabled: open, staleTime: 15_000, queryFn: async () => (await api.get('/employees', { params: { search: q || undefined, limit: 12, status: includeArchived ? 'all' : 'active' } })).data.data as any[] })
  const rows = (found.data ?? []).filter((p) => !excludeIds.includes(p.id))
  const choose = (p: any) => { const lite = { id: p.id, name: `${p.firstName} ${p.lastName}`, code: p.employeeCode }; setPicked(lite); setText(''); setOpen(false); onChange(p.id, lite) }
  return (
    <div style={{ position: 'relative' }}>
      {picked ? (
        <div className="input" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span>{picked.name}{picked.code && <span className="dim" style={{ fontSize: 12 }}> · {picked.code}</span>}</span>
          <button type="button" className="link" onClick={() => { setPicked(null); onChange('', null) }}>Change</button>
        </div>
      ) : (
        <input id={id} className="input" value={text} placeholder={placeholder} autoComplete="off" onChange={(e) => setText(e.target.value)} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} />
      )}
      {open && !picked && (
        <ul role="listbox" className="card" style={{ position: 'absolute', zIndex: 40, left: 0, right: 0, top: '100%', marginTop: 4, maxHeight: 240, overflowY: 'auto', padding: 6, listStyle: 'none' }}>
          {found.isLoading && <li className="dim" style={{ padding: 8, fontSize: 13 }}>Searching…</li>}
          {!found.isLoading && !rows.length && <li className="dim" style={{ padding: 8, fontSize: 13 }}>No one found</li>}
          {rows.map((p) => (
            <li key={p.id}>
              <button type="button" className="btn btn-ghost btn-sm" style={{ width: '100%', justifyContent: 'flex-start', textAlign: 'left' }} onMouseDown={(e) => { e.preventDefault(); choose(p) }}>
                {p.firstName} {p.lastName} <span className="dim" style={{ fontSize: 12 }}>{p.employeeCode}{p.jobPosition?.title ? ` · ${p.jobPosition.title}` : ''}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
