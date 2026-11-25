import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import api from '../../lib/api'
import { useAuth } from '../../contexts/AuthContext'
import PageHeader, { EmptyState } from '../../components/ui/PageHeader'
import Modal from '../../components/ui/Modal'
import Icon, { type IconName } from '../../components/ui/Icon'
import { useToast } from '../../components/ui/Toast'
import { useReveal } from '../../lib/motion'
import { useMyActivities, useCreatedActivities, useActivityTypes, useCreateActivity, useCompleteActivity, useCancelActivity } from '../../lib/hooks/useActivities'

// Tasks: things to do. Everyone makes tasks for themselves; a manager also for the people under them; HR for anyone. A task has a due date and
// can point at a record (a person's profile). Whoever made a task can cancel it; the person it is for marks it done.
type Filter = 'open' | 'assigned' | 'done' | 'cancelled'
const errMsg = (e: any) => e?.response?.data?.message || 'Something went wrong'
const ICON: Record<string, IconName> = { email: 'mail', 'phone call': 'phone', call: 'phone', meeting: 'users', 'to-do': 'checkCircle', todo: 'checkCircle', document: 'file', upload: 'file' }
const day = (iso: string) => new Date(iso).toISOString().slice(0, 10)
const todayStr = () => { const d = new Date(); return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString().slice(0, 10) }
function due(iso: string) {
  const diff = Math.round((new Date(`${day(iso)}T00:00:00Z`).getTime() - new Date(`${todayStr()}T00:00:00Z`).getTime()) / 86400000)
  if (diff < 0) return { label: `${-diff} day${diff === -1 ? '' : 's'} overdue`, tone: 'danger' }
  if (diff === 0) return { label: 'Due today', tone: 'warn' }
  if (diff === 1) return { label: 'Due tomorrow', tone: 'warn' }
  return { label: `Due ${new Date(`${day(iso)}T00:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', day: 'numeric', month: 'short' })}`, tone: 'mute' }
}

export default function ActivitiesPage() {
  const toast = useToast()
  const { hasRole } = useAuth()
  const root = useReveal<HTMLDivElement>('tasks')
  const [filter, setFilter] = useState<Filter>('open')
  const [making, setMaking] = useState(false)
  const [finishing, setFinishing] = useState<{ id: string; title: string } | null>(null)
  const [note, setNote] = useState('')
  const mine = useMyActivities(filter === 'open' ? undefined : filter === 'assigned' ? 'planned' : filter)
  const created = useCreatedActivities(filter === 'assigned')
  const complete = useCompleteActivity()
  const cancel = useCancelActivity()
  const list = (filter === 'assigned' ? created.data : mine.data) ?? []
  const loading = filter === 'assigned' ? created.isLoading : mine.isLoading
  const tabs: [Filter, string][] = [['open', 'To do'], ['assigned', 'Assigned by me'], ['done', 'Done'], ['cancelled', 'Cancelled']]
  const finish = async () => {
    if (!finishing) return
    try { await complete.mutateAsync({ id: finishing.id, doneNote: note.trim() }); toast('Marked done'); setFinishing(null); setNote('') } catch (e) { toast(errMsg(e), 'error') }
  }
  return (
    <div ref={root}>
      <PageHeader title="Tasks" sub="Things to do, with a due date. Make one for yourself, or for your team if you manage people." actions={<button className="btn btn-primary" onClick={() => setMaking(true)}><Icon name="plus" size={15} /> New task</button>}>
        <div role="tablist" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={filter === k} className={`btn btn-sm ${filter === k ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setFilter(k)}>{l}</button>)}</div>
      </PageHeader>
      <div style={{ display: 'grid', gap: 10 }}>
        {loading && <div className="skeleton" style={{ height: 90, borderRadius: 18 }} />}
        {!loading && list.length === 0 && <div className="card"><EmptyState icon={<Icon name="checkCircle" size={26} />} title={filter === 'open' ? 'Nothing to do' : filter === 'assigned' ? 'You have not assigned anything' : `No ${filter} tasks`} body={filter === 'open' ? 'Tasks you make, tasks from your manager or HR, and automatic reminders show up here.' : undefined} action={filter === 'open' ? <button className="btn btn-primary btn-sm" onClick={() => setMaking(true)}>Make a task</button> : undefined} /></div>}
        {list.map((t: any) => {
          const dd = due(t.dueDate)
          const forOther = filter === 'assigned' && t.assignee
          return (
            <article key={t.id} className="card" style={{ padding: 16, display: 'grid', gap: 10 }}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <span style={{ width: 38, height: 38, borderRadius: '50%', background: 'var(--well)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}><Icon name={ICON[(t.activityType?.name ?? '').toLowerCase()] ?? 'checkCircle'} size={17} /></span>
                <div style={{ flex: '1 1 240px', minWidth: 0 }}>
                  <strong style={{ fontWeight: 600 }}>{t.title}</strong>
                  {t.note && <div className="dim" style={{ fontSize: 13, marginTop: 2 }}>{t.note}</div>}
                  <div className="dim" style={{ fontSize: 12, marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                    {t.activityType?.name && <span>{t.activityType.name}</span>}
                    {forOther ? <span>· For {t.assignee.firstName} {t.assignee.lastName}</span> : t.createdByName && t.createdByName !== 'Automatic' ? <span>· From {t.createdByName}</span> : t.createdByName === 'Automatic' ? <span>· Automatic reminder</span> : null}
                    {t.about && (t.about.path ? <Link className="link" to={t.about.path}>· About {t.about.label}</Link> : <span>· About {t.about.label}</span>)}
                  </div>
                </div>
                <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{t.status === 'done' ? <span className="pill ok">Done</span> : t.status === 'cancelled' ? <span className="pill mute">Cancelled</span> : <span className={`pill ${dd.tone}`} style={{ textTransform: 'none' }}>{dd.label}</span>}</span>
              </div>
              {t.status === 'done' && t.doneNote && <div className="well" style={{ padding: '8px 12px', fontSize: 13 }}>{t.doneNote}</div>}
              {['planned', 'overdue'].includes(t.status) && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {!forOther && <button className="btn btn-primary btn-sm" onClick={() => { setFinishing({ id: t.id, title: t.title }); setNote('') }}>Mark done</button>}
                  {t.canCancel && <button className="btn btn-ghost btn-sm" disabled={cancel.isPending} onClick={() => cancel.mutate(t.id, { onSuccess: () => toast(forOther || t.createdBy !== 'system' ? 'Task cancelled' : 'Dismissed'), onError: (e) => toast(errMsg(e), 'error') })}>{t.createdBy === 'system' ? 'Dismiss' : 'Cancel task'}</button>}
                </div>
              )}
            </article>
          )
        })}
      </div>

      {finishing && (
        <Modal open onClose={() => setFinishing(null)} title="Mark done" width={440}>
          <div style={{ display: 'grid', gap: 12 }}>
            <p style={{ margin: 0 }}><strong>{finishing.title}</strong></p>
            <label className="field"><span>Add a note (optional)</span><textarea className="input" rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} autoFocus /></label>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><button className="btn btn-ghost" onClick={() => setFinishing(null)}>Cancel</button><button className="btn btn-primary" disabled={complete.isPending} onClick={finish}>{complete.isPending ? 'Saving…' : 'Mark done'}</button></div>
          </div>
        </Modal>
      )}
      {making && <NewTask onClose={() => setMaking(false)} manager={hasRole('manager') || hasRole('hr_admin') || hasRole('system_admin')} onMade={(forSelf) => { setMaking(false); setFilter(forSelf ? 'open' : 'assigned') }} />}
    </div>
  )
}

function NewTask({ onClose, onMade, manager }: { onClose: () => void; onMade: (forSelf: boolean) => void; manager: boolean }) {
  const toast = useToast()
  const { user } = useAuth()
  const types = useActivityTypes()
  const create = useCreateActivity()
  // the people this person may make tasks for (managers: their team; HR: anyone); an employee can only choose themselves
  const people = useQuery({ queryKey: ['task-people'], enabled: manager, retry: false, queryFn: async () => (await api.get('/employees', { params: { limit: 200 } })).data.data as any[] })
  const me = user?.employee?.id ?? ''
  const [f, setF] = useState({ title: '', note: '', typeId: '', dueDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10), assignedToId: me, about: '' })
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value })
  const typeId = f.typeId || types.data?.find((t) => /follow/i.test(t.name))?.id || types.data?.find((t) => /to-?do/i.test(t.name))?.id || types.data?.[0]?.id || ''
  const submit = async () => {
    try {
      await create.mutateAsync({ activityTypeId: typeId, title: f.title.trim(), note: f.note.trim() || undefined, assignedToId: f.assignedToId || me, dueDate: f.dueDate, ...(f.about ? { entityType: 'employee', entityId: f.about } : {}) })
      toast('Task made')
      onMade((f.assignedToId || me) === me)
    } catch (e) { toast(errMsg(e), 'error') }
  }
  const ok = f.title.trim().length >= 2 && !!typeId && !!f.dueDate && !!(f.assignedToId || me)
  return (
    <Modal open onClose={onClose} title="New task" width={480}>
      <div style={{ display: 'grid', gap: 12 }}>
        <label className="field"><span>What needs doing?</span><input className="input" value={f.title} onChange={set('title')} maxLength={140} autoFocus /></label>
        <label className="field"><span>Details (optional)</span><textarea className="input" rows={2} maxLength={1000} value={f.note} onChange={set('note')} /></label>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <label className="field" style={{ flex: '1 1 150px' }}><span>Due</span><input className="input" type="date" value={f.dueDate} onChange={set('dueDate')} /></label>
          <label className="field" style={{ flex: '1 1 150px' }}><span>Kind</span><select className="input" value={typeId} onChange={set('typeId')}>{types.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
        </div>
        {manager && (
          <>
            <label className="field"><span>For</span><select className="input" value={f.assignedToId || me} onChange={set('assignedToId')}>
              {me && <option value={me}>Me</option>}
              {people.data?.filter((p) => p.id !== me).map((p) => <option key={p.id} value={p.id}>{p.firstName} {p.lastName}</option>)}
            </select></label>
            <label className="field"><span>About a person (optional, adds a link to their profile)</span><select className="input" value={f.about} onChange={set('about')}>
              <option value="">Nobody in particular</option>
              {people.data?.map((p) => <option key={p.id} value={p.id}>{p.firstName} {p.lastName}</option>)}
            </select></label>
          </>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!ok || create.isPending} onClick={submit}>{create.isPending ? 'Saving…' : 'Make task'}</button></div>
      </div>
    </Modal>
  )
}
