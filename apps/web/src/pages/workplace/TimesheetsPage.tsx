import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import { useAuth } from '../../contexts/AuthContext'
import PageHeader from '../../components/ui/PageHeader'
import Modal from '../../components/ui/Modal'
import { useToast } from '../../components/ui/Toast'
import { useReveal } from '../../lib/motion'

type Entry = { date: string; projectId: string; task: string; hours: number }
const STATUS: Record<string, [string, string]> = { draft: ['mute', 'Draft'], submitted: ['info', 'Waiting for approval'], approved: ['ok', 'Approved'], rejected: ['danger', 'Sent back'] }
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
const iso = (d: Date) => d.toISOString().slice(0, 10)
const monday = (d = new Date()) => { const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return iso(x) }
const addDays = (s: string, n: number) => iso(new Date(new Date(`${s}T00:00:00Z`).getTime() + n * 86400000))
const DAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

// Timesheets: hours by project and task for a Monday-to-Sunday week, submitted to the manager. HR admins run projects and the report.
export default function TimesheetsPage() {
  const { hasRole, isManager } = useAuth()
  const admin = hasRole('hr_admin') || hasRole('system_admin')
  const [tab, setTab] = useState<'week' | 'approvals' | 'projects'>('week')
  const root = useReveal<HTMLDivElement>(tab)
  const projects = useQuery({ queryKey: ['ts-projects'], retry: false, queryFn: async () => (await api.get('/timesheets/projects')).data.data as any[] })
  const blocked = (projects.error as any)?.response?.data?.code === 'NOT_IN_PLAN'
  const tabs = [['week', 'My week'], ...(isManager || admin ? [['approvals', 'Approvals']] : []), ...(admin ? [['projects', 'Projects & report']] : [])] as [typeof tab, string][]
  if (blocked) return (
    <div ref={root}><PageHeader title="Timesheets" sub="Log hours by project and get them approved." />
      <div className="card" style={{ padding: 24 }}><p style={{ marginTop: 0 }}>Timesheets is not part of your company's plan.</p>{hasRole('system_admin') ? <Link className="btn btn-primary" to="/settings/plan">Add it on the Plan page</Link> : <p>Ask a system admin to add it.</p>}</div></div>
  )
  return (
    <div ref={root}>
      <PageHeader title="Timesheets" sub="Log hours by project and task, then send the week to your manager.">
        <div role="tablist" style={{ display: 'flex', gap: 6, marginTop: 14, flexWrap: 'wrap' }}>
          {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`btn btn-sm ${tab === k ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab(k)}>{l}</button>)}
        </div>
      </PageHeader>
      {tab === 'week' && <Week projects={projects.data ?? []} />}
      {tab === 'approvals' && <Approvals admin={admin} />}
      {tab === 'projects' && <Projects projects={projects.data ?? []} />}
    </div>
  )
}

function Week({ projects: allProjects }: { projects: any[] }) {
  const toast = useToast()
  const qc = useQueryClient()
  const projects = allProjects.filter((p) => p.active !== false) // only active projects are offered for new lines; archived ones still show on lines that have hours
  const [start, setStart] = useState(monday())
  const week = useQuery({ queryKey: ['ts-week', start], queryFn: async () => (await api.get('/timesheets/week', { params: { start } })).data.data })
  const [rows, setRows] = useState<Entry[]>([])
  useEffect(() => { if (week.data) setRows(week.data.entries) }, [week.data])
  const locked = week.data && ['submitted', 'approved'].includes(week.data.status)
  const onLeave = new Set<string>(week.data?.leaveDays ?? []) // days of approved leave: no hours can be logged
  const days = DAY.map((_, i) => addDays(start, i))
  // one grid row per project and task; cells are the hours of that day
  const lines = useMemo(() => { const m = new Map<string, { projectId: string; task: string }>(); rows.forEach((e) => m.set(`${e.projectId}|${e.task}`, { projectId: e.projectId, task: e.task })); return [...m.values()] }, [rows])
  const [extra, setExtra] = useState<{ projectId: string; task: string }[]>([])
  useEffect(() => setExtra([]), [start])
  const all = [...lines, ...extra.filter((x) => !lines.some((l) => l.projectId === x.projectId && l.task === x.task))]
  const hours = (l: { projectId: string; task: string }, d: string) => rows.find((e) => e.projectId === l.projectId && e.task === l.task && e.date === d)?.hours ?? 0
  const setHours = (l: { projectId: string; task: string }, d: string, v: string) => {
    const h = Math.round(Number(v) * 4) / 4
    setRows((r) => [...r.filter((e) => !(e.projectId === l.projectId && e.task === l.task && e.date === d)), ...(h > 0 ? [{ date: d, ...l, hours: Math.min(24, h) }] : [])])
  }
  const total = rows.reduce((a, e) => a + e.hours, 0)
  const save = useMutation({ mutationFn: async () => (await api.put('/timesheets/week', { weekStart: start, entries: rows })).data.data, onSuccess: () => { toast('Saved'); qc.invalidateQueries({ queryKey: ['ts-week', start] }) }, onError: (e) => toast(errMsg(e), 'error') })
  const submit = useMutation({ mutationFn: async () => { await api.put('/timesheets/week', { weekStart: start, entries: rows }); return api.post('/timesheets/week/submit', { weekStart: start }) }, onSuccess: () => { toast('Sent for approval'); qc.invalidateQueries({ queryKey: ['ts-week', start] }) }, onError: (e) => toast(errMsg(e), 'error') })
  const withdraw = useMutation({ mutationFn: async () => (await api.post('/timesheets/week/withdraw', { weekStart: start })).data.data, onSuccess: () => { toast('Taken back. It is a draft again.'); qc.invalidateQueries({ queryKey: ['ts-week', start] }) }, onError: (e) => toast(errMsg(e), 'error') })
  const [np, setNp] = useState('')
  const [nt, setNt] = useState('')
  const st = week.data?.status ?? 'draft'
  return (
    <div className="card" style={{ padding: 20, display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn btn-ghost btn-sm" onClick={() => setStart(addDays(start, -7))} aria-label="Previous week">←</button>
        <strong>{start} to {addDays(start, 6)}</strong>
        <button className="btn btn-ghost btn-sm" onClick={() => setStart(addDays(start, 7))} aria-label="Next week">→</button>
        <span className={`pill ${STATUS[st][0]}`}>{STATUS[st][1]}</span>
        <span style={{ marginLeft: 'auto', fontWeight: 600 }}>{total} h</span>
      </div>
      {week.data?.note && ['rejected', 'draft'].includes(st) && <p className={`pill ${st === 'rejected' ? 'danger' : 'warn'}`} style={{ whiteSpace: 'normal' }}>{st === 'rejected' ? "Manager's note" : 'Note'}: {week.data.note}</p>}
      <div style={{ overflowX: 'auto' }}>
        <table className="tbl" style={{ minWidth: 640 }}>
          <thead><tr><th>Project / task</th>{days.map((d, i) => <th key={d} style={{ textAlign: 'center' }}>{DAY[i]}<br /><span style={{ fontWeight: 400, fontSize: 12 }}>{d.slice(8)}</span>{onLeave.has(d) && <><br /><span className="pill info" style={{ fontSize: 10 }}>On leave</span></>}</th>)}</tr></thead>
          <tbody>
            {all.map((l) => (
              <tr key={`${l.projectId}|${l.task}`}>
                <td>{allProjects.find((p) => p.id === l.projectId)?.code ?? "?"} · {l.task || 'General'}{allProjects.find((p) => p.id === l.projectId)?.active === false && <> <span className="pill mute">Archived</span></>}</td>
                {days.map((d) => <td key={d} style={{ textAlign: 'center' }}><input aria-label={`${l.task || 'General'} ${d}`} className="input" style={{ width: 64, height: 44, padding: 0, textAlign: 'center', borderRadius: 14 }} type="number" min={0} max={24} step={0.25} disabled={locked || onLeave.has(d)} title={onLeave.has(d) ? 'You are on approved leave this day' : undefined} value={hours(l, d) || ''} onChange={(e) => setHours(l, d, e.target.value)} /></td>)}
              </tr>
            ))}
            {all.length === 0 && <tr><td colSpan={8}>Add a project below to start logging hours.</td></tr>}
          </tbody>
        </table>
      </div>
      {!locked && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <select aria-label="Project" className="input" style={{ width: 'auto' }} value={np} onChange={(e) => setNp(e.target.value)}><option value="">Project…</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}</select>
          <input aria-label="Task" className="input" style={{ width: 200 }} placeholder="Task (optional)" value={nt} onChange={(e) => setNt(e.target.value)} maxLength={120} />
          <button className="btn btn-ghost btn-sm" disabled={!np} onClick={() => { setExtra([...extra, { projectId: np, task: nt.trim() }]); setNt('') }}>Add line</button>
        </div>
      )}
      {!locked && <div style={{ display: 'flex', gap: 8 }}><button className="btn btn-ghost" disabled={save.isPending} onClick={() => save.mutate()}>Save draft</button><button className="btn btn-primary" disabled={submit.isPending || total === 0} onClick={() => submit.mutate()}>Submit week</button></div>}
      {st === 'submitted' && <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}><button className="btn btn-ghost" disabled={withdraw.isPending} onClick={() => withdraw.mutate()}>Take it back to edit</button><span className="dim" style={{ fontSize: 13 }}>Your manager has not decided yet, so you can still change it.</span></div>}
      {st === 'approved' && <span className="dim" style={{ fontSize: 13 }}>Approved weeks are locked. If something is wrong, ask HR to reopen it.</span>}
    </div>
  )
}

function Approvals({ admin }: { admin: boolean }) {
  const toast = useToast()
  const qc = useQueryClient()
  // HR can also look at weeks that are already approved (last 8 weeks) and reopen one for correction
  const [view, setView] = useState<'waiting' | 'approved'>('waiting')
  const [ask, setAsk] = useState<{ id: string; who: string; kind: 'back' | 'reopen' } | null>(null)
  const [note, setNote] = useState('')
  const q = useQuery({ queryKey: ['ts-approvals', view], queryFn: async () => (await api.get(view === 'waiting' ? '/timesheets/approvals' : '/timesheets/weeks', { params: view === 'approved' ? { status: 'approved' } : {} })).data.data as { projects: any[]; weeks: any[] } })
  const refresh = () => qc.invalidateQueries({ queryKey: ['ts-approvals'] })
  const decide = useMutation({ mutationFn: async (v: { id: string; approve: boolean; note?: string }) => api.post(`/timesheets/weeks/${v.id}/decide`, { approve: v.approve, note: v.note }), onSuccess: () => { toast('Done'); setAsk(null); setNote(''); refresh() }, onError: (e) => toast(errMsg(e), 'error') })
  const reopen = useMutation({ mutationFn: async (v: { id: string; note?: string }) => api.post(`/timesheets/weeks/${v.id}/reopen`, { note: v.note || undefined }), onSuccess: () => { toast('Reopened. The person has been told.'); setAsk(null); setNote(''); refresh() }, onError: (e) => toast(errMsg(e), 'error') })
  const code = (id: string) => q.data?.projects.find((p) => p.id === id)?.code ?? '?'
  const send = () => { if (!ask) return; ask.kind === 'back' ? decide.mutate({ id: ask.id, approve: false, note: note.trim() }) : reopen.mutate({ id: ask.id, note: note.trim() }) }
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {admin && <div role="tablist" style={{ display: 'flex', gap: 6 }}>{([['waiting', 'Waiting for approval'], ['approved', 'Approved (last 8 weeks)']] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={view === k} className={`btn btn-sm ${view === k ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView(k)}>{l}</button>)}</div>}
      {q.data?.weeks.length === 0 && <div className="card" style={{ padding: 20 }}>{view === 'waiting' ? 'Nothing waiting for you.' : 'No approved weeks in the last 8 weeks.'}</div>}
      {q.data?.weeks.map((w) => (
        <div key={w.id} className="card" style={{ padding: 16, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 220 }}><strong>{w.employeeName}</strong> · week of {w.weekStart} · {w.total} h
            <div style={{ fontSize: 13, opacity: 0.7 }}>{[...new Set(w.entries.map((e: any) => code(e.projectId)))].join(', ')}</div></div>
          {view === 'waiting' ? (<>
            <button className="btn btn-ghost btn-sm" onClick={() => { setNote(''); setAsk({ id: w.id, who: w.employeeName, kind: 'back' }) }}>Send back</button>
            <button className="btn btn-primary btn-sm" disabled={decide.isPending} onClick={() => decide.mutate({ id: w.id, approve: true })}>Approve</button>
          </>) : <button className="btn btn-ghost btn-sm" onClick={() => { setNote(''); setAsk({ id: w.id, who: w.employeeName, kind: 'reopen' }) }}>Reopen</button>}
        </div>
      ))}
      {ask && (
        <Modal open onClose={() => setAsk(null)} title={ask.kind === 'back' ? 'Send it back' : 'Reopen this week'} width={440}>
          <div style={{ display: 'grid', gap: 12 }}>
            <p style={{ margin: 0 }}>{ask.kind === 'back' ? `Tell ${ask.who} what needs changing.` : `${ask.who} can change the week and send it again. They are told.`}</p>
            <label className="field"><span>{ask.kind === 'back' ? 'What needs changing?' : 'Reason (optional)'}</span><textarea className="input" rows={3} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} autoFocus /></label>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setAsk(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={decide.isPending || reopen.isPending || (ask.kind === 'back' && note.trim().length < 3)} onClick={send}>{ask.kind === 'back' ? 'Send back' : 'Reopen'}</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}

function Projects({ projects }: { projects: any[] }) {
  const toast = useToast()
  const qc = useQueryClient()
  const [f, setF] = useState({ code: '', name: '' })
  const [range, setRange] = useState({ from: monday(new Date(Date.now() - 28 * 86400000)), to: addDays(monday(), 6) })
  const add = useMutation({ mutationFn: async () => api.post('/timesheets/projects', { ...f, billable: true, active: true }), onSuccess: () => { setF({ code: '', name: '' }); qc.invalidateQueries({ queryKey: ['ts-projects'] }) }, onError: (e) => toast(errMsg(e), 'error') })
  const toggle = useMutation({ mutationFn: async (p: any) => api.put(`/timesheets/projects/${p.id}`, { active: p.active === false }), onSuccess: () => qc.invalidateQueries({ queryKey: ['ts-projects'] }) })
  const rep = useQuery({ queryKey: ['ts-report', range], queryFn: async () => (await api.get('/timesheets/report', { params: range })).data.data as any[] })
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div className="card" style={{ padding: 20, display: 'grid', gap: 12 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input aria-label="Project code" className="input" style={{ width: 140 }} placeholder="Code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} maxLength={20} />
          <input aria-label="Project name" className="input" style={{ width: 260 }} placeholder="Project name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={80} />
          <button className="btn btn-primary btn-sm" disabled={f.code.trim().length < 2 || f.name.trim().length < 2 || add.isPending} onClick={() => add.mutate()}>Add project</button>
        </div>
        {projects.map((p) => <div key={p.id} style={{ display: 'flex', gap: 10, alignItems: 'center', minHeight: 44 }}><strong>{p.code}</strong> {p.name} {p.active === false && <span className="pill mute">Archived</span>}<button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={() => toggle.mutate(p)}>{p.active === false ? 'Restore' : 'Archive'}</button></div>)}
      </div>
      <div className="card" style={{ padding: 20, display: 'grid', gap: 12 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <strong>Approved hours</strong>
          <input aria-label="From" type="date" className="input" style={{ width: 'auto' }} value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
          <input aria-label="To" type="date" className="input" style={{ width: 'auto' }} value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
        </div>
        <table className="tbl"><thead><tr><th>Project</th><th>Person</th><th style={{ textAlign: 'right' }}>Hours</th></tr></thead>
          <tbody>{rep.data?.map((r) => <tr key={r.projectId + r.employee}><td>{r.code} · {r.project}</td><td>{r.employee}</td><td style={{ textAlign: 'right' }}>{r.hours}</td></tr>)}{rep.data?.length === 0 && <tr><td colSpan={3}>No approved hours in this range.</td></tr>}</tbody></table>
      </div>
    </div>
  )
}
