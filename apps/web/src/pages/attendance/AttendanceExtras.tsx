import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import QRCode from 'qrcode'
import api from '../../lib/api'
import PageHeader from '../../components/ui/PageHeader'
import Modal from '../../components/ui/Modal'
import { useToast } from '../../components/ui/Toast'
import { useReveal } from '../../lib/motion'

// Shifts & rosters (HR), my roster, the attendance heatmap (HR), the office QR code and the page it opens.
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
const ymd = (d: Date) => d.toISOString().slice(0, 10)
const addDays = (s: string, n: number) => ymd(new Date(new Date(`${s}T00:00:00Z`).getTime() + n * 86_400_000))
const monday = () => { const d = new Date(); const w = (d.getUTCDay() + 6) % 7; return ymd(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - w))) }
interface Shift { id: string; name: string; shiftType: string; startTime: string | null; endTime: string | null; splitStartTime: string | null; splitEndTime: string | null; active: boolean }
const hours = (s: Shift) => s.shiftType === 'flexible' ? 'Flexible' : `${s.startTime}–${s.endTime}${s.splitStartTime ? `, ${s.splitStartTime}–${s.splitEndTime}` : ''}`
const useShifts = () => useQuery({ queryKey: ['shifts'], queryFn: async () => (await api.get('/attendance/shifts')).data.data as Shift[] })

export default function RostersPage() {
  const root = useReveal<HTMLDivElement>(true)
  return (
    <div ref={root}>
      <PageHeader title="Shifts & rosters" sub="Set up shifts (fixed, flexible or split) and plan who works which shift, with rotating patterns." />
      <div style={{ display: 'grid', gap: 'var(--gap)' }}>
        <Shifts />
        <AssignRoster />
        <RosterWeek all />
      </div>
    </div>
  )
}

function Shifts() {
  const toast = useToast()
  const qc = useQueryClient()
  const { data = [] } = useShifts()
  const [f, setF] = useState<any>(null)
  const save = useMutation({
    mutationFn: () => { const body = { name: f.name.trim(), shiftType: f.shiftType, startTime: f.startTime || null, endTime: f.endTime || null, splitStartTime: f.shiftType === 'split' ? f.splitStartTime || null : null, splitEndTime: f.shiftType === 'split' ? f.splitEndTime || null : null }; return f.id ? api.patch(`/attendance/shifts/${f.id}`, body) : api.post('/attendance/shifts', body) },
    onSuccess: () => { toast('Shift saved'); qc.invalidateQueries({ queryKey: ['shifts'] }); setF(null) },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  return (
    <section data-card className="card" style={{ padding: 18, display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><h3 style={{ fontSize: 16, flex: 1 }}>Shifts</h3><button className="btn btn-primary btn-sm" onClick={() => setF({ name: '', shiftType: 'fixed', startTime: '09:00', endTime: '17:00', splitStartTime: '', splitEndTime: '' })}>New shift</button></div>
      {!data.length ? <p className="dim" style={{ fontSize: 13 }}>No shifts yet. Without one, everyone follows their attendance policy's office hours.</p> : (
        <table className="tbl" style={{ width: '100%' }}><thead><tr><th>Shift</th><th>Type</th><th>Hours</th><th /></tr></thead>
          <tbody>{data.map((s) => <tr key={s.id} style={{ opacity: s.active ? 1 : 0.5 }}><td>{s.name}</td><td>{s.shiftType}</td><td className="num">{hours(s)}</td><td style={{ textAlign: 'right' }}><button className="btn btn-ghost btn-sm" onClick={() => setF({ ...s, splitStartTime: s.splitStartTime ?? '', splitEndTime: s.splitEndTime ?? '' })}>Edit</button></td></tr>)}</tbody>
        </table>
      )}
      {f && (
        <Modal open onClose={() => setF(null)} title={f.id ? 'Edit shift' : 'New shift'}>
          <div style={{ display: 'grid', gap: 10 }}>
            <label className="field"><span>Name</span><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={60} placeholder="Early, Late, Night…" /></label>
            <label className="field"><span>Type</span><select className="input" value={f.shiftType} onChange={(e) => setF({ ...f, shiftType: e.target.value })}><option value="fixed">Fixed hours</option><option value="flexible">Flexible (no late marks)</option><option value="split">Split (two parts a day)</option></select></label>
            {f.shiftType !== 'flexible' && <div style={{ display: 'flex', gap: 10 }}><label className="field"><span>Starts</span><input className="input" type="time" value={f.startTime ?? ''} onChange={(e) => setF({ ...f, startTime: e.target.value })} /></label><label className="field"><span>Ends</span><input className="input" type="time" value={f.endTime ?? ''} onChange={(e) => setF({ ...f, endTime: e.target.value })} /></label></div>}
            {f.shiftType === 'split' && <div style={{ display: 'flex', gap: 10 }}><label className="field"><span>Second part starts</span><input className="input" type="time" value={f.splitStartTime} onChange={(e) => setF({ ...f, splitStartTime: e.target.value })} /></label><label className="field"><span>Second part ends</span><input className="input" type="time" value={f.splitEndTime} onChange={(e) => setF({ ...f, splitEndTime: e.target.value })} /></label></div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button className="btn btn-primary" disabled={save.isPending || f.name.trim().length < 2} onClick={() => save.mutate()}>Save</button></div>
          </div>
        </Modal>
      )}
    </section>
  )
}

function AssignRoster() {
  const toast = useToast()
  const qc = useQueryClient()
  const { data: shifts = [] } = useShifts()
  const { data: people = [] } = useQuery({ queryKey: ['roster-people'], queryFn: async () => ((await api.get('/employees/org-chart')).data.data.people as { id: string; name: string; department: string | null }[]) })
  const [f, setF] = useState({ employeeIds: [] as string[], from: monday(), to: addDays(monday(), 27), pattern: [''] as string[] })
  const save = useMutation({
    mutationFn: async () => (await api.post('/attendance/roster', { employeeIds: f.employeeIds, from: f.from, to: f.to, pattern: f.pattern.map((p) => p || null) })).data.data,
    onSuccess: (d) => { toast(`Rostered ${d.days} person-days`); qc.invalidateQueries({ queryKey: ['roster'] }) },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  const active = shifts.filter((s) => s.active)
  return (
    <section data-card className="card" style={{ padding: 18, display: 'grid', gap: 10 }}>
      <h3 style={{ fontSize: 16 }}>Plan a roster</h3>
      <p className="dim" style={{ fontSize: 13 }}>Pick people and dates, then the repeating pattern of shifts and days off (e.g. Early, Early, Late, Late, Off, Off). It replaces any roster those people already have on those dates.</p>
      <label className="field"><span>People</span><select className="input" multiple value={f.employeeIds} onChange={(e) => setF({ ...f, employeeIds: [...e.target.selectedOptions].map((o) => o.value) })} style={{ height: 120 }}>{people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.department ? ` · ${p.department}` : ''}</option>)}</select></label>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <label className="field"><span>From</span><input className="input" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
        <label className="field"><span>To (up to 3 months)</span><input className="input" type="date" min={f.from} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 13 }}>Pattern:</span>
        {f.pattern.map((p, i) => (
          <select key={i} className="input" style={{ width: 130 }} value={p} onChange={(e) => setF({ ...f, pattern: f.pattern.map((x, j) => (j === i ? e.target.value : x)) })} aria-label={`Day ${i + 1} of the pattern`}>
            <option value="">Day off</option>{active.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        ))}
        {f.pattern.length < 28 && <button className="btn btn-ghost btn-sm" onClick={() => setF({ ...f, pattern: [...f.pattern, active[0]?.id ?? ''] })}>+ day</button>}
        {f.pattern.length > 1 && <button className="btn btn-ghost btn-sm" onClick={() => setF({ ...f, pattern: f.pattern.slice(0, -1) })}>− day</button>}
      </div>
      <div><button className="btn btn-primary btn-sm" disabled={save.isPending || !f.employeeIds.length || !active.length} onClick={() => save.mutate()}>Apply roster</button>{!active.length && <span className="dim" style={{ fontSize: 12, marginLeft: 8 }}>Create a shift first.</span>}</div>
    </section>
  )
}

export function RosterWeek({ all }: { all?: boolean }) {
  const [start, setStart] = useState(monday())
  const end = addDays(start, 6)
  const { data = [] } = useQuery({ queryKey: ['roster', start], queryFn: async () => (await api.get('/attendance/roster', { params: { from: start, to: end } })).data.data as any[] })
  const days = [...Array(7)].map((_, i) => addDays(start, i))
  const people = [...new Map(data.map((r) => [r.employeeId, r.employee])).entries()]
  if (!all && !data.length) return null
  return (
    <section data-card className="card" style={{ padding: 18, display: 'grid', gap: 10, overflowX: 'auto' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <h3 style={{ fontSize: 16, flex: 1 }}>{all ? 'Roster' : 'My roster'} · week of {start}</h3>
        <button className="btn btn-ghost btn-sm" onClick={() => setStart(addDays(start, -7))}>‹</button><button className="btn btn-ghost btn-sm" onClick={() => setStart(addDays(start, 7))}>›</button>
      </div>
      {!people.length ? <p className="dim" style={{ fontSize: 13 }}>Nobody is rostered this week.</p> : (
        <table className="tbl" style={{ width: '100%', minWidth: 640 }}>
          <thead><tr><th>Person</th>{days.map((d) => <th key={d} className="num">{new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', timeZone: 'UTC' })}</th>)}</tr></thead>
          <tbody>{people.map(([id, name]) => <tr key={id}><td>{name}</td>{days.map((d) => { const r = data.find((x) => x.employeeId === id && x.date === d); return <td key={d} className="num" style={{ fontSize: 12 }}>{!r ? '—' : r.off ? <span className="dim">Off</span> : <span title={`${r.shift.startTime ?? ''}–${r.shift.endTime ?? ''}`}>{r.shift.name}</span>}</td> })}</tr>)}</tbody>
        </table>
      )}
    </section>
  )
}

export function Heatmap() {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7))
  const { data, isLoading } = useQuery({ queryKey: ['att-heatmap', month], queryFn: async () => (await api.get('/attendance/heatmap', { params: { month } })).data.data })
  return (
    <section data-card className="card" style={{ padding: 18, display: 'grid', gap: 10, overflowX: 'auto' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}><h3 style={{ fontSize: 16, flex: 1 }}>Attendance heatmap</h3><input className="input" type="month" value={month} onChange={(e) => setMonth(e.target.value)} style={{ width: 160 }} /></div>
      <p className="dim" style={{ fontSize: 12 }}>Share of each department present each day. Darker = more people in. Hover a cell for the numbers.</p>
      {isLoading || !data ? <div className="skeleton" style={{ height: 120, borderRadius: 14 }} /> : (
        <table style={{ borderCollapse: 'separate', borderSpacing: 2, minWidth: 700 }}>
          <thead><tr><th style={{ textAlign: 'left', fontSize: 12 }}>Department</th>{data.days.map((d: string) => <th key={d} style={{ fontSize: 10, fontWeight: 400, color: 'var(--dim)' }}>{d.slice(8)}</th>)}</tr></thead>
          <tbody>{data.departments.map((dep: any) => (
            <tr key={dep.name}><td style={{ fontSize: 12, paddingRight: 8, whiteSpace: 'nowrap' }}>{dep.name} <span className="dim">({dep.headcount})</span></td>
              {dep.days.map((c: any) => <td key={c.date} title={`${c.date}: ${c.present} in, ${c.leave} on leave, ${c.absent} absent`} style={{ width: 18, height: 18, borderRadius: 4, background: c.present + c.leave + c.absent === 0 ? 'var(--well)' : `color-mix(in srgb, var(--honey) ${Math.round(c.presentShare * 100)}%, var(--well))`, outline: c.absent ? '1px solid var(--danger)' : 'none' }} />)}
            </tr>
          ))}</tbody>
        </table>
      )}
    </section>
  )
}

// HR: show and print an office's QR code; scanning it opens /attendance/qr/<token> and clocks the person in there
export function OfficeQr({ location, onClose }: { location: { id: string; name: string }; onClose: () => void }) {
  const toast = useToast()
  const [img, setImg] = useState<string | null>(null)
  const { data, refetch } = useQuery({ queryKey: ['office-qr', location.id], queryFn: async () => (await api.get(`/attendance/locations/${location.id}/qr`)).data.data as { token: string } })
  useEffect(() => { if (data?.token) QRCode.toDataURL(`${window.location.origin}/attendance/qr/${data.token}`, { margin: 1, width: 320, color: { dark: '#252523', light: '#ffffff' } }).then(setImg) }, [data?.token])
  const rotate = async () => { if (!window.confirm('Make a new code? The printed one stops working.')) return; try { await api.post(`/attendance/locations/${location.id}/qr/rotate`); refetch(); toast('New code made') } catch (e) { toast(errMsg(e), 'error') } }
  return (
    <Modal open onClose={onClose} title={`Clock-in QR · ${location.name}`}>
      <div style={{ display: 'grid', gap: 12, justifyItems: 'center', textAlign: 'center' }}>
        {img ? <img src={img} alt={`QR code for clocking in at ${location.name}`} width={240} height={240} /> : <div className="skeleton" style={{ width: 240, height: 240, borderRadius: 12 }} />}
        <p style={{ fontSize: 13 }}>Print this and put it at the entrance. People scan it with their phone camera and are clocked in at {location.name}, no GPS needed.</p>
        <div style={{ display: 'flex', gap: 8 }}><button className="btn btn-primary btn-sm" onClick={() => window.print()}>Print</button><button className="btn btn-ghost btn-sm" onClick={rotate}>Make a new code</button></div>
      </div>
    </Modal>
  )
}

export function QrClockInPage() {
  const { token = '' } = useParams()
  const [state, setState] = useState<{ ok: boolean; message: string } | null>(null)
  useEffect(() => {
    api.post('/attendance/clock-in', { qrToken: token }).then(() => setState({ ok: true, message: 'You are clocked in. Have a good day!' })).catch((e) => setState({ ok: false, message: errMsg(e) }))
  }, [token])
  return (
    <section className="card" style={{ padding: 28, maxWidth: 440, margin: '40px auto', textAlign: 'center', display: 'grid', gap: 12 }}>
      {!state ? <p>Clocking you in…</p> : <><h2 style={{ fontSize: 22 }}>{state.ok ? 'Clocked in' : 'Could not clock you in'}</h2><p className={state.ok ? '' : 'dim'}>{state.message}</p></>}
      <Link to="/attendance" className="btn btn-ghost btn-sm" style={{ justifySelf: 'center' }}>Open my attendance</Link>
    </section>
  )
}

// Attendance changed after a month was locked: the pay effect for the Payroll admin to act on in the next run
export function AdjustmentsModal({ onClose }: { onClose: () => void }) {
  const { data = [] } = useQuery({ queryKey: ['att-adjustments'], queryFn: async () => (await api.get('/attendance/adjustments', { params: { pending: 'true' } })).data.data as any[] })
  return (
    <Modal open onClose={onClose} title="Attendance changed after the lock" width={640}>
      <div style={{ display: 'grid', gap: 10 }}>
        <p className="dim" style={{ fontSize: 13 }}>These days were changed after their month was locked. Add a pay input in this run where needed (a day back, or a day deducted). They are marked as handled when this run is paid.</p>
        <table className="tbl" style={{ width: '100%' }}><thead><tr><th>Person</th><th>Day</th><th>Change</th><th className="num">Pay days</th><th>Reason</th></tr></thead>
          <tbody>{data.map((a) => <tr key={a.id}><td>{a.employee}</td><td className="num">{a.date}</td><td>{a.fromStatus} → {a.toStatus}</td><td className="num">{a.payDays > 0 ? `+${a.payDays}` : a.payDays}</td><td style={{ fontSize: 12 }}>{a.reason}</td></tr>)}</tbody>
        </table>
      </div>
    </Modal>
  )
}
