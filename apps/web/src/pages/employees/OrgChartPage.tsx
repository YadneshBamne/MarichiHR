import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import api from '../../lib/api'
import PageHeader from '../../components/ui/PageHeader'
import Avatar from '../../components/ui/Avatar'
import Icon from '../../components/ui/Icon'
import { useReveal } from '../../lib/motion'

interface Person { id: string; name: string; title: string | null; department: string | null; departmentId: string; location: string | null; avatarUrl: string | null; managerId: string | null; isMe: boolean; canOpen: boolean }
interface Unit { id: string; name: string; parentId: string | null; type: string }
type View = 'people' | 'units'

const ZOOMS = [0.5, 0.65, 0.8, 1, 1.15]

// The company as a tree: reporting lines (who reports to whom) or departments with their people.
// Everyone can see it; cards link to a profile only when the viewer may open it (self, HR, their own reports).
export default function OrgChartPage() {
  const { data, isLoading } = useQuery({ queryKey: ['org-chart'], queryFn: async () => (await api.get('/employees/org-chart')).data.data as { people: Person[]; departments: Unit[] } })
  const people = data?.people ?? []
  const [view, setView] = useState<View>('people')
  const [query, setQuery] = useState('')
  const [zoom, setZoom] = useState(1)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const canvas = useRef<HTMLDivElement>(null)
  const root = useReveal<HTMLDivElement>(isLoading)

  const kids = useMemo(() => {
    const m = new Map<string | null, Person[]>()
    for (const p of people) m.set(p.managerId, [...(m.get(p.managerId) ?? []), p])
    return m
  }, [people])
  const teamSize = useMemo(() => {
    const memo = new Map<string, number>()
    const count = (id: string): number => memo.get(id) ?? (memo.set(id, (kids.get(id) ?? []).reduce((n, k) => n + 1 + count(k.id), 0)), memo.get(id)!)
    for (const p of people) count(p.id)
    return memo
  }, [people, kids])

  // Big companies open two levels deep; small ones fully
  useEffect(() => {
    if (!people.length) return
    if (people.length <= 40) { setCollapsed(new Set()); return }
    const depth = new Map<string, number>()
    const walk = (id: string | null, d: number) => (kids.get(id) ?? []).forEach((p) => { depth.set(p.id, d); walk(p.id, d + 1) })
    walk(null, 0)
    setCollapsed(new Set(people.filter((p) => (depth.get(p.id) ?? 0) >= 1 && kids.has(p.id)).map((p) => p.id)))
  }, [people, kids])

  // Search: matches stay bright, the rest dims, and every match's chain of managers is opened
  const q = query.trim().toLowerCase()
  const matches = useMemo(() => new Set(q ? people.filter((p) => `${p.name} ${p.title ?? ''} ${p.department ?? ''}`.toLowerCase().includes(q)).map((p) => p.id) : []), [q, people])
  useEffect(() => {
    if (!matches.size) return
    const byId = new Map(people.map((p) => [p.id, p]))
    setCollapsed((c) => {
      const next = new Set(c)
      for (const id of matches) for (let m = byId.get(id)?.managerId; m; m = byId.get(m)?.managerId ?? null) next.delete(m)
      return next
    })
  }, [matches, people])
  const jumpToFirst = () => {
    const first = [...matches][0]
    canvas.current?.querySelector(`[data-person="${first}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' })
  }

  const toggle = (id: string) => setCollapsed((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const allOpen = () => setCollapsed(new Set())
  const allClosed = () => setCollapsed(new Set(people.filter((p) => kids.has(p.id) && p.managerId !== null).map((p) => p.id)))

  // Fit: scale the tree so its width fits the canvas (never above 100%)
  const [, rerender] = useState(0)
  const fit = (how: 'middle' | 'me' = 'middle') => {
    const el = canvas.current, tree = el?.firstElementChild as HTMLElement | null
    if (!el || !tree) return
    const natural = tree.scrollWidth / zoom
    const z = Math.max(0.6, Math.min(1, (el.clientWidth - 32) / natural)) // below 60% names get unreadable; scroll instead
    setZoom(Math.round(z * 100) / 100)
    centre.current = how
    rerender((n) => n + 1) // re-centre even when the zoom didn't change
  }
  // After a zoom change has been laid out: scroll to the middle, or to the viewer's own card on first open
  const centre = useRef<'middle' | 'me' | null>(null)
  useLayoutEffect(() => {
    const el = canvas.current, how = centre.current
    if (!el || !how) return
    centre.current = null
    const me = how === 'me' ? el.querySelector<HTMLElement>('.oc-card.me') : null
    if (me) me.scrollIntoView({ block: 'nearest', inline: 'center' })
    else el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2
  })
  // On open: fit, then bring the viewer's own card into view (useful on phones where the tree is wider than the screen)
  useLayoutEffect(() => {
    if (!people.length) return
    fit('me')
  }, [people.length, view]) // eslint-disable-line react-hooks/exhaustive-deps

  // Drag to pan (mouse); touch screens scroll natively
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null)
  const onDown = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse' || (e.target as HTMLElement).closest('button, a, input')) return
    const el = canvas.current!
    drag.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop }
    el.setPointerCapture(e.pointerId)
  }
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current, el = canvas.current
    if (!d || !el) return
    el.scrollLeft = d.left - (e.clientX - d.x)
    el.scrollTop = d.top - (e.clientY - d.y)
  }
  const onUp = () => { drag.current = null }

  const step = (dir: 1 | -1) => setZoom((z) => { const i = ZOOMS.findIndex((v) => v >= z - 0.001); const at = i === -1 ? ZOOMS.length - 1 : i; return ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, at + dir))] })
  const tops = kids.get(null) ?? []
  const deptCount = new Set(people.map((p) => p.departmentId)).size

  return (
    <div ref={root}>
      <PageHeader title="Org chart" sub={isLoading ? 'Loading the organisation…' : `${people.length} people · ${deptCount} department${deptCount === 1 ? '' : 's'}`}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginTop: 14 }}>
          <div role="tablist" aria-label="Chart view" style={{ display: 'flex', gap: 6 }}>
            {([['people', 'Reporting lines'], ['units', 'Departments']] as [View, string][]).map(([v, l]) => (
              <button key={v} role="tab" aria-selected={view === v} className={`btn btn-sm ${view === v ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView(v)}>{l}</button>
            ))}
          </div>
          {view === 'people' && (
            <label style={{ position: 'relative', flex: '1 1 220px', maxWidth: 340 }}>
              <span style={{ position: 'absolute', left: 12, top: 11, color: 'var(--faint)' }}><Icon name="search" size={15} /></span>
              <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && matches.size && jumpToFirst()} placeholder="Find a person, title or department" aria-label="Search the org chart" style={{ paddingLeft: 34, height: 38 }} />
            </label>
          )}
          {view === 'people' && q && <span className="dim" style={{ fontSize: 12 }}>{matches.size ? `${matches.size} found · Enter to jump` : 'No one found'}</span>}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
            {view === 'people' && <><button className="btn btn-ghost btn-sm" onClick={allOpen}>Expand all</button><button className="btn btn-ghost btn-sm" onClick={allClosed}>Collapse</button></>}
            <button className="btn btn-ghost btn-icon btn-sm" onClick={() => step(-1)} aria-label="Zoom out" title="Zoom out"><Icon name="minus" size={14} /></button>
            <span className="num dim" style={{ fontSize: 12, minWidth: 38, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
            <button className="btn btn-ghost btn-icon btn-sm" onClick={() => step(1)} aria-label="Zoom in" title="Zoom in"><Icon name="plus" size={14} /></button>
            <button className="btn btn-ghost btn-icon btn-sm" onClick={() => fit()} aria-label="Fit to screen" title="Fit to screen"><Icon name="focus" size={14} /></button>
          </div>
        </div>
      </PageHeader>

      <section data-card className="card oc-canvas" ref={canvas} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <div className="oc-tree" style={{ zoom }}>
          {isLoading ? (
            <div className="skeleton" style={{ width: 220, height: 84, borderRadius: 18, margin: '0 auto' }} />
          ) : view === 'people' ? (
            <ul>{tops.map((p) => <PersonNode key={p.id} p={p} kids={kids} teamSize={teamSize} collapsed={collapsed} toggle={toggle} matches={matches} searching={!!q} />)}</ul>
          ) : (
            <UnitTree units={data?.departments ?? []} people={people} />
          )}
        </div>
      </section>
      <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>Drag to move around · use the zoom buttons or Fit · cards you can open link to the full profile</p>
    </div>
  )
}

function PersonNode({ p, kids, teamSize, collapsed, toggle, matches, searching }: {
  p: Person; kids: Map<string | null, Person[]>; teamSize: Map<string, number>; collapsed: Set<string>; toggle: (id: string) => void; matches: Set<string>; searching: boolean
}) {
  const navigate = useNavigate()
  const reports = kids.get(p.id) ?? []
  const open = reports.length > 0 && !collapsed.has(p.id)
  const dim = searching && !matches.has(p.id)
  return (
    <li>
      <div data-person={p.id} className={`oc-card${p.isMe ? ' me' : ''}${searching && matches.has(p.id) ? ' hit' : ''}`} style={{ opacity: dim ? 0.38 : 1 }}>
        <Avatar name={p.name} src={p.avatarUrl} size={40} />
        <div style={{ minWidth: 0, textAlign: 'left', flex: 1 }}>
          {p.canOpen ? (
            <button className="oc-name link" onClick={() => navigate(`/employees/${p.id}`)} title="Open profile">{p.name}</button>
          ) : (
            <span className="oc-name">{p.name}</span>
          )}
          <div className="oc-sub">{p.title ?? 'No title yet'}</div>
          <div style={{ display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
            {p.department && <span className="pill mute" style={{ height: 20, fontSize: 10 }}>{p.department}</span>}
            {p.isMe && <span className="pill honey" style={{ height: 20, fontSize: 10 }}>You</span>}
          </div>
        </div>
        {reports.length > 0 && (
          <button className="oc-toggle" onClick={() => toggle(p.id)} aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} ${p.name}'s team (${teamSize.get(p.id)})`} title={`${reports.length} direct · ${teamSize.get(p.id)} in total`}>
            {teamSize.get(p.id)} <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
          </button>
        )}
      </div>
      {open && <ul>{reports.map((k) => <PersonNode key={k.id} p={k} kids={kids} teamSize={teamSize} collapsed={collapsed} toggle={toggle} matches={matches} searching={searching} />)}</ul>}
    </li>
  )
}

// Departments as a tree (from org units), each with its headcount and its people
function UnitTree({ units, people }: { units: Unit[]; people: Person[] }) {
  const byUnit = useMemo(() => {
    const m = new Map<string, Person[]>()
    for (const p of people) m.set(p.departmentId, [...(m.get(p.departmentId) ?? []), p])
    return m
  }, [people])
  const children = useMemo(() => {
    const ids = new Set(units.map((u) => u.id))
    const m = new Map<string | null, Unit[]>()
    for (const u of units) { const parent = u.parentId && ids.has(u.parentId) ? u.parentId : null; m.set(parent, [...(m.get(parent) ?? []), u]) }
    return m
  }, [units])
  const total = (id: string): number => (byUnit.get(id)?.length ?? 0) + (children.get(id) ?? []).reduce((n, c) => n + total(c.id), 0)
  const node = (u: Unit) => {
    const sub = (children.get(u.id) ?? []).filter((c) => total(c.id) > 0 || (children.get(c.id) ?? []).length)
    const here = byUnit.get(u.id) ?? []
    return (
      <li key={u.id}>
        <div className="oc-card unit">
          <div style={{ textAlign: 'left', flex: 1, minWidth: 0 }}>
            <div className="oc-name">{u.name}</div>
            <div className="oc-sub"><span style={{ textTransform: 'capitalize' }}>{u.type}</span> · {total(u.id)} {total(u.id) === 1 ? 'person' : 'people'}</div>
            {here.length > 0 && (
              <div style={{ display: 'flex', marginTop: 8 }} title={here.map((p) => p.name).join(', ')}>
                {here.slice(0, 6).map((p, i) => <span key={p.id} style={{ marginLeft: i ? -8 : 0 }}><Avatar name={p.name} src={p.avatarUrl} size={26} ring /></span>)}
                {here.length > 6 && <span className="dim" style={{ fontSize: 11, alignSelf: 'center', marginLeft: 6 }}>+{here.length - 6}</span>}
              </div>
            )}
          </div>
        </div>
        {sub.length > 0 && <ul>{sub.map(node)}</ul>}
      </li>
    )
  }
  return <ul>{(children.get(null) ?? []).map(node)}</ul>
}
