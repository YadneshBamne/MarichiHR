import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import { useAuth } from '../../contexts/AuthContext'
import PageHeader, { SearchField, EmptyState } from '../../components/ui/PageHeader'
import Avatar from '../../components/ui/Avatar'
import Icon from '../../components/ui/Icon'
import { useToast } from '../../components/ui/Toast'
import { useReveal } from '../../lib/motion'
import { Delegations, Monitor, ChainsSetup } from './ApprovalChainsPanel'
import PayrollSignoff from './PayrollSignoff'

// One inbox for everything waiting on you. The server gathers it (leave, attendance fixes, overtime, expenses, timesheets, pre-approvals, ...)
// and says, for each item, which endpoint approves or rejects it, so this screen has no per-type code. Some things are decided on their own page
// (a payroll run, flagged clock-ins): they show as a counted line with an Open button.
type Act = { path: string; body?: Record<string, unknown>; noteField?: string; needsNote?: boolean; label?: string }
type Item = { key: string; type: string; group: 'time' | 'money' | 'people' | 'review'; label: string; count: number; employeeId: string | null; employee: string | null; summary: string; detail: string | null; step: string | null; at: string | null; link: string; approve?: Act; reject?: Act; extra?: Act[]; shortfallDays?: number }
type Inbox = { items: Item[]; groups: Record<string, number>; total: number }
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
const GROUPS: [string, string][] = [['all', 'Everything'], ['time', 'Leave and time'], ['money', 'Money'], ['people', 'People'], ['review', 'To review']]
const hours = (iso: string | null) => (iso ? Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 3_600_000)) : 0)
const waited = (iso: string | null) => { const h = hours(iso); return !iso ? '' : h < 1 ? 'just now' : h < 24 ? `${h} h` : `${Math.round(h / 24)} d` }
type Tab = 'inbox' | 'delegation' | 'monitor' | 'chains' | 'signoff'

export default function ApprovalsPage() {
  const { hasRole, hasApp } = useAuth()
  const hr = hasRole('hr_admin') || hasRole('system_admin')
  const sys = hasRole('system_admin') && hasApp('payroll')
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as Tab) || 'inbox'
  const root = useReveal<HTMLDivElement>(tab)
  const { data } = useQuery({ queryKey: ['inbox'], queryFn: async () => (await api.get('/approvals/inbox')).data.data as Inbox, refetchInterval: 60_000 })
  const tabs: [Tab, string][] = [['inbox', data?.total ? `Inbox (${data.total})` : 'Inbox'], ['delegation', 'Delegation'], ...(hr ? [['monitor', 'Monitor'] as [Tab, string], ['chains', 'Set up chains'] as [Tab, string]] : []), ...(sys ? [['signoff', 'Payroll sign-off'] as [Tab, string]] : [])]
  return (
    <div ref={root}>
      <PageHeader title="Approvals" sub={data ? (data.total ? `${data.total} thing${data.total === 1 ? '' : 's'} waiting for you` : 'All caught up. Nothing is waiting for you.') : 'Loading…'}>
        <div role="tablist" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`btn btn-sm ${tab === k ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setParams(k === 'inbox' ? {} : { tab: k })}>{l}</button>)}</div>
      </PageHeader>
      {tab === 'inbox' && <InboxList data={data} />}
      {tab === 'delegation' && <Delegations />}
      {tab === 'monitor' && hr && <Monitor />}
      {tab === 'chains' && hr && <ChainsSetup />}
      {tab === 'signoff' && sys && <PayrollSignoff />}
    </div>
  )
}

function InboxList({ data }: { data?: Inbox }) {
  const toast = useToast()
  const qc = useQueryClient()
  const [group, setGroup] = useState('all')
  const [q, setQ] = useState('')
  const [newest, setNewest] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [asking, setAsking] = useState<{ key: string; act: Act } | null>(null)
  const [note, setNote] = useState('')
  const [shortfall, setShortfall] = useState<Record<string, 'paid' | 'unpaid'>>({})
  const refresh = () => ['inbox', 'dashboard', 'nav-counts', 'leave', 'attendance', 'expenses', 'timesheets', 'approvals-pending'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }))
  const send = (it: Item, act: Act, text?: string) => api.post(act.path, { ...(act.body ?? {}), ...(text && act.noteField ? { [act.noteField]: text } : {}), ...(act === it.approve && it.shortfallDays ? { shortfall: shortfall[it.key] ?? 'paid' } : {}) })
  const decide = useMutation({
    mutationFn: ({ it, act, text }: { it: Item; act: Act; text?: string }) => send(it, act, text),
    onSuccess: (_r, v) => { toast(v.act === v.it.approve ? 'Approved' : v.act === v.it.reject ? 'Rejected' : 'Done'); setAsking(null); setNote(''); setPicked((p) => { const n = new Set(p); n.delete(v.it.key); return n }); refresh() },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  const items = useMemo(() => {
    const s = q.trim().toLowerCase()
    const list = (data?.items ?? []).filter((i) => (group === 'all' || i.group === group) && (!s || `${i.employee ?? ''} ${i.summary} ${i.label} ${i.detail ?? ''}`.toLowerCase().includes(s)))
    return newest ? [...list].reverse() : list
  }, [data, group, q, newest])
  // bulk: items that approve with one click (no note, no choice to make)
  const bulkable = (i: Item) => !!i.approve && !i.shortfallDays
  const selected = items.filter((i) => picked.has(i.key) && bulkable(i))
  const bulk = async () => {
    let ok = 0, failed = 0, why = ''
    for (const it of selected) { try { await send(it, it.approve!); ok++ } catch (e) { failed++; why = errMsg(e) } }
    toast(`Approved ${ok}${failed ? `, ${failed} could not be approved: ${why}` : ''}`, failed ? 'error' : undefined)
    setPicked(new Set()); refresh()
  }
  const toggle = (k: string) => setPicked((p) => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n })

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {GROUPS.map(([k, l]) => { const n = k === 'all' ? data?.total ?? 0 : data?.groups?.[k] ?? 0; return <button key={k} className={`btn btn-sm ${group === k ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setGroup(k)}>{l}{n ? ` (${n})` : ''}</button> })}
        <span style={{ flex: 1 }} />
        <SearchField value={q} onChange={setQ} placeholder="Search by person or request" width={240} />
        <button className="btn btn-ghost btn-sm" onClick={() => setNewest((v) => !v)} title="Change the order">{newest ? 'Newest first' : 'Oldest first'}</button>
      </div>
      {selected.length > 0 && (
        <div className="card" style={{ padding: '10px 14px', display: 'flex', gap: 10, alignItems: 'center' }}>
          <strong>{selected.length} selected</strong>
          <button className="btn btn-primary btn-sm" onClick={bulk}>Approve {selected.length}</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setPicked(new Set())}>Clear</button>
        </div>
      )}
      {!data && <div className="skeleton" style={{ height: 120, borderRadius: 18 }} />}
      {data && items.length === 0 && <div className="card"><EmptyState icon={<Icon name="checkCircle" size={26} />} title={data.total ? 'Nothing matches' : "You're all caught up"} body={data.total ? 'Try another filter or clear the search.' : 'When someone asks for leave, a fix, overtime, an expense and so on, it appears here.'} /></div>}
      {items.map((it) => it.approve ? (
        <article key={it.key} className="card" style={{ padding: 16, display: 'grid', gap: 10 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            {bulkable(it) && <input type="checkbox" aria-label={`Select ${it.employee ?? it.label}`} checked={picked.has(it.key)} onChange={() => toggle(it.key)} style={{ marginTop: 10 }} />}
            <Avatar name={it.employee ?? it.label} size={38} />
            <div style={{ flex: '1 1 260px', minWidth: 0 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                {it.employeeId ? <Link className="link" to={`/employees/${it.employeeId}`} style={{ fontWeight: 600 }}>{it.employee}</Link> : <strong>{it.employee}</strong>}
                <span className="pill mute" style={{ textTransform: 'none' }}>{it.label}</span>
                {it.step && <span className="pill info" style={{ textTransform: 'none' }}>{it.step}</span>}
              </div>
              <div style={{ marginTop: 3 }}>{it.summary}</div>
              {it.detail && <div className="dim" style={{ fontSize: 13, marginTop: 2 }}>“{it.detail}”</div>}
            </div>
            <span className={`pill ${hours(it.at) > 72 ? 'danger' : hours(it.at) > 24 ? 'warn' : 'mute'}`} style={{ textTransform: 'none' }} title="How long it has been waiting">Waiting {waited(it.at)}</span>
          </div>
          {it.shortfallDays ? (
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
              <span className="dim">{it.shortfallDays} day{it.shortfallDays === 1 ? ' is' : 's are'} beyond the balance. If you approve, treat them as</span>
              <select className="input" style={{ width: 'auto' }} value={shortfall[it.key] ?? 'paid'} onChange={(e) => setShortfall({ ...shortfall, [it.key]: e.target.value as 'paid' | 'unpaid' })} aria-label="Treat days beyond the balance as">
                <option value="paid">Paid (the balance goes negative; HR is told)</option><option value="unpaid">Unpaid (deducted in payroll)</option>
              </select>
            </label>
          ) : null}
          {asking?.key === it.key ? (
            <form onSubmit={(e) => { e.preventDefault(); decide.mutate({ it, act: asking.act, text: note.trim() }) }} style={{ display: 'grid', gap: 8 }}>
              <label className="field"><span>{asking.act === it.reject ? 'Why are you saying no?' : 'What should change?'}</span><textarea className="input" rows={2} autoFocus required minLength={asking.act === it.reject && it.type === 'overtime' ? 1 : 2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></label>
              <div style={{ display: 'flex', gap: 8 }}><button className="btn btn-primary btn-sm" disabled={decide.isPending || note.trim().length < 2}>{asking.act === it.reject ? 'Reject' : asking.act.label ?? 'Send'}</button><button type="button" className="btn btn-ghost btn-sm" onClick={() => { setAsking(null); setNote('') }}>Cancel</button></div>
            </form>
          ) : (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn btn-primary btn-sm" disabled={decide.isPending} onClick={() => decide.mutate({ it, act: it.approve! })}>Approve</button>
              {it.reject && <button className="btn btn-ghost btn-sm" onClick={() => { setAsking({ key: it.key, act: it.reject! }); setNote('') }}>Reject</button>}
              {it.extra?.map((x) => <button key={x.path} className="btn btn-ghost btn-sm" onClick={() => { setAsking({ key: it.key, act: x }); setNote('') }}>{x.label}</button>)}
            </div>
          )}
        </article>
      ) : (
        <Link key={it.key} to={it.link} className="card lift" style={{ padding: '14px 16px', display: 'flex', gap: 12, alignItems: 'center' }}>
          <span style={{ width: 38, height: 38, borderRadius: '50%', background: 'var(--well)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}><Icon name="checkCircle" size={17} /></span>
          <span style={{ flex: 1, minWidth: 0 }}><strong style={{ fontWeight: 600 }}>{it.label}</strong><span className="dim" style={{ display: 'block', fontSize: 13 }}>{it.summary}</span></span>
          <span className="pill honey">{it.count}</span>
          <span className="btn btn-ghost btn-sm">Open</span>
        </Link>
      ))}
    </div>
  )
}
