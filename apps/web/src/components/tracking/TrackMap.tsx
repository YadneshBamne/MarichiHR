import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Map as MapboxMap } from 'mapbox-gl'
import api from '../../lib/api'
import { snapPiece, cumulative, alongLine, pointAt, type LL } from '../../lib/roadSnap'

// A Mapbox map with 3D buildings that draws the route a person travelled. The phone sends a point every minute or so, so the points are
// snapped to the road network (Mapbox Map Matching) and the line follows the streets, like a delivery app. A Replay slider moves a marker
// smoothly along the road. The Mapbox public token comes from the API (GET /tracking/map-config), so it is set once on the host.
export type TrackPoint = { latitude: number; longitude: number; accuracy?: number | null; at: string; sessionId?: string }
type Props = { points: TrackPoint[]; current?: { latitude: number; longitude: number; at: string } | null; name?: string; height?: number; viewKey: string }
type Route = { pts: TrackPoint[]; line: LL[]; cum: number[]; dist: number[]; snapped: LL[] }

const ROUTE_BLUE = '#2f6df6' // the route colour of delivery-app tracking
const GAP_MS = 15 * 60_000 // a pause this long breaks the line (phone locked, tracking stopped and started again)
const MAX_ACCURACY = 200 // metres: vaguer points would make the route jump around
const css = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
const at = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const fc = (features: any[]) => ({ type: 'FeatureCollection' as const, features })
const pt = (c: LL, props: Record<string, unknown> = {}) => ({ type: 'Feature' as const, properties: props, geometry: { type: 'Point' as const, coordinates: c } })
const build = (pts: TrackPoint[], line: LL[], snapped: LL[]): Route => { const cum = cumulative(line); return { pts, line, cum, snapped, dist: alongLine(line, cum, snapped) } }
const rawRoute = (pts: TrackPoint[]) => { const l = pts.map((p) => [p.longitude, p.latitude] as LL); return build(pts, l, l) }

export default function TrackMap({ points, current, name, height = 380, viewKey }: Props) {
  const holder = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapboxMap | null>(null)
  const fitted = useRef('')
  const routesFor = useRef('')
  const posRef = useRef(0)
  const [ready, setReady] = useState(false)
  const [problem, setProblem] = useState('')
  const [routes, setRoutes] = useState<Route[]>([])
  const [snapping, setSnapping] = useState(false)
  const [showPoints, setShowPoints] = useState(false)
  const [pos, setPos] = useState(0)
  const [playing, setPlaying] = useState(false)
  const cfg = useQuery({ queryKey: ['map-config'], staleTime: Infinity, retry: false, queryFn: async () => (await api.get('/tracking/map-config')).data.data as { token: string | null } })
  const token = cfg.data?.token ?? null

  // the usable points, and the route split into pieces wherever tracking paused
  const good = useMemo(() => points.filter((p) => p.accuracy == null || p.accuracy <= MAX_ACCURACY), [points])
  const pieces = useMemo(() => {
    const out: TrackPoint[][] = []
    let cur: TrackPoint[] = [], prev: TrackPoint | null = null
    for (const p of good) {
      if (prev && (p.sessionId !== prev.sessionId || +new Date(p.at) - +new Date(prev.at) > GAP_MS)) { if (cur.length) out.push(cur); cur = [] }
      cur.push(p); prev = p
    }
    if (cur.length) out.push(cur)
    return out
  }, [good])
  const total = good.length

  // the straight-line route straight away, then the road-following one when Mapbox has matched it (an old route stays on screen meanwhile)
  useEffect(() => {
    if (!token) return
    const ac = new AbortController()
    if (routesFor.current !== viewKey) { routesFor.current = viewKey; setRoutes(pieces.map(rawRoute)) }
    setSnapping(pieces.some((p) => p.length > 1))
    ;(async () => {
      const out: Route[] = []
      for (const pts of pieces) {
        if (pts.length < 2) { out.push(rawRoute(pts)); continue }
        const s = await snapPiece(pts, token, ac.signal)
        out.push(build(pts, s.line, s.snapped))
      }
      if (!ac.signal.aborted) { setRoutes(out); setSnapping(false) }
    })().catch(() => { if (!ac.signal.aborted) setSnapping(false) })
    return () => ac.abort()
  }, [pieces, token, viewKey])

  // one map for the life of the component
  useEffect(() => {
    if (!token || !holder.current) return
    let dead = false
    let map: MapboxMap | null = null
    ;(async () => {
      const [{ default: mapboxgl }] = await Promise.all([import('mapbox-gl'), import('mapbox-gl/dist/mapbox-gl.css')])
      if (dead || !holder.current) return
      mapboxgl.accessToken = token
      map = new mapboxgl.Map({ container: holder.current, style: 'mapbox://styles/mapbox/streets-v12', center: [28.28, -15.41], zoom: 15, pitch: 60, bearing: -17, antialias: true })
      mapRef.current = map
      map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'top-right')
      map.on('error', (e: any) => { const s = e?.error?.status; if (s === 401 || s === 403) setProblem('Mapbox did not accept the token. Ask your administrator to check it.') })
      map.on('style.load', () => {
        const m = map!
        // 3D buildings, drawn under the street labels
        const label = m.getStyle()?.layers?.find((l) => l.type === 'symbol' && (l.layout as any)?.['text-field'])?.id
        m.addLayer({ id: 'buildings-3d', source: 'composite', 'source-layer': 'building', filter: ['==', 'extrude', 'true'], type: 'fill-extrusion', minzoom: 14,
          paint: { 'fill-extrusion-color': '#c9c3b3', 'fill-extrusion-opacity': 0.8,
            'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 14, 0, 14.5, ['get', 'height']],
            'fill-extrusion-base': ['interpolate', ['linear'], ['zoom'], 14, 0, 14.5, ['get', 'min_height']] } }, label)
        // the look of a delivery app's tracking: one solid blue road line with a pale edge, a black pin where the person is, a blue dot for the replay
        const ink = css('--ink', '#252523'), ok = css('--ok', '#2e7d4f')
        m.addSource('trail', { type: 'geojson', data: fc([]) })
        m.addSource('points', { type: 'geojson', data: fc([]) })
        m.addSource('ends', { type: 'geojson', data: fc([]) })
        m.addSource('cursor', { type: 'geojson', data: fc([]) })
        m.addLayer({ id: 'trail-casing', type: 'line', source: 'trail', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 9, 'line-opacity': 0.95 } })
        m.addLayer({ id: 'trail-line', type: 'line', source: 'trail', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ROUTE_BLUE, 'line-width': 5.5 } })
        m.addLayer({ id: 'trail-points', type: 'circle', source: 'points', paint: { 'circle-radius': 3.5, 'circle-color': '#ffffff', 'circle-stroke-color': ROUTE_BLUE, 'circle-stroke-width': 1.6 } })
        m.addLayer({ id: 'ends', type: 'circle', source: 'ends', paint: { 'circle-radius': ['match', ['get', 'kind'], 'start', 6, 10], 'circle-color': ['match', ['get', 'kind'], 'start', ok, ink], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3 } })
        m.addLayer({ id: 'ends-centre', type: 'circle', source: 'ends', filter: ['==', ['get', 'kind'], 'last'], paint: { 'circle-radius': 3.4, 'circle-color': '#ffffff' } })
        m.addLayer({ id: 'cursor-halo', type: 'circle', source: 'cursor', paint: { 'circle-radius': 20, 'circle-color': ROUTE_BLUE, 'circle-opacity': 0.2 } })
        m.addLayer({ id: 'cursor', type: 'circle', source: 'cursor', paint: { 'circle-radius': 9, 'circle-color': ROUTE_BLUE, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3.5 } })
        const pop = new mapboxgl.Popup({ closeButton: false, closeOnClick: false, offset: 10 })
        m.on('mousemove', 'trail-points', (e) => { const f: any = e.features?.[0]; if (!f) return; m.getCanvas().style.cursor = 'pointer'; pop.setLngLat(f.geometry.coordinates).setText(String(f.properties?.label)).addTo(m) })
        m.on('mouseleave', 'trail-points', () => { m.getCanvas().style.cursor = ''; pop.remove() })
        setReady(true)
      })
    })().catch(() => setProblem('The map could not be loaded. Check your connection and try again.'))
    const watch = new ResizeObserver(() => mapRef.current?.resize())
    if (holder.current) watch.observe(holder.current)
    return () => { dead = true; watch.disconnect(); setReady(false); mapRef.current = null; map?.remove() }
  }, [token])

  // draw the route whenever it changes; fit the view only when a different person or day is opened
  useEffect(() => {
    const m = mapRef.current
    if (!ready || !m) return
    const lines = routes.filter((r) => r.line.length > 1).map((r) => ({ type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates: r.line } }))
    ;(m.getSource('trail') as any)?.setData(fc(lines))
    ;(m.getSource('points') as any)?.setData(fc(showPoints ? good.map((p) => pt([p.longitude, p.latitude], { label: `${at(p.at)}${p.accuracy != null ? ` · about ${Math.round(p.accuracy)} m accuracy` : ''}` })) : []))
    const first = routes[0]?.snapped[0]
    const lastRoute = routes[routes.length - 1]
    const last = lastRoute ? lastRoute.snapped[lastRoute.snapped.length - 1] : current ? ([current.longitude, current.latitude] as LL) : null
    const ends: any[] = []
    if (first) ends.push(pt(first, { kind: 'start' }))
    if (last) ends.push(pt(last, { kind: 'last' }))
    ;(m.getSource('ends') as any)?.setData(fc(ends))
    if (fitted.current !== viewKey) {
      const all = routes.flatMap((r) => r.line)
      if (all.length === 1) m.jumpTo({ center: all[0], zoom: 16 })
      else if (all.length > 1) {
        const lons = all.map((c) => c[0]), lats = all.map((c) => c[1])
        m.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 70, maxZoom: 17, duration: 900 })
        m.once('moveend', () => m.easeTo({ pitch: 55, duration: 700 })) // tilt once the route is in view, so the 3D buildings show
      }
      if (all.length) fitted.current = viewKey
    }
  }, [ready, routes, good, showPoints, current, viewKey])

  // where the replay marker is: pos is a (fractional) index into the points, turned into a place along the road
  const cursorAt = (p: number): LL | null => {
    if (!routes.length) return null
    let off = 0
    for (const r of routes) {
      if (p <= off + r.pts.length - 1 || r === routes[routes.length - 1]) {
        const local = Math.max(0, Math.min(r.pts.length - 1, p - off)), i = Math.floor(local), f = local - i
        const d = i + 1 < r.dist.length ? r.dist[i] + f * (r.dist[i + 1] - r.dist[i]) : r.dist[i]
        return r.line.length ? pointAt(r.line, r.cum, d) : null
      }
      off += r.pts.length
    }
    return null
  }
  useEffect(() => { posRef.current = Math.max(0, total - 1); setPos(posRef.current); setPlaying(false) }, [viewKey, total])
  useEffect(() => {
    const m = mapRef.current, c = cursorAt(pos)
    if (!ready || !m) return
    // the blue replay dot shows only while replaying or scrubbing; at the end of the route the black pin is the person's place
    ;(m.getSource('cursor') as any)?.setData(fc(c && (playing || pos < total - 1 - 0.01) ? [pt(c)] : []))
    if (playing && c) m.setCenter(c) // the camera follows the marker while the replay plays
  }, [ready, routes, pos, playing, total]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const m = mapRef.current
    if (playing && m) m.easeTo({ zoom: Math.max(m.getZoom(), 16.2), pitch: 60, duration: 800 }) // street level, where the buildings stand out
  }, [playing])
  useEffect(() => {
    if (!playing) return
    let raf = 0, prev = performance.now()
    const speed = Math.max(2.5, total / 25) // points a second: a day's route replays in about 25 seconds
    const tick = (now: number) => {
      const next = Math.min(total - 1, posRef.current + ((now - prev) / 1000) * speed)
      prev = now; posRef.current = next; setPos(next)
      if (next >= total - 1) setPlaying(false); else raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, total])

  if (cfg.isLoading) return <div className="skeleton" style={{ height, borderRadius: 18 }} />
  if (!token) {
    const last = current ?? (good.length ? good[good.length - 1] : null)
    return (
      <div className="well" style={{ padding: 16, borderRadius: 18, display: 'grid', gap: 6 }}>
        <strong style={{ fontWeight: 600 }}>The map is not set up yet</strong>
        <span className="dim" style={{ fontSize: 13 }}>Ask your administrator to add the Mapbox token for this site. {name ? `${name}'s` : 'The'} route is recorded and will show here once it is added.</span>
        {last && <span className="dim" style={{ fontSize: 13 }}>Last known position: {last.latitude.toFixed(5)}, {last.longitude.toFixed(5)}</span>}
      </div>
    )
  }
  const shown = good[Math.round(pos)]
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ position: 'relative' }}>
        <div ref={holder} role="img" aria-label={`Map of ${name ?? 'the'} route`} style={{ width: '100%', height, borderRadius: 18, overflow: 'hidden' }} />
        {problem && <div role="alert" className="pill danger" style={{ position: 'absolute', left: 10, top: 10, whiteSpace: 'normal', textTransform: 'none' }}>{problem}</div>}
        {snapping && !problem && <div className="pill mute" style={{ position: 'absolute', left: 10, top: 10, textTransform: 'none' }}>Following the roads…</div>}
      </div>
      {total > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { if (!playing && posRef.current >= total - 1) { posRef.current = 0; setPos(0) } setPlaying(!playing) }}>{playing ? 'Pause' : 'Replay'}</button>
          <input type="range" aria-label="Replay the route" min={0} max={total - 1} value={Math.round(pos)} onChange={(e) => { setPlaying(false); posRef.current = Number(e.target.value); setPos(posRef.current) }} style={{ flex: '1 1 160px' }} />
          <span className="dim num" style={{ fontSize: 13, minWidth: 70, textAlign: 'right' }}>{shown ? at(shown.at) : ''}</span>
        </div>
      )}
      <div className="dim" style={{ fontSize: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <span className="pill ok">Start</span><span className="pill night">Last position</span>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={showPoints} onChange={(e) => setShowPoints(e.target.checked)} /> Show the GPS points</label>
        <span>The route follows the roads. Where the phone's GPS was too vague to place it on a road, that stretch stays a straight line. The map is loaded from Mapbox, which receives the location to draw it.</span>
      </div>
    </div>
  )
}
