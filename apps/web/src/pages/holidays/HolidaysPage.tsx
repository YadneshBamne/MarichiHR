import { useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import { useAuth } from '../../contexts/AuthContext'
import { useWorkLocations } from '../../lib/hooks/useEmployees'
import PageHeader from '../../components/ui/PageHeader'
import Modal from '../../components/ui/Modal'
import Icon from '../../components/ui/Icon'
import { useToast } from '../../components/ui/Toast'
import { useReveal } from '../../lib/motion'
import MasterSelect from '../../components/ui/MasterSelect'

interface Holiday { id: string; name: string; date: string; type: string; isOptional: boolean }
// Optional holidays (MongoDB API): per calendar the quota, and which optional holidays the viewer picked
interface OptCal { id: string; quota: number; picked: number; appliesToMe: boolean; holidays: { id: string; date: string; pickedByMe: boolean; canChange: boolean }[] }
interface Calendar { id: string; name: string; year: number; countryCode: string | null; workLocationId: string | null; workLocation: string | null; appliesToMe: boolean; holidays: Holiday[] }
type NewHoliday = { name: string; date: string; type?: string; isOptional?: boolean }

const fmt = (d: string, o: Intl.DateTimeFormatOptions) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', ...o })
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
// The viewer's own calendar date, not the UTC one (UTC is a day behind or ahead for hours every day)
const localYmd = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// Countries for the calendar's country field (ISO 3166-1 alpha-2); names come from the browser
const ISO_CODES = 'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' ')
const COUNTRIES: [string, string][] = (() => {
  let names: Intl.DisplayNames | null = null
  try { names = new Intl.DisplayNames(['en'], { type: 'region' }) } catch { /* old browser: show the codes */ }
  return ISO_CODES.map((c): [string, string] => [c, names?.of(c) ?? c]).sort((a, b) => a[1].localeCompare(b[1]))
})()
const countryLabel = (code: string | null) => (code ? COUNTRIES.find(([c]) => c === code)?.[1] ?? code : null)

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
  const [view, setView] = useState<'list' | 'month'>('list')
  const [sel, setSel] = useState<string>('mine') // month view: 'mine' (calendars that apply to me) or one calendar id
  const { data, isLoading } = useQuery({ queryKey: ['holidays', year], queryFn: async () => (await api.get('/holidays', { params: { year } })).data.data as { calendars: Calendar[] } })
  // Optional holidays exist on the MongoDB API only; on the other API this call fails and the page simply has no picking
  const opt = useQuery({ queryKey: ['holidays-optional', year], retry: false, queryFn: async () => (await api.get('/holidays/optional', { params: { year } })).data.data as { calendars: OptCal[] } })
  const calendars = data?.calendars ?? []
  const optOf = (calendarId: string) => opt.data?.calendars.find((c) => c.id === calendarId)
  const pickInfo = (calendarId: string, holidayId: string) => optOf(calendarId)?.holidays.find((h) => h.id === holidayId)
  const [creating, setCreating] = useState(false)
  const [templating, setTemplating] = useState(false)
  const [editing, setEditing] = useState<Calendar | null>(null)
  const [adding, setAdding] = useState<Calendar | null>(null)
  const [day, setDay] = useState<string | null>(null)
  const root = useReveal<HTMLDivElement>(isLoading)
  const refresh = () => { qc.invalidateQueries({ queryKey: ['holidays'] }); qc.invalidateQueries({ queryKey: ['holidays-optional'] }); qc.invalidateQueries({ queryKey: ['dashboard'] }) }
  const call = useMutation({
    mutationFn: async (f: () => Promise<unknown>) => f(),
    onSuccess: refresh,
    onError: (e) => toast(errMsg(e), 'error'),
  })
  const pick = useMutation({
    mutationFn: async (v: { id: string; on: boolean }) => (v.on ? api.post('/holidays/optional/picks', { holidayId: v.id }) : api.delete(`/holidays/optional/picks/${v.id}`)),
    onSuccess: (_r, v) => { toast(v.on ? 'Picked. It is a day off for you.' : 'Unpicked'); refresh(); qc.invalidateQueries({ queryKey: ['attendance'] }) },
    onError: (e) => toast(errMsg(e), 'error'),
  })

  // The viewer's own holidays: every calendar that applies to them, one line per date
  type Mine = Holiday & { calendar: string; calendarId: string }
  const mine = useMemo(() => {
    const m = new Map<string, Mine>()
    for (const c of calendars) if (c.appliesToMe) for (const h of c.holidays) if (!m.has(h.date) || (m.get(h.date)!.isOptional && !h.isOptional)) m.set(h.date, { ...h, calendar: c.name, calendarId: c.id })
    return [...m.values()].sort((a, b) => a.date.localeCompare(b.date))
  }, [calendars])
  const isPicked = (h: Mine) => !!(h.isOptional && pickInfo(h.calendarId, h.id)?.pickedByMe)
  const today = localYmd()
  const next = mine.find((h) => h.date >= today && (!h.isOptional || isPicked(h)))
  const workDays = useWorkDays()
  const offDays = mine.filter((h) => (!h.isOptional || isPicked(h)) && workDays.has(isoDow(h.date))).length

  // Month view: the holidays of the chosen calendar(s)
  const anyMine = calendars.some((c) => c.appliesToMe)
  const chosen = canManage && sel !== 'mine' && calendars.some((c) => c.id === sel) ? sel : anyMine || !canManage ? 'mine' : calendars[0]?.id ?? 'mine'
  const monthItems: Mine[] = chosen === 'mine' ? mine : calendars.filter((c) => c.id === chosen).flatMap((c) => c.holidays.map((h) => ({ ...h, calendar: c.name, calendarId: c.id })))

  return (
    <div ref={root}>
      <PageHeader
        title="Holiday calendar"
        sub={isLoading ? 'Loading…' : canManage ? `${calendars.length} calendar${calendars.length === 1 ? '' : 's'} for ${year}` : `${offDays} weekday holiday${offDays === 1 ? '' : 's'} for you in ${year}`}
        actions={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <div role="tablist" aria-label="View" style={{ display: 'flex', gap: 4 }}>
              {(['list', 'month'] as const).map((v) => <button key={v} role="tab" aria-selected={view === v} className={`btn btn-sm ${view === v ? 'btn-primary' : 'btn-ghost'}`} onClick={() => { setView(v); setDay(null) }}>{v === 'list' ? 'List' : 'Month view'}</button>)}
            </div>
            <button className="btn btn-ghost btn-icon btn-sm" onClick={() => setYear(year - 1)} aria-label="Previous year"><Icon name="chevronLeft" size={14} /></button>
            <span className="btn btn-ghost btn-sm num" style={{ pointerEvents: 'none', minWidth: 64 }}>{year}</span>
            <button className="btn btn-ghost btn-icon btn-sm" onClick={() => setYear(year + 1)} aria-label="Next year"><Icon name="chevronRight" size={14} /></button>
            {canManage && <button className="btn btn-ghost btn-sm" onClick={() => setTemplating(true)}>From a country list</button>}
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

      {view === 'month' && calendars.length > 0 && (
        <MonthView year={year} today={today} items={monthItems} day={day} onDay={setDay} busy={pick.isPending}
          picker={canManage ? <label className="field" style={{ maxWidth: 280 }}><span>Show</span><select className="input select" value={chosen} onChange={(e) => { setSel(e.target.value); setDay(null) }}>{anyMine && <option value="mine">My holidays</option>}{calendars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label> : null}
          emptyText={chosen === 'mine' ? 'No calendar applies to you yet.' : 'This calendar has no holidays yet.'}
          pickInfo={(h) => (h.isOptional ? pickInfo(h.calendarId, h.id) : undefined)} optCal={(id) => optOf(id)} appliesTo={(id) => !!calendars.find((c) => c.id === id)?.appliesToMe}
          onPick={(id, on) => pick.mutate({ id, on })} />
      )}

      {view === 'list' && (
      <div style={{ display: 'grid', gap: 'var(--gap)' }}>
        {calendars.filter((c) => canManage || c.appliesToMe).map((c) => {
          const oc = optOf(c.id)
          const canPickHere = !!oc && c.appliesToMe && oc.quota > 0
          const showActions = canManage || canPickHere
          return (
          <section key={c.id} data-card className="card" style={{ padding: 20 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
              <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                <h2 style={{ fontSize: 22 }}>{c.name}</h2>
                <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                  <span className="pill mute" style={{ textTransform: 'none' }}>{c.countryCode ? countryLabel(c.countryCode) : 'All countries'}</span>
                  <span className="pill mute" style={{ textTransform: 'none' }}>{c.workLocation ?? 'All locations'}</span>
                  <span className="pill mute" style={{ textTransform: 'none' }}>{c.holidays.length} holiday{c.holidays.length === 1 ? '' : 's'}</span>
                  {c.appliesToMe && <span className="pill honey" style={{ textTransform: 'none' }}>Applies to you</span>}
                  {oc && c.holidays.some((h) => h.isOptional) && (c.appliesToMe
                    ? <span className="pill info" style={{ textTransform: 'none' }}>{oc.quota > 0 ? `Optional: ${oc.picked} of ${oc.quota} picked` : 'Optional holidays cannot be picked'}</span>
                    : <span className="pill info" style={{ textTransform: 'none' }}>Optional: {oc.quota} a person</span>)}
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
                  <thead><tr><th style={{ width: 150 }}>Date</th><th>Holiday</th><th style={{ width: 120 }}>Type</th>{showActions && <th style={{ width: canManage ? 170 : 110 }} />}</tr></thead>
                  <tbody>
                    {c.holidays.map((h) => {
                      const pi = h.isOptional && canPickHere ? pickInfo(c.id, h.id) : undefined
                      return (
                        <HolidayRow key={h.id} h={h} past={h.date < today} canManage={canManage} showActions={showActions} busy={call.isPending}
                          pick={pi ? { picked: pi.pickedByMe, canChange: pi.canChange, quotaLeft: (oc?.quota ?? 0) - (oc?.picked ?? 0), busy: pick.isPending } : null}
                          onPick={(on) => pick.mutate({ id: h.id, on })}
                          onSave={(patch) => call.mutate(() => api.patch(`/holidays/${h.id}`, patch))}
                          onRemove={() => { if (confirm(`Remove ${h.name}?`)) call.mutate(() => api.post(`/holidays/${h.id}/archive`)) }} />
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          )
        })}
      </div>
      )}

      {templating && <TemplateModal year={year} onClose={() => setTemplating(false)} onSaved={() => { setTemplating(false); refresh() }} />}
      {canManage && <CalendarModal open={creating} year={year} supportsQuota={opt.isSuccess} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); refresh() }} />}
      {canManage && editing && <CalendarModal open year={editing.year} calendar={editing} quota={optOf(editing.id)?.quota} supportsQuota={opt.isSuccess} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh() }} />}
      {canManage && adding && <AddHolidaysModal calendar={adding} onClose={() => setAdding(null)} onSaved={() => { setAdding(null); refresh() }} />}
    </div>
  )
}

// The company's working week (0 = Monday ... 6 = Sunday); a company without the Attendance app has none, so Monday to Friday
function useWorkDays() {
  const q = useQuery({ queryKey: ['working-week'], retry: false, staleTime: 300_000, queryFn: async () => (await api.get('/attendance/working-week')).data.data as { days: number[] } })
  return new Set<number>(q.data?.days?.length ? q.data.days : [0, 1, 2, 3, 4])
}
const isoDow = (date: string) => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7

// Twelve small months for the year; a holiday is a coloured day (optional ones dashed, ones you picked solid), click a day for its details
type MonthItem = Holiday & { calendar: string; calendarId: string }
function MonthView({ year, today, items, day, onDay, picker, emptyText, pickInfo, optCal, appliesTo, onPick, busy }: {
  year: number; today: string; items: MonthItem[]; day: string | null; onDay: (d: string | null) => void; picker: ReactNode; emptyText: string
  pickInfo: (h: MonthItem) => { pickedByMe: boolean; canChange: boolean } | undefined; optCal: (calendarId: string) => OptCal | undefined; appliesTo: (calendarId: string) => boolean
  onPick: (holidayId: string, on: boolean) => void; busy: boolean
}) {
  const byDate = useMemo(() => { const m = new Map<string, MonthItem[]>(); for (const h of items) m.set(h.date, [...(m.get(h.date) ?? []), h]); return m }, [items])
  const workDays = useWorkDays()
  const picked =(h: MonthItem) => !!pickInfo(h)?.pickedByMe
  const chosen = day ? byDate.get(day) ?? [] : []
  return (
    <section data-card className="card" style={{ padding: 20, display: 'grid', gap: 14 }}>
      {picker}
      {items.length === 0 && <p className="dim" style={{ fontSize: 13 }}>{emptyText}</p>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 18 }}>
        {Array.from({ length: 12 }, (_, m) => {
          const first = new Date(Date.UTC(year, m, 1))
          const lead = (first.getUTCDay() + 6) % 7 // Monday first
          const days = new Date(Date.UTC(year, m + 1, 0)).getUTCDate()
          return (
            <div key={m}>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 15, marginBottom: 6 }}>{first.toLocaleDateString(undefined, { month: 'long', timeZone: 'UTC' })}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 3, fontSize: 11 }}>
                {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => <span key={i} className="dim" style={{ textAlign: 'center' }}>{d}</span>)}
                {Array.from({ length: lead }, (_, i) => <span key={`b${i}`} />)}
                {Array.from({ length: days }, (_, i) => {
                  const date = `${year}-${String(m + 1).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`
                  const list = byDate.get(date)
                  const weekend = !workDays.has(isoDow(date)) // a day off in the working week
                  const optional = !!list && list.every((h) => h.isOptional)
                  const mine = !!list && list.some(picked)
                  const base: React.CSSProperties = { height: 28, borderRadius: 8, textAlign: 'center', lineHeight: '28px', border: '1px solid transparent', color: weekend ? 'var(--faint)' : 'var(--ink)', background: weekend ? 'var(--well)' : 'transparent', outline: date === today ? '2px solid var(--ink)' : 'none', outlineOffset: -2 }
                  if (!list) return <span key={date} className="num" style={base}>{i + 1}</span>
                  const style: React.CSSProperties = optional && !mine ? { ...base, background: 'var(--info-bg)', color: 'var(--info)', border: '1px dashed var(--info)' } : { ...base, background: 'var(--honey)', color: 'var(--honey-ink)', fontWeight: 600 }
                  return <button key={date} type="button" className="num" aria-label={`${list.map((h) => h.name).join(', ')}, ${date}${optional ? ', optional' : ''}`} aria-pressed={day === date} onClick={() => onDay(day === date ? null : date)} style={{ ...style, cursor: 'pointer', ...(day === date ? { boxShadow: '0 0 0 2px var(--ink)' } : {}) }}>{i + 1}</button>
                })}
              </div>
            </div>
          )
        })}
      </div>
      <div className="dim" style={{ fontSize: 12, display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <span><span style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 4, background: 'var(--honey)', verticalAlign: -2 }} /> Holiday or picked</span>
        <span><span style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 4, background: 'var(--info-bg)', border: '1px dashed var(--info)', verticalAlign: -2 }} /> Optional</span>
        <span><span style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 4, background: 'var(--well)', verticalAlign: -2 }} /> Weekend</span>
      </div>
      {day && (
        <div className="well" style={{ padding: 14, display: 'grid', gap: 8 }} role="status">
          <strong>{fmt(day, { weekday: 'long', day: 'numeric', month: 'long' })}</strong>
          {chosen.map((h) => {
            const pi = pickInfo(h)
            const oc = optCal(h.calendarId)
            const canPick = h.isOptional && !!pi && !!oc && appliesTo(h.calendarId) && oc.quota > 0
            return (
              <div key={h.id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ flex: '1 1 200px' }}>{h.name} <span className="dim" style={{ fontSize: 12 }}>· {h.calendar}</span></span>
                <span className={`pill ${h.isOptional ? 'info' : 'mute'}`}>{h.isOptional ? (pi?.pickedByMe ? 'optional · picked' : 'optional') : h.type}</span>
                {canPick && <button className="btn btn-sm btn-ghost" disabled={busy || !pi!.canChange || (!pi!.pickedByMe && oc!.picked >= oc!.quota)} title={!pi!.canChange ? 'Picks close the day before the holiday' : !pi!.pickedByMe && oc!.picked >= oc!.quota ? `You have used all ${oc!.quota}` : undefined} onClick={() => onPick(h.id, !pi!.pickedByMe)}>{pi!.pickedByMe ? 'Unpick' : `Pick (${oc!.picked} of ${oc!.quota})`}</button>}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

interface PickState { picked: boolean; canChange: boolean; quotaLeft: number; busy: boolean }
function HolidayRow({ h, past, canManage, showActions, busy, pick, onPick, onSave, onRemove }: { h: Holiday; past: boolean; canManage: boolean; showActions: boolean; busy: boolean; pick: PickState | null; onPick: (on: boolean) => void; onSave: (p: Partial<Holiday>) => void; onRemove: () => void }) {
  const [edit, setEdit] = useState(false)
  const [f, setF] = useState({ name: h.name, date: h.date, type: h.type, isOptional: h.isOptional })
  if (edit) {
    return (
      <tr>
        <td><input className="input" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} style={{ height: 34 }} aria-label="Date" /></td>
        <td><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} style={{ height: 34 }} aria-label="Name" /></td>
        <td>
          <MasterSelect list="holiday_type" className="input" value={f.type} onChange={(v) => setF({ ...f, type: v })} style={{ height: 34 }} />
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
      <td><span className={`pill ${h.isOptional ? 'info' : 'mute'}`}>{h.isOptional ? (pick?.picked ? 'optional · picked' : 'optional') : h.type}</span></td>
      {showActions && (
        <td style={{ whiteSpace: 'nowrap' }}>
          {pick && <button className="btn btn-ghost btn-sm" disabled={pick.busy || !pick.canChange || (!pick.picked && pick.quotaLeft <= 0)} title={!pick.canChange ? 'Picks close the day before the holiday' : !pick.picked && pick.quotaLeft <= 0 ? 'You have picked all you can. Unpick one first.' : undefined} onClick={() => onPick(!pick.picked)}>{pick.picked ? 'Unpick' : 'Pick'}</button>}
          {canManage && <button className="btn btn-ghost btn-icon btn-sm" onClick={() => setEdit(true)} aria-label={`Edit ${h.name}`} title="Edit"><Icon name="sliders" size={13} /></button>}
          {canManage && <button className="btn btn-ghost btn-icon btn-sm" onClick={onRemove} aria-label={`Remove ${h.name}`} title="Remove"><Icon name="x" size={13} /></button>}
        </td>
      )}
    </tr>
  )
}

function CalendarModal({ open, year, calendar, quota, supportsQuota, onClose, onSaved }: { open: boolean; year: number; calendar?: Calendar; quota?: number; supportsQuota: boolean; onClose: () => void; onSaved: () => void }) {
  const toast = useToast()
  const { data: locations = [] } = useWorkLocations()
  const [f, setF] = useState({ name: calendar?.name ?? `Holidays ${year}`, countryCode: calendar?.countryCode ?? '', workLocationId: calendar?.workLocationId ?? '', list: '', quota: String(quota ?? 2) })
  const quotaNum = Number(f.quota)
  const quotaOk = !supportsQuota || (f.quota !== '' && Number.isInteger(quotaNum) && quotaNum >= 0 && quotaNum <= 30)
  const [busy, setBusy] = useState(false)
  const parsed = parseHolidayLines(f.list, year)
  const save = async () => {
    setBusy(true)
    try {
      const scope = { countryCode: f.countryCode.trim() ? f.countryCode.trim().toUpperCase() : null, workLocationId: f.workLocationId || null }
      let id = calendar?.id
      if (calendar) await api.patch(`/holidays/calendars/${calendar.id}`, { name: f.name.trim(), ...scope })
      else id = (await api.post('/holidays/calendars', { name: f.name.trim(), year, ...scope, holidays: parsed.ok })).data.data.id
      if (supportsQuota && id && (calendar ? quotaNum !== (quota ?? 2) : quotaNum !== 2)) await api.put(`/holidays/optional/calendars/${id}/quota`, { quota: quotaNum })
      toast(calendar ? 'Calendar updated' : `Calendar created${parsed.ok.length ? ` with ${parsed.ok.length} holidays` : ''}`)
      onSaved()
    } catch (e) { toast(errMsg(e), 'error') } finally { setBusy(false) }
  }
  return (
    <Modal open={open} onClose={onClose} title={calendar ? 'Edit calendar' : `New holiday calendar for ${year}`}>
      <div style={{ display: 'grid', gap: 12 }}>
        <label className="field"><span>Name</span><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={80} /></label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
          <label className="field"><span>Country</span>
            <select className="input select" value={f.countryCode} onChange={(e) => setF({ ...f, countryCode: e.target.value })}>
              <option value="">All countries</option>
              {COUNTRIES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
              {f.countryCode && !COUNTRIES.some(([c]) => c === f.countryCode) && <option value={f.countryCode}>{f.countryCode}</option>}
            </select>
          </label>
          <label className="field"><span>Office (blank = all)</span>
            <select className="input" value={f.workLocationId} onChange={(e) => setF({ ...f, workLocationId: e.target.value })}>
              <option value="">All locations</option>
              {(locations as any[]).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
        </div>
        {supportsQuota && (
          <label className="field" style={{ maxWidth: 320 }}><span>Optional holidays each person can pick a year</span>
            <input className="input" type="number" min={0} max={30} step={1} value={f.quota} onChange={(e) => setF({ ...f, quota: e.target.value })} />
            <span className="muted" style={{ fontSize: 12 }}>People choose from the holidays marked optional; a pick is a day off for that person only. 0 = nobody can pick.</span>
          </label>
        )}
        {!calendar && <PasteBox year={year} value={f.list} onChange={(list) => setF({ ...f, list })} parsed={parsed} />}
        <p className="muted" style={{ fontSize: 12 }}>A calendar applies to everyone whose office country and office match; leave and attendance skip its days automatically.</p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !f.name.trim() || !quotaOk || parsed.bad.length > 0} onClick={save}>{calendar ? 'Save' : 'Create calendar'}</button>
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

// Ready-made public holidays for Zambia, Kenya, Nigeria or India; moon-dependent dates say "date to confirm"
function TemplateModal({ year, onClose, onSaved }: { year: number; onClose: () => void; onSaved: () => void }) {
  const toast = useToast()
  const [country, setCountry] = useState('ZM')
  const { data } = useQuery({ queryKey: ['holiday-template', country, year], queryFn: async () => (await api.get('/holidays/templates', { params: { country, year } })).data.data as { countries: Record<string, string>; holidays: { name: string; date: string; isOptional?: boolean }[] } })
  const create = useMutation({ mutationFn: () => api.post('/holidays/calendars/from-template', { country, year }), onSuccess: () => { toast('Calendar created; edit it any time'); onSaved() }, onError: (e: any) => toast(e?.response?.data?.message ?? 'Could not create it', 'error') })
  return (
    <Modal open onClose={onClose} title={`Public holidays ${year}`}>
      <div style={{ display: 'grid', gap: 10 }}>
        <label className="field"><span>Country</span><select className="input" value={country} onChange={(e) => setCountry(e.target.value)}>{Object.entries(data?.countries ?? { ZM: 'Zambia', KE: 'Kenya', NG: 'Nigeria', IN: 'India' }).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <div style={{ maxHeight: 300, overflowY: 'auto' }}>
          <table className="tbl" style={{ width: '100%' }}><tbody>{(data?.holidays ?? []).map((h) => <tr key={h.date + h.name}><td className="num">{h.date}</td><td>{h.name}{h.isOptional && <span className="dim"> · optional</span>}</td></tr>)}</tbody></table>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button className="btn btn-primary" disabled={create.isPending || !data?.holidays.length} onClick={() => create.mutate()}>Create this calendar</button></div>
      </div>
    </Modal>
  )
}
