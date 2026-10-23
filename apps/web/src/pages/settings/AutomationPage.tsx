import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import PageHeader from '../../components/ui/PageHeader'
import Modal from '../../components/ui/Modal'
import Icon from '../../components/ui/Icon'
import { useToast } from '../../components/ui/Toast'
import { useAuth } from '../../contexts/AuthContext'
import { useEmployees } from '../../lib/hooks/useEmployees'

// Automation: "when this happens, if these hold, do this" rules, plus webhooks and API keys for other systems.
interface Field { key: string; label: string; type: 'text' | 'number' | 'date' }
interface Trigger { key: string; label: string; group: string; person: boolean; fields: Field[] }
interface Catalog { triggers: Trigger[]; ops: string[]; recipients: string[]; apiScopes: string[] }
type Cond = { field: string; op: string; value: string }
type Action = { type: 'notify'; to: string[]; title: string; body: string } | { type: 'task'; assignTo: string; title: string; note?: string; dueInDays: number }
interface Rule { id: string; name: string; trigger: string; conditions: Cond[]; actions: Action[]; active: boolean; runCount: number; lastRunAt: string | null }
interface Run { id: string; status: string; detail: string | null; createdAt: string; eventType: string | null }
interface Hook { id: string; name: string; url: string; events: string[]; active: boolean }
interface Delivery { id: string; eventType: string; status: string; attempts: number; responseCode: number | null; lastError: string | null; createdAt: string }
interface ApiKey { id: string; name: string; prefix: string; scopes: string[]; active: boolean; lastUsedAt: string | null; expiresAt: string | null; createdAt: string }

const OP_LABEL: Record<string, string> = { eq: 'is', neq: 'is not', in: 'is one of', contains: 'contains', gt: 'is more than', gte: 'is at least', lt: 'is less than', lte: 'is at most', set: 'is filled in', not_set: 'is empty' }
const WHO: Record<string, string> = { employee: 'The employee', manager: 'Their manager', hr_admin: 'HR admins', payroll_admin: 'Payroll admins', system_admin: 'System admins' }
const STATUS_PILL: Record<string, string> = { done: 'ok', delivered: 'ok', skipped: 'mute', failed: 'warn', pending: 'info', dead: 'danger' }
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
const when = (s: string | null) => (s ? new Date(s).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never')
const useCatalog = () => useQuery({ queryKey: ['automation-catalog'], queryFn: async () => (await api.get('/automation/catalog')).data.data as Catalog, staleTime: 10 * 60_000 })
const on = (active: boolean) => (active ? { background: 'var(--night)', color: 'var(--night-ink)' } : undefined)

export default function AutomationPage() {
  const { hasRole } = useAuth()
  const system = hasRole('system_admin')
  const [tab, setTab] = useState<'rules' | 'webhooks' | 'keys'>('rules')
  return (
    <div>
      <PageHeader title="Automation" sub="Rules that act on their own, and connections to your other systems">
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 14 }}>
          <button className="chip" aria-pressed={tab === 'rules'} style={on(tab === 'rules')} onClick={() => setTab('rules')}>Rules</button>
          {system && <button className="chip" aria-pressed={tab === 'webhooks'} style={on(tab === 'webhooks')} onClick={() => setTab('webhooks')}>Webhooks</button>}
          {system && <button className="chip" aria-pressed={tab === 'keys'} style={on(tab === 'keys')} onClick={() => setTab('keys')}>API keys</button>}
        </div>
      </PageHeader>
      {tab === 'rules' && <Rules />}
      {tab === 'webhooks' && system && <Webhooks />}
      {tab === 'keys' && system && <ApiKeys />}
    </div>
  )
}

// ─── Rules ──────────────────────────────────────────────────
function Rules() {
  const { data: cat } = useCatalog()
  const { data: rules = [], isLoading } = useQuery({ queryKey: ['automation-rules'], queryFn: async () => (await api.get('/automation/rules')).data.data as Rule[] })
  const [editing, setEditing] = useState<Rule | 'new' | null>(null)
  const [log, setLog] = useState<string | null>(null)
  const label = (t: string) => cat?.triggers.find((x) => x.key === t)?.label ?? t
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <span className="dim" style={{ fontSize: 13 }}>Example: when leave is approved for more than 5 days, tell payroll; when someone joins Sales, give their manager a task.</span>
        <button className="btn btn-primary btn-sm" onClick={() => setEditing('new')}><Icon name="plus" size={14} /> New rule</button>
      </div>
      {isLoading ? <div className="skeleton" style={{ height: 120, borderRadius: 14 }} /> : !rules.length ? (
        <section className="card" style={{ padding: 24 }}><p className="dim">No rules yet. Start with one, like a message to HR when someone joins.</p></section>
      ) : rules.map((r) => (
        <section key={r.id} className="card" style={{ padding: 16, display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <strong style={{ fontWeight: 600 }}>{r.name}</strong>
            <span className={`pill ${r.active ? 'ok' : 'mute'}`}>{r.active ? 'on' : 'off'}</span>
          </div>
          <div style={{ fontSize: 13 }}>
            <b>When</b> {label(r.trigger).toLowerCase()}
            {r.conditions.length > 0 && <> <b>and</b> {r.conditions.map((c) => `${cat?.triggers.find((t) => t.key === r.trigger)?.fields.find((f) => f.key === c.field)?.label ?? c.field} ${OP_LABEL[c.op]} ${c.value}`.trim()).join(', ')}</>}
            , <b>then</b> {r.actions.map((a) => (a.type === 'notify' ? `notify ${a.to.map((t) => WHO[t]?.toLowerCase() ?? t).join(', ')}` : `create a task`)).join(' and ')}.
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="dim" style={{ fontSize: 12 }}>Ran {r.runCount} time{r.runCount === 1 ? '' : 's'} · last {when(r.lastRunAt)}</span>
            <button className="btn btn-ghost btn-sm" onClick={() => setEditing(r)}>Edit</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setLog(log === r.id ? null : r.id)}>{log === r.id ? 'Hide log' : 'Run log'}</button>
          </div>
          {log === r.id && <RunLog ruleId={r.id} />}
        </section>
      ))}
      {editing && cat && <RuleEditor cat={cat} rule={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

function RunLog({ ruleId }: { ruleId: string }) {
  const { data = [], isLoading } = useQuery({ queryKey: ['automation-runs', ruleId], queryFn: async () => (await api.get('/automation/runs', { params: { ruleId } })).data.data as Run[] })
  if (isLoading) return <div className="skeleton" style={{ height: 60 }} />
  if (!data.length) return <p className="dim" style={{ fontSize: 13 }}>Not run yet.</p>
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="tbl" style={{ width: '100%', minWidth: 480 }}>
        <thead><tr><th>When</th><th>Result</th><th>Detail</th></tr></thead>
        <tbody>{data.map((x) => <tr key={x.id}><td style={{ whiteSpace: 'nowrap' }}>{when(x.createdAt)}</td><td><span className={`pill ${STATUS_PILL[x.status] ?? 'mute'}`}>{x.status}</span></td><td className="dim" style={{ fontSize: 13 }}>{x.detail}</td></tr>)}</tbody>
      </table>
    </div>
  )
}

const blankNotify = (): Action => ({ type: 'notify', to: ['hr_admin'], title: '', body: '' })
function RuleEditor({ cat, rule, onClose }: { cat: Catalog; rule: Rule | null; onClose: () => void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const { data: people } = useEmployees({ limit: 500 })
  const [r, setR] = useState({ name: rule?.name ?? '', trigger: rule?.trigger ?? 'employee.created', conditions: rule?.conditions ?? [], actions: rule?.actions ?? [blankNotify()], active: rule?.active ?? true })
  const [test, setTest] = useState<any>(null)
  const trigger = cat.triggers.find((t) => t.key === r.trigger)!
  const groups = [...new Set(cat.triggers.map((t) => t.group))]
  const setCond = (i: number, c: Partial<Cond>) => setR({ ...r, conditions: r.conditions.map((x, j) => (j === i ? { ...x, ...c } : x)) })
  const setAct = (i: number, a: Partial<Action>) => setR({ ...r, actions: r.actions.map((x, j) => (j === i ? ({ ...x, ...a } as Action) : x)) })
  const save = useMutation({
    mutationFn: () => (rule ? api.put(`/automation/rules/${rule.id}`, r) : api.post('/automation/rules', r)),
    onSuccess: () => { toast(rule ? 'Rule saved' : 'Rule created'); qc.invalidateQueries({ queryKey: ['automation-rules'] }); onClose() },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  const tryIt = useMutation({ mutationFn: async () => (await api.post('/automation/rules/test', { ...r, name: r.name.trim().length >= 2 ? r.name : 'Test' })).data.data, onSuccess: setTest, onError: (e) => toast(errMsg(e), 'error') })
  const recipients = cat.recipients.filter((x) => trigger.person || !['employee', 'manager'].includes(x))
  return (
    <Modal open onClose={onClose} title={rule ? 'Edit rule' : 'New rule'}>
      <form onSubmit={(e) => { e.preventDefault(); save.mutate() }} style={{ display: 'grid', gap: 14 }}>
        <label className="field"><span>Name</span><input className="input" required minLength={2} maxLength={80} value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} placeholder="e.g. Long leave alert" /></label>
        <label className="field"><span>When</span>
          <select className="input select" value={r.trigger} onChange={(e) => setR({ ...r, trigger: e.target.value, conditions: [] })}>
            {groups.map((g) => <optgroup key={g} label={g}>{cat.triggers.filter((t) => t.group === g).map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</optgroup>)}
          </select>
        </label>

        <div style={{ display: 'grid', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Only if <span className="dim" style={{ fontWeight: 400 }}>(all must hold; leave empty for always)</span></span>
          {r.conditions.map((c, i) => {
            const f = trigger.fields.find((x) => x.key === c.field)
            return (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 1.3fr) minmax(110px, 1fr) minmax(100px, 1fr) auto', gap: 6, alignItems: 'center' }}>
                <select className="input select" aria-label="Field" value={c.field} onChange={(e) => setCond(i, { field: e.target.value })}>{trigger.fields.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</select>
                <select className="input select" aria-label="Comparison" value={c.op} onChange={(e) => setCond(i, { op: e.target.value })}>{cat.ops.filter((o) => f?.type !== 'text' || !['gt', 'gte', 'lt', 'lte'].includes(o)).map((o) => <option key={o} value={o}>{OP_LABEL[o]}</option>)}</select>
                <input className="input" aria-label="Value" disabled={['set', 'not_set'].includes(c.op)} type={f?.type === 'number' ? 'number' : f?.type === 'date' ? 'date' : 'text'} placeholder={c.op === 'in' ? 'a, b, c' : ''} value={c.value} onChange={(e) => setCond(i, { value: e.target.value })} />
                <button type="button" className="btn btn-ghost btn-sm" aria-label="Remove condition" onClick={() => setR({ ...r, conditions: r.conditions.filter((_, j) => j !== i) })}><Icon name="x" size={14} /></button>
              </div>
            )
          })}
          {trigger.fields.length > 0 && r.conditions.length < 10 && <button type="button" className="btn btn-ghost btn-sm" style={{ justifySelf: 'start' }} onClick={() => setR({ ...r, conditions: [...r.conditions, { field: trigger.fields[0].key, op: 'eq', value: '' }] })}><Icon name="plus" size={14} /> Add condition</button>}
        </div>

        <div style={{ display: 'grid', gap: 10 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Then</span>
          {r.actions.map((a, i) => (
            <div key={i} className="well" style={{ padding: 12, display: 'grid', gap: 8 }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <select className="input select" style={{ maxWidth: 220 }} aria-label="Action" value={a.type} onChange={(e) => setR({ ...r, actions: r.actions.map((x, j) => (j === i ? (e.target.value === 'notify' ? blankNotify() : { type: 'task', assignTo: trigger.person ? 'manager' : '', title: '', dueInDays: 3 }) : x)) })}>
                  <option value="notify">Send a notification</option><option value="task">Create a task</option>
                </select>
                {r.actions.length > 1 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setR({ ...r, actions: r.actions.filter((_, j) => j !== i) })}>Remove</button>}
              </div>
              {a.type === 'notify' ? <>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{recipients.map((t) => { const sel = a.to.includes(t); return <button type="button" key={t} className="chip" aria-pressed={sel} style={on(sel)} onClick={() => setAct(i, { to: sel ? a.to.filter((x) => x !== t) : [...a.to, t] })}>{WHO[t]}</button> })}</div>
                <input className="input" required minLength={2} maxLength={120} placeholder="Title, e.g. {{employee.name}} is on leave for {{totalDays}} days" value={a.title} onChange={(e) => setAct(i, { title: e.target.value })} />
                <textarea className="input" rows={2} maxLength={500} placeholder="Message (optional)" value={a.body} onChange={(e) => setAct(i, { body: e.target.value })} />
              </> : <>
                <select className="input select" required value={a.assignTo} onChange={(e) => setAct(i, { assignTo: e.target.value })}>
                  {trigger.person && <><option value="manager">Their manager</option><option value="employee">The employee</option></>}
                  {!trigger.person && <option value="">Choose a person…</option>}
                  {((people?.data ?? []) as any[]).map((p) => <option key={p.id} value={p.id}>{p.firstName} {p.lastName} ({p.employeeCode})</option>)}
                </select>
                <input className="input" required minLength={2} maxLength={120} placeholder="Task, e.g. Set up a laptop for {{employee.name}}" value={a.title} onChange={(e) => setAct(i, { title: e.target.value })} />
                <label className="field" style={{ maxWidth: 160 }}><span>Due in (days)</span><input className="input" type="number" min={0} max={365} value={a.dueInDays} onChange={(e) => setAct(i, { dueInDays: Number(e.target.value) })} /></label>
              </>}
            </div>
          ))}
          {r.actions.length < 5 && <button type="button" className="btn btn-ghost btn-sm" style={{ justifySelf: 'start' }} onClick={() => setR({ ...r, actions: [...r.actions, blankNotify()] })}><Icon name="plus" size={14} /> Add action</button>}
          <span className="dim" style={{ fontSize: 12 }}>Fields you can put in titles: {trigger.fields.map((f) => `{{${f.key}}}`).join(' ')}</span>
        </div>

        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}><input type="checkbox" checked={r.active} onChange={(e) => setR({ ...r, active: e.target.checked })} /> Rule is on</label>
        {test && <div className="well" style={{ padding: 12, fontSize: 13 }}>{!test.event ? test.message : <>Against the latest real event ({when(test.event.at)}): <b>{test.matches ? 'conditions match' : 'conditions do not match'}</b>{test.preview.map((p: any, k: number) => <div key={k} className="dim">→ {p.title}{p.body ? ` — ${p.body}` : ''}</div>)}</>}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-ghost" disabled={tryIt.isPending} onClick={() => tryIt.mutate()}>Test</button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={save.isPending}>{rule ? 'Save' : 'Create rule'}</button>
        </div>
      </form>
    </Modal>
  )
}

// ─── Webhooks ───────────────────────────────────────────────
function Webhooks() {
  const toast = useToast()
  const qc = useQueryClient()
  const { data: cat } = useCatalog()
  const { data: hooks = [], isLoading } = useQuery({ queryKey: ['webhooks'], queryFn: async () => (await api.get('/automation/webhooks')).data.data as Hook[] })
  const [editing, setEditing] = useState<Hook | 'new' | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const ping = useMutation({ mutationFn: async (id: string) => (await api.post(`/automation/webhooks/${id}/ping`)).data.data as Delivery, onSuccess: (d, id) => { toast(d.status === 'delivered' ? `Delivered (HTTP ${d.responseCode})` : `Not delivered: ${d.lastError}`, d.status === 'delivered' ? undefined : 'error'); qc.invalidateQueries({ queryKey: ['webhook-deliveries', id] }) }, onError: (e) => toast(errMsg(e), 'error') })
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <span className="dim" style={{ fontSize: 13 }}>We POST signed JSON to your HTTPS address when chosen events happen, and retry for about 15 hours if it fails.</span>
        <button className="btn btn-primary btn-sm" onClick={() => setEditing('new')}><Icon name="plus" size={14} /> New webhook</button>
      </div>
      {secret && <section className="card" style={{ padding: 16, display: 'grid', gap: 8 }}>
        <strong>Signing secret: copy it now, it is not shown again</strong>
        <code style={{ wordBreak: 'break-all', fontSize: 13 }}>{secret}</code>
        <span className="dim" style={{ fontSize: 12 }}>Each request has <code>X-MarichiHR-Signature: t=&lt;unix time&gt;,v1=&lt;hex&gt;</code>, where hex is HMAC-SHA256 of <code>t + "." + body</code> with this secret.</span>
        <div style={{ display: 'flex', gap: 8 }}><button className="btn btn-ghost btn-sm" onClick={() => navigator.clipboard.writeText(secret).then(() => toast('Copied'))}>Copy</button><button className="btn btn-ghost btn-sm" onClick={() => setSecret(null)}>I have saved it</button></div>
      </section>}
      {isLoading ? <div className="skeleton" style={{ height: 100, borderRadius: 14 }} /> : !hooks.length ? <section className="card" style={{ padding: 24 }}><p className="dim">No webhooks yet.</p></section> : hooks.map((h) => (
        <section key={h.id} className="card" style={{ padding: 16, display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}><strong style={{ fontWeight: 600 }}>{h.name}</strong><span className={`pill ${h.active ? 'ok' : 'mute'}`}>{h.active ? 'on' : 'off'}</span></div>
          <code className="dim" style={{ fontSize: 12, wordBreak: 'break-all' }}>{h.url}</code>
          <div style={{ fontSize: 13 }}>{h.events.map((e) => cat?.triggers.find((t) => t.key === e)?.label ?? e).join(' · ')}</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button className="btn btn-ghost btn-sm" onClick={() => setEditing(h)}>Edit</button>
            <button className="btn btn-ghost btn-sm" disabled={ping.isPending} onClick={() => ping.mutate(h.id)}>Send test</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setOpen(open === h.id ? null : h.id)}>{open === h.id ? 'Hide deliveries' : 'Deliveries'}</button>
          </div>
          {open === h.id && <Deliveries hookId={h.id} />}
        </section>
      ))}
      {editing && cat && <HookEditor cat={cat} hook={editing === 'new' ? null : editing} onClose={(s) => { setEditing(null); if (s) setSecret(s) }} />}
    </div>
  )
}

function Deliveries({ hookId }: { hookId: string }) {
  const toast = useToast()
  const qc = useQueryClient()
  const { data = [], isLoading } = useQuery({ queryKey: ['webhook-deliveries', hookId], queryFn: async () => (await api.get(`/automation/webhooks/${hookId}/deliveries`)).data.data as Delivery[] })
  const again = useMutation({ mutationFn: (id: string) => api.post(`/automation/deliveries/${id}/redeliver`), onSuccess: () => { toast('Sent again'); qc.invalidateQueries({ queryKey: ['webhook-deliveries', hookId] }) }, onError: (e) => toast(errMsg(e), 'error') })
  if (isLoading) return <div className="skeleton" style={{ height: 60 }} />
  if (!data.length) return <p className="dim" style={{ fontSize: 13 }}>Nothing sent yet.</p>
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="tbl" style={{ width: '100%', minWidth: 560 }}>
        <thead><tr><th>When</th><th>Event</th><th>Result</th><th>Tries</th><th /></tr></thead>
        <tbody>{data.map((d) => <tr key={d.id}><td style={{ whiteSpace: 'nowrap' }}>{when(d.createdAt)}</td><td>{d.eventType}</td><td><span className={`pill ${STATUS_PILL[d.status] ?? 'mute'}`} title={d.lastError ?? ''}>{d.status}{d.responseCode ? ` · ${d.responseCode}` : ''}</span></td><td>{d.attempts}</td><td>{d.status !== 'delivered' && <button className="btn btn-ghost btn-sm" onClick={() => again.mutate(d.id)}>Send again</button>}</td></tr>)}</tbody>
      </table>
    </div>
  )
}

function HookEditor({ cat, hook, onClose }: { cat: Catalog; hook: Hook | null; onClose: (secret?: string) => void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const [h, setH] = useState({ name: hook?.name ?? '', url: hook?.url ?? 'https://', events: hook?.events ?? [], active: hook?.active ?? true })
  const groups = [...new Set(cat.triggers.map((t) => t.group))]
  const save = useMutation({
    mutationFn: async () => (hook ? api.put(`/automation/webhooks/${hook.id}`, h) : api.post('/automation/webhooks', h)),
    onSuccess: (res) => { toast('Webhook saved'); qc.invalidateQueries({ queryKey: ['webhooks'] }); onClose(res.data.data.signingSecret) },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  return (
    <Modal open onClose={() => onClose()} title={hook ? 'Edit webhook' : 'New webhook'}>
      <form onSubmit={(e) => { e.preventDefault(); save.mutate() }} style={{ display: 'grid', gap: 12 }}>
        <label className="field"><span>Name</span><input className="input" required minLength={2} maxLength={80} value={h.name} onChange={(e) => setH({ ...h, name: e.target.value })} /></label>
        <label className="field"><span>HTTPS address</span><input className="input" required type="url" maxLength={500} value={h.url} onChange={(e) => setH({ ...h, url: e.target.value })} /></label>
        <span style={{ fontSize: 13, fontWeight: 600 }}>Events</span>
        {groups.map((g) => (
          <div key={g} style={{ display: 'grid', gap: 4 }}>
            <span className="dim" style={{ fontSize: 12 }}>{g}</span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{cat.triggers.filter((t) => t.group === g).map((t) => { const sel = h.events.includes(t.key); return <button type="button" key={t.key} className="chip" aria-pressed={sel} style={on(sel)} onClick={() => setH({ ...h, events: sel ? h.events.filter((x) => x !== t.key) : [...h.events, t.key] })}>{t.label}</button> })}</div>
          </div>
        ))}
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}><input type="checkbox" checked={h.active} onChange={(e) => setH({ ...h, active: e.target.checked })} /> Webhook is on</label>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><button type="button" className="btn btn-ghost" onClick={() => onClose()}>Cancel</button><button className="btn btn-primary" disabled={!h.events.length || save.isPending}>Save</button></div>
      </form>
    </Modal>
  )
}

// ─── API keys ───────────────────────────────────────────────
const SCOPE_LABEL: Record<string, string> = { 'attendance:write': 'Device punches (biometric, turnstile)', 'employees:read': 'People directory', 'org:read': 'Departments', 'leave:read': 'Approved leave', 'attendance:read': 'Attendance' }
function ApiKeys() {
  const toast = useToast()
  const qc = useQueryClient()
  const { data: cat } = useCatalog()
  const { data: keys = [], isLoading } = useQuery({ queryKey: ['api-keys'], queryFn: async () => (await api.get('/automation/api-keys')).data.data as ApiKey[] })
  const [form, setForm] = useState<{ name: string; scopes: string[]; expiresAt: string } | null>(null)
  const [shown, setShown] = useState<string | null>(null)
  const create = useMutation({
    mutationFn: async () => (await api.post('/automation/api-keys', { name: form!.name, scopes: form!.scopes, ...(form!.expiresAt && { expiresAt: form!.expiresAt }) })).data.data,
    onSuccess: (k) => { setShown(k.key); setForm(null); qc.invalidateQueries({ queryKey: ['api-keys'] }) },
    onError: (e) => toast(errMsg(e), 'error'),
  })
  const revoke = useMutation({ mutationFn: (id: string) => api.post(`/automation/api-keys/${id}/revoke`), onSuccess: () => { toast('Key revoked'); qc.invalidateQueries({ queryKey: ['api-keys'] }) } })
  const base = `${String(api.defaults.baseURL).replace(/\/$/, '')}/integration`
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <section className="card" style={{ padding: 16, display: 'grid', gap: 6, fontSize: 13 }}>
        <strong style={{ fontSize: 14 }}>Read-only API for other systems</strong>
        <span className="dim">Send <code>Authorization: Bearer &lt;key&gt;</code> to <code style={{ wordBreak: 'break-all' }}>{base}</code>. 120 requests a minute per key.</span>
        <span className="dim"><code>GET /employees</code> (?status=all, ?updatedSince=ISO time) · <code>GET /org-units</code> · <code>GET /leave?from=&amp;to=</code> · <code>GET /attendance?from=&amp;to=</code> · paging with ?limit=&amp;offset=</span>
      </section>
      {shown && <section className="card" style={{ padding: 16, display: 'grid', gap: 8 }}>
        <strong>Copy this key now, it is not shown again</strong>
        <code style={{ wordBreak: 'break-all', fontSize: 13 }}>{shown}</code>
        <div style={{ display: 'flex', gap: 8 }}><button className="btn btn-ghost btn-sm" onClick={() => navigator.clipboard.writeText(shown).then(() => toast('Copied'))}>Copy</button><button className="btn btn-ghost btn-sm" onClick={() => setShown(null)}>I have saved it</button></div>
      </section>}
      <div><button className="btn btn-primary btn-sm" onClick={() => setForm({ name: '', scopes: ['employees:read'], expiresAt: '' })}><Icon name="plus" size={14} /> New key</button></div>
      {isLoading ? <div className="skeleton" style={{ height: 80, borderRadius: 14 }} /> : !keys.length ? <p className="dim" style={{ fontSize: 13 }}>No keys yet.</p> : (
        <section className="card" style={{ padding: 8, overflowX: 'auto' }}>
          <table className="tbl" style={{ width: '100%', minWidth: 620 }}>
            <thead><tr><th>Name</th><th>Key</th><th>Can read</th><th>Last used</th><th>Status</th><th /></tr></thead>
            <tbody>{keys.map((k) => <tr key={k.id}><td>{k.name}</td><td><code>{k.prefix}…</code></td><td style={{ fontSize: 13 }}>{k.scopes.map((s) => SCOPE_LABEL[s] ?? s).join(', ')}</td><td style={{ whiteSpace: 'nowrap' }}>{when(k.lastUsedAt)}</td><td><span className={`pill ${k.active ? 'ok' : 'mute'}`}>{k.active ? (k.expiresAt ? `until ${k.expiresAt.slice(0, 10)}` : 'active') : 'revoked'}</span></td><td>{k.active && <button className="btn btn-ghost btn-sm" onClick={() => confirm(`Revoke "${k.name}"? Systems using it stop working at once.`) && revoke.mutate(k.id)}>Revoke</button>}</td></tr>)}</tbody>
          </table>
        </section>
      )}
      {form && cat && (
        <Modal open onClose={() => setForm(null)} title="New API key">
          <form onSubmit={(e) => { e.preventDefault(); create.mutate() }} style={{ display: 'grid', gap: 12 }}>
            <label className="field"><span>Name</span><input className="input" required minLength={2} maxLength={80} placeholder="e.g. Power BI" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <span style={{ fontSize: 13, fontWeight: 600 }}>Can read</span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{cat.apiScopes.map((s) => { const sel = form.scopes.includes(s); return <button type="button" key={s} className="chip" aria-pressed={sel} style={on(sel)} onClick={() => setForm({ ...form, scopes: sel ? form.scopes.filter((x) => x !== s) : [...form.scopes, s] })}>{SCOPE_LABEL[s] ?? s}</button> })}</div>
            <label className="field" style={{ maxWidth: 220 }}><span>Expires (optional)</span><input className="input" type="date" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} /></label>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><button type="button" className="btn btn-ghost" onClick={() => setForm(null)}>Cancel</button><button className="btn btn-primary" disabled={!form.scopes.length || create.isPending}>Create key</button></div>
          </form>
        </Modal>
      )}
    </div>
  )
}
