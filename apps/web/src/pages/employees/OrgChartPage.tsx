import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import api from '../../lib/api'
import PageHeader from '../../components/ui/PageHeader'
import Avatar from '../../components/ui/Avatar'
import Icon from '../../components/ui/Icon'
import { useReveal } from '../../lib/motion'

interface Person { id: string; name: string; title: string | null; department: string | null; departmentId: string; location: string | null; avatarUrl: string | null; managerId: string | null; isMe: boolean; canOpen: boolean; managerMissing?: boolean; isHead?: boolean }
interface Unit { id: string; name: string; parentId: string | null; type: string }
type View = 'people' | 'units'

const MIN_K = 0.2, MAX_K = 2

// The company as a tree: reporting lines (who reports to whom) or departments with their people.
// Everyone can see it; cards link to a profile only when the viewer may open it (self, HR, their own reports).
export default function OrgChartPage() {
  const { data, isLoading } = useQuery({ queryKey: ['org-chart'], queryFn: async () => (await api.get('/employees/org-chart')).data.data as { people: Person[]; departments: Unit[] } })
  const people = data?.people ?? []
  const [view, setView] = useState<View>('people')
  const [query, setQuery] = useState('')
  const [view2, setView2] = useState({ x: 0, y: 0, k: 1 }) // pan and zoom of the chart
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
    focusOn(`[data-person="${first}"]`)
  }

  const toggle = (id: string) => setCollapsed((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const allOpen = () => setCollapsed(new Set())
  const allClosed = () => setCollapsed(new Set(people.filter((p) => kids.has(p.id) && p.managerId !== null).map((p) => p.id)))

  // Pan and zoom: the tree is moved with a transform inside a fixed viewport
  const tree = useRef<HTMLDivElement>(null)
  const clampK = (k: number) => Math.max(MIN_K, Math.min(MAX_K, k))
  const zoomAt = (px: number, py: number, factor: number) => setView2((v) => { const k = clampK(v.k * factor); const r = k / v.k; return { k, x: px - (px - v.x) * r, y: py - (py - v.y) * r } })
  const zoomCentre = (factor: number) => { const el = canvas.current; if (el) zoomAt(el.clientWidth / 2, el.clientHeight / 2, factor) }
  const focusOn = (sel: string) => {
    const el = canvas.current, n = el?.querySelector(sel)
    if (!el || !n) return
    const nr = n.getBoundingClientRect(), er = el.getBoundingClientRect()
    setView2((v) => ({ ...v, x: v.x + (er.left + er.width / 2) - (nr.left + nr.width / 2), y: v.y + (er.top + er.height / 2) - (nr.top + nr.height / 2) }))
  }
  // Fit: show the whole tree (middle) or, on first open, readable size centred on the viewer's own card
  const fit = (how: 'middle' | 'me' = 'middle') => {
    const el = canvas.current, t = tree.current
    if (!el || !t) return
    const w = t.offsetWidth, h = t.offsetHeight, cw = el.clientWidth, ch = el.clientHeight
    const me = how === 'me' ? t.querySelector('.oc-card.me') : null
    if (me) {
      const k = Math.max(0.6, Math.min(1, (cw - 32) / w))
      const tr = t.getBoundingClientRect(), mr = me.getBoundingClientRect(), cur = view2.k
      const cx = (mr.left + mr.width / 2 - tr.left) / cur, cy = (mr.top + mr.height / 2 - tr.top) / cur
      setView2({ k, x: cw / 2 - cx * k, y: ch / 2 - cy * k })
    } else {
      const k = clampK(Math.min(1, (cw - 32) / w, (ch - 32) / h))
      setView2({ k, x: (cw - w * k) / 2, y: Math.max(16, (ch - h * k) / 2) })
    }
  }
  // On open (and when the view changes) fit once the chart has been laid out; big companies collapse first, so wait one more render
  const pendingFit = useRef(0)
  useEffect(() => { if (people.length) pendingFit.current = people.length > 40 ? 2 : 1 }, [people.length, view])
  useLayoutEffect(() => {
    if (!pendingFit.current || !people.length) return
    pendingFit.current -= 1
    if (pendingFit.current === 0) fit('me')
  })

  // Wheel zooms toward the pointer
  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // Drag to pan (mouse, pen, touch); two fingers pinch
  const ptrs = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef(0)
  const onDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button, a, input')) return
    canvas.current!.setPointerCapture(e.pointerId)
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (ptrs.current.size === 2) { const [a, b] = [...ptrs.current.values()]; pinch.current = Math.hypot(a.x - b.x, a.y - b.y) }
  }
  const onMove = (e: React.PointerEvent) => {
    const el = canvas.current, p = ptrs.current.get(e.pointerId)
    if (!el || !p) return
    if (ptrs.current.size === 1) {
      const dx = e.clientX - p.x, dy = e.clientY - p.y
      setView2((v) => ({ ...v, x: v.x + dx, y: v.y + dy }))
      ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    } else if (ptrs.current.size === 2) {
      ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      const [a, b] = [...ptrs.current.values()]
      const d = Math.hypot(a.x - b.x, a.y - b.y), r = el.getBoundingClientRect()
      if (pinch.current > 0 && d > 0) zoomAt((a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top, d / pinch.current)
      pinch.current = d
    }
  }
  const onUp = (e: React.PointerEvent) => { ptrs.current.delete(e.pointerId); pinch.current = 0 }

  const step = (dir: 1 | -1) => zoomCentre(dir > 0 ? 1.25 : 0.8)
  const roots = kids.get(null) ?? []
  const tops = roots.filter((p) => !p.managerMissing)
  const orphans = roots.filter((p) => p.managerMissing)
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
            <span className="num dim" style={{ fontSize: 12, minWidth: 38, textAlign: 'center' }}>{Math.round(view2.k * 100)}%</span>
            <button className="btn btn-ghost btn-icon btn-sm" onClick={() => step(1)} aria-label="Zoom in" title="Zoom in"><Icon name="plus" size={14} /></button>
            <button className="btn btn-ghost btn-icon btn-sm" onClick={() => fit()} aria-label="Fit to screen" title="Fit to screen"><Icon name="focus" size={14} /></button>
          </div>
        </div>
      </PageHeader>

      <section data-card className="card oc-canvas" ref={canvas} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <div className="oc-tree" ref={tree} style={{ transform: `translate(${view2.x}px, ${view2.y}px) scale(${view2.k})` }}>
          {isLoading ? (
            <div className="skeleton" style={{ width: 220, height: 84, borderRadius: 18, margin: '0 auto' }} />
          ) : view === 'people' ? (
            <ul>
              {tops.map((p) => <PersonNode key={p.id} p={p} kids={kids} teamSize={teamSize} collapsed={collapsed} toggle={toggle} matches={matches} searching={!!q} />)}
              {orphans.length > 0 && (
                <li>
                  <div className="oc-card unit"><div style={{ textAlign: 'left' }}><div className="oc-name">Unassigned</div><div className="oc-sub">{orphans.length} {orphans.length === 1 ? 'person' : 'people'} whose manager has left</div></div></div>
                  <ul>{orphans.map((p) => <PersonNode key={p.id} p={p} kids={kids} teamSize={teamSize} collapsed={collapsed} toggle={toggle} matches={matches} searching={!!q} />)}</ul>
                </li>
              )}
            </ul>
          ) : (
            <UnitTree units={data?.departments ?? []} people={people} />
          )}
        </div>
      </section>
      <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>Drag to move around · scroll or pinch to zoom · Fit shows everything · cards you can open link to the full profile</p>
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
            {p.isHead && <span className="pill night" style={{ height: 20, fontSize: 10 }}>Head</span>}
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
