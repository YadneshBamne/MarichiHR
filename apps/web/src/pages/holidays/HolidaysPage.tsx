import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import { useAuth } from '../../contexts/AuthContext'
import { useWorkLocations } from '../../lib/hooks/useEmployees'
import PageHeader from '../../components/ui/PageHeader'
import Modal from '../../components/ui/Modal'
import Icon from '../../components/ui/Icon'
import { useToast } from '../../components/ui/Toast'
import { useReveal } from '../../lib/motion'

interface Holiday { id: string; name: string; date: string; type: string; isOptional: boolean }
interface Calendar { id: string; name: string; year: number; countryCode: string | null; workLocationId: string | null; workLocation: string | null; appliesToMe: boolean; holidays: Holiday[] }
type NewHoliday = { name: string; date: string; type?: string; isOptional?: boolean }

const TYPES = ['national', 'regional', 'religious', 'company'] as const
const fmt = (d: string, o: Intl.DateTimeFormatOptions) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', ...o })
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'

// Paste from a spreadsheet or a government list: one holiday per line, "2026-01-26, Republic Day" (tab, comma or
// " - " between); add "optional" anywhere on the line to mark it optional
export function parseHolidayLines(text: string, year: number): { ok: NewHoliday[]; bad: string[] } {
  const ok: NewHoliday[] = [], bad: string[] = []
  for (const raw of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const m = raw.match(/^(\d{4}-\d{2}-\d{2})\s*(?:[,\t;|]|\s-\s)\s*(.+)$/) || raw.match(/^(.+?)\s*(?:[,\t;|]|\s-\s)\s*(\d{4}-\d{2}-\d{2})$/)
    if (!m) { bad.push(raw); continue }
    const [date, rest] = /^\d{4}/.test(m[1]) ? [m[1], m[2]] : [m[2], m[1]]
    const optional = /\boptional\b/i.test(rest)
    const name = rest.replace(/[,\t;|]?\s*\boptional\b/i, '').trim()
    if (Number(date.slice(0, 4)) !== year || isNaN(Date.parse(`${date}T00:00:00Z`)) || !name) { bad.push(raw); continue }
    ok.push({ date, name, isOptional: optional, type: 'national' })
  }
  return { ok, bad }
}

export default function HolidaysPage() {
  const { hasRole } = useAuth()
  const canManage = hasRole('hr_admin') || hasRole('system_admin')
  const qc = useQueryClient()
  const toast = useToast()
  const [year, setYear] = useState(new Date().getFullYear())
  const { data, isLoading } = useQuery({ queryKey: ['holidays', year], queryFn: async () => (await api.get('/holidays', { params: { year } })).data.data as { calendars: Calendar[] } })
  const calendars = data?.calendars ?? []
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<Calendar | null>(null)
  const [adding, setAdding] = useState<Calendar | null>(null)
  const root = useReveal<HTMLDivElement>(isLoading)
  const refresh = () => { qc.invalidateQueries({ queryKey: ['holidays'] }); qc.invalidateQueries({ queryKey: ['dashboard'] }) }
  const call = useMutation({
    mutationFn: async (f: () => Promise<unknown>) => f(),
    onSuccess: refresh,
    onError: (e) => toast(errMsg(e), 'error'),
  })

  // The viewer's own holidays: every calendar that applies to them, one line per date
  const mine = useMemo(() => {
    const m = new Map<string, Holiday & { calendar: string }>()
    for (const c of calendars) if (c.appliesToMe) for (const h of c.holidays) if (!m.has(h.date) || (m.get(h.date)!.isOptional && !h.isOptional)) m.set(h.date, { ...h, calendar: c.name })
    return [...m.values()].sort((a, b) => a.date.localeCompare(b.date))
  }, [calendars])
  const today = new Date().toISOString().slice(0, 10)
  const next = mine.find((h) => h.date >= today && !h.isOptional)
  const offDays = mine.filter((h) => !h.isOptional && ![0, 6].includes(new Date(`${h.date}T00:00:00Z`).getUTCDay())).length

  return (
    <div ref={root}>
      <PageHeader
        title="Holiday calendar"
        sub={isLoading ? 'Loading…' : canManage ? `${calendars.length} calendar${calendars.length === 1 ? '' : 's'} for ${year}` : `${offDays} weekday holiday${offDays === 1 ? '' : 's'} for you in ${year}`}
        actions={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn btn-ghost btn-icon btn-sm" onClick={() => setYear(year - 1)} aria-label="Previous year"><Icon name="chevronLeft" size={14} /></button>
            <span className="btn btn-ghost btn-sm num" style={{ pointerEvents: 'none', minWidth: 64 }}>{year}</span>
            <button className="btn btn-ghost btn-icon btn-sm" onClick={() => setYear(year + 1)} aria-label="Next year"><Icon name="chevronRight" size={14} /></button>
            {canManage && <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}><Icon name="plus" size={14} /> New calendar</button>}
          </div>
        }
      />

      {next && (
        <section data-card className="card" style={{ padding: 18, marginBottom: 'var(--gap)', display: 'flex', alignItems: 'center', gap: 14, background: 'var(--honey)', color: 'var(--honey-ink)' }}>
          <span className="display num" style={{ fontSize: 34, lineHeight: 1 }}>{fmt(next.date, { day: 'numeric' })}</span>
          <div>
            <div style={{ fontSize: 12, opacity: 0.8 }}>Next holiday · {fmt(next.date, { weekday: 'long', month: 'long' })}</div>
            <div style={{ fontSize: 18, fontWeight: 600 }}>{next.name}</div>
          </div>
        </section>
      )}

      {!isLoading && calendars.length === 0 && (
        <section data-card className="card" style={{ padding: 28, textAlign: 'center' }}>
          <h2 style={{ fontSize: 22 }}>No holiday calendar for {year}</h2>
          <p className="dim" style={{ marginTop: 8 }}>{canManage ? 'Create one for your country or office, or copy last year’s.' : 'Your HR team hasn’t published holidays for this year yet.'}</p>
          {canManage && <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => setCreating(true)}><Icon name="plus" size={15} /> New calendar</button>}
        </section>
      )}

      <div style={{ display: 'grid', gap: 'var(--gap)' }}>
        {calendars.filter((c) => canManage || c.appliesToMe).map((c) => (
          <section key={c.id} data-card className="card" style={{ padding: 20 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
              <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                <h2 style={{ fontSize: 22 }}>{c.name}</h2>
                <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                  <span className="pill mute" style={{ textTransform: 'none' }}>{c.countryCode ? `Country ${c.countryCode}` : 'All countries'}</span>
                  <span className="pill mute" style={{ textTransform: 'none' }}>{c.workLocation ?? 'All locations'}</span>
                  <span className="pill mute" style={{ textTransform: 'none' }}>{c.holidays.length} holiday{c.holidays.length === 1 ? '' : 's'}</span>
                  {c.appliesToMe && <span className="pill honey" style={{ textTransform: 'none' }}>Applies to you</span>}
                </div>
              </div>
              {canManage && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => setAdding(c)}><Icon name="plus" size={13} /> Add holidays</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setEditing(c)}>Edit</button>
                  <button className="btn btn-ghost btn-sm" disabled={call.isPending} onClick={() => call.mutate(async () => { await api.post(`/holidays/calendars/${c.id}/copy`, { year: c.year + 1 }); toast(`Copied to ${c.year + 1}. Check the dates of moving festivals.`); setYear(c.year + 1) })}>Copy to {c.year + 1}</button>
                  <button className="btn btn-ghost btn-sm" disabled={call.isPending} onClick={() => { if (confirm(`Archive "${c.name}"? Its holidays stop counting.`)) call.mutate(() => api.post(`/holidays/calendars/${c.id}/archive`)) }}>Archive</button>
                </div>
              )}
            </div>
            {c.holidays.length === 0 ? (
              <p className="dim" style={{ fontSize: 13 }}>No holidays yet.{canManage && ' Use “Add holidays” to paste a list.'}</p>
            ) : (
              <div className="tbl-wrap" style={{ overflowX: 'auto' }}>
                <table className="tbl" style={{ width: '100%' }}>
                  <thead><tr><th style={{ width: 150 }}>Date</th><th>Holiday</th><th style={{ width: 120 }}>Type</th>{canManage && <th style={{ width: 90 }} />}</tr></thead>
                  <tbody>
                    {c.holidays.map((h) => (
                      <HolidayRow key={h.id} h={h} past={h.date < today} canManage={canManage} busy={call.isPending}
                        onSave={(patch) => call.mutate(() => api.patch(`/holidays/${h.id}`, patch))}
                        onRemove={() => { if (confirm(`Remove ${h.name}?`)) call.mutate(() => api.post(`/holidays/${h.id}/archive`)) }} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ))}
      </div>

      {canManage && <CalendarModal open={creating} year={year} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); refresh() }} />}
      {canManage && editing && <CalendarModal open year={editing.year} calendar={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh() }} />}
      {canManage && adding && <AddHolidaysModal calendar={adding} onClose={() => setAdding(null)} onSaved={() => { setAdding(null); refresh() }} />}
    </div>
  )
}

function HolidayRow({ h, past, canManage, busy, onSave, onRemove }: { h: Holiday; past: boolean; canManage: boolean; busy: boolean; onSave: (p: Partial<Holiday>) => void; onRemove: () => void }) {
  const [edit, setEdit] = useState(false)
  const [f, setF] = useState({ name: h.name, date: h.date, type: h.type, isOptional: h.isOptional })
  if (edit) {
    return (
      <tr>
        <td><input className="input" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} style={{ height: 34 }} aria-label="Date" /></td>
        <td><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} style={{ height: 34 }} aria-label="Name" /></td>
        <td>
          <select className="input" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })} style={{ height: 34 }} aria-label="Type">{TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, marginTop: 4 }}><input type="checkbox" checked={f.isOptional} onChange={(e) => setF({ ...f, isOptional: e.target.checked })} /> Optional</label>
        </td>
        <td style={{ whiteSpace: 'nowrap' }}>
          <button className="btn btn-primary btn-sm" disabled={busy || !f.name.trim()} onClick={() => { onSave(f); setEdit(false) }}>Save</button>
        </td>
      </tr>
    )
  }
  return (
    <tr style={{ opacity: past ? 0.55 : 1 }}>
      <td className="num">{fmt(h.date, { weekday: 'short', day: 'numeric', month: 'short' })}</td>
      <td style={{ fontWeight: 500 }}>{h.name}</td>
      <td><span className={`pill ${h.isOptional ? 'info' : 'mute'}`}>{h.isOptional ? 'optional' : h.type}</span></td>
      {canManage && (
        <td style={{ whiteSpace: 'nowrap' }}>
          <button className="btn btn-ghost btn-icon btn-sm" onClick={() => setEdit(true)} aria-label={`Edit ${h.name}`} title="Edit"><Icon name="sliders" size={13} /></button>
          <button className="btn btn-ghost btn-icon btn-sm" onClick={onRemove} aria-label={`Remove ${h.name}`} title="Remove"><Icon name="x" size={13} /></button>
        </td>
      )}
    </tr>
  )
}

function CalendarModal({ open, year, calendar, onClose, onSaved }: { open: boolean; year: number; calendar?: Calendar; onClose: () => void; onSaved: () => void }) {
  const toast = useToast()
  const { data: locations = [] } = useWorkLocations()
  const [f, setF] = useState({ name: calendar?.name ?? `Holidays ${year}`, countryCode: calendar?.countryCode ?? '', workLocationId: calendar?.workLocationId ?? '', list: '' })
  const [busy, setBusy] = useState(false)
  const parsed = parseHolidayLines(f.list, year)
  const save = async () => {
    setBusy(true)
    try {
      const scope = { countryCode: f.countryCode.trim() ? f.countryCode.trim().toUpperCase() : null, workLocationId: f.workLocationId || null }
      if (calendar) await api.patch(`/holidays/calendars/${calendar.id}`, { name: f.name.trim(), ...scope })
      else await api.post('/holidays/calendars', { name: f.name.trim(), year, ...scope, holidays: parsed.ok })
      toast(calendar ? 'Calendar updated' : `Calendar created${parsed.ok.length ? ` with ${parsed.ok.length} holidays` : ''}`)
      onSaved()
    } catch (e) { toast(errMsg(e), 'error') } finally { setBusy(false) }
  }
  return (
    <Modal open={open} onClose={onClose} title={calendar ? 'Edit calendar' : `New holiday calendar for ${year}`}>
      <div style={{ display: 'grid', gap: 12 }}>
        <label className="field"><span>Name</span><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={80} /></label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
          <label className="field"><span>Country (2 letters, blank = all)</span><input className="input" value={f.countryCode} onChange={(e) => setF({ ...f, countryCode: e.target.value.slice(0, 2) })} placeholder="IN" /></label>
          <label className="field"><span>Office (blank = all)</span>
            <select className="input" value={f.workLocationId} onChange={(e) => setF({ ...f, workLocationId: e.target.value })}>
              <option value="">All locations</option>
              {(locations as any[]).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
        </div>
        {!calendar && <PasteBox year={year} value={f.list} onChange={(list) => setF({ ...f, list })} parsed={parsed} />}
        <p className="muted" style={{ fontSize: 12 }}>A calendar applies to everyone whose office country and office match; leave and attendance skip its days automatically.</p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !f.name.trim() || (f.countryCode !== '' && f.countryCode.length !== 2) || parsed.bad.length > 0} onClick={save}>{calendar ? 'Save' : 'Create calendar'}</button>
        </div>
      </div>
    </Modal>
  )
}

function AddHolidaysModal({ calendar, onClose, onSaved }: { calendar: Calendar; onClose: () => void; onSaved: () => void }) {
  const toast = useToast()
  const [list, setList] = useState('')
  const [busy, setBusy] = useState(false)
  const parsed = parseHolidayLines(list, calendar.year)
  const save = async () => {
    setBusy(true)
    try {
      await api.post(`/holidays/calendars/${calendar.id}/holidays`, { holidays: parsed.ok })
      toast(`${parsed.ok.length} holiday${parsed.ok.length === 1 ? '' : 's'} added`)
      onSaved()
    } catch (e) { toast(errMsg(e), 'error') } finally { setBusy(false) }
  }
  return (
    <Modal open onClose={onClose} title={`Add holidays to ${calendar.name}`}>
      <div style={{ display: 'grid', gap: 12 }}>
        <PasteBox year={calendar.year} value={list} onChange={setList} parsed={parsed} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !parsed.ok.length || parsed.bad.length > 0} onClick={save}>Add {parsed.ok.length || ''} holiday{parsed.ok.length === 1 ? '' : 's'}</button>
        </div>
      </div>
    </Modal>
  )
}

function PasteBox({ year, value, onChange, parsed }: { year: number; value: string; onChange: (v: string) => void; parsed: { ok: NewHoliday[]; bad: string[] } }) {
  return (
    <label className="field">
      <span>Holidays: one per line, paste straight from a spreadsheet</span>
      <textarea className="input" rows={7} value={value} onChange={(e) => onChange(e.target.value)} style={{ height: 'auto', padding: 12, fontFamily: 'ui-monospace, monospace', fontSize: 13 }}
        placeholder={`${year}-01-26, Republic Day\n${year}-08-15, Independence Day\n${year}-10-02, Gandhi Jayanti\n${year}-03-14, Holi, optional`} />
      <span className="muted" style={{ fontSize: 12 }}>
        {parsed.ok.length > 0 && `${parsed.ok.length} ready`}
        {parsed.bad.length > 0 && <span style={{ color: 'var(--danger)' }}>{parsed.ok.length ? ' · ' : ''}{parsed.bad.length} line{parsed.bad.length === 1 ? '' : 's'} not understood (need a {year} date and a name): “{parsed.bad[0]}”</span>}
      </span>
    </label>
  )
}
