import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Map as MapboxMap } from 'mapbox-gl'
import api from '../../lib/api'

// A Mapbox map with 3D buildings that draws the route a person travelled (a line from the first point of the day to the last, with the
// start, the last known place and every reported point), plus a replay slider to see where they were at any time.
// The Mapbox public token comes from the API (GET /tracking/map-config), so it is set once on the host and not at build time.
export type TrackPoint = { latitude: number; longitude: number; accuracy?: number | null; at: string; sessionId?: string }
type Props = { points: TrackPoint[]; current?: { latitude: number; longitude: number; at: string } | null; name?: string; height?: number; viewKey: string }

const GAP_MS = 15 * 60_000 // a pause this long breaks the line (phone locked, tracking stopped and started again)
const MAX_ACCURACY = 200 // metres: vaguer points would make the line jump around
const css = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
const at = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
type LL = [number, number]
const fc = (features: any[]) => ({ type: 'FeatureCollection' as const, features })
const pt = (c: LL, props: Record<string, unknown> = {}) => ({ type: 'Feature' as const, properties: props, geometry: { type: 'Point' as const, coordinates: c } })

export default function TrackMap({ points, current, name, height = 380, viewKey }: Props) {
  const holder = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapboxMap | null>(null)
  const fitted = useRef('')
  const [ready, setReady] = useState(false)
  const [problem, setProblem] = useState('')
  const [idx, setIdx] = useState(0)
  const [playing, setPlaying] = useState(false)
  const cfg = useQuery({ queryKey: ['map-config'], staleTime: Infinity, retry: false, queryFn: async () => (await api.get('/tracking/map-config')).data.data as { token: string | null } })
  const token = cfg.data?.token ?? null

  // the usable points, and the route split into pieces wherever tracking paused
  const good = useMemo(() => points.filter((p) => p.accuracy == null || p.accuracy <= MAX_ACCURACY), [points])
  const pieces = useMemo(() => {
    const out: LL[][] = []
    let cur: LL[] = [], prev: TrackPoint | null = null
    for (const p of good) {
      if (prev && (p.sessionId !== prev.sessionId || +new Date(p.at) - +new Date(prev.at) > GAP_MS)) { if (cur.length) out.push(cur); cur = [] }
      cur.push([p.longitude, p.latitude]); prev = p
    }
    if (cur.length) out.push(cur)
    return out
  }, [good])

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
        const ink = css('--ink', '#252523'), honey = css('--honey', '#f6c343'), soft = css('--honey-soft', '#fbe7a6'), ok = css('--ok', '#2e7d4f'), bad = css('--danger', '#c0392b')
        m.addSource('trail', { type: 'geojson', lineMetrics: true, data: fc([]) })
        m.addSource('points', { type: 'geojson', data: fc([]) })
        m.addSource('ends', { type: 'geojson', data: fc([]) })
        m.addSource('cursor', { type: 'geojson', data: fc([]) })
        m.addLayer({ id: 'trail-casing', type: 'line', source: 'trail', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ink, 'line-width': 8, 'line-opacity': 0.85 } })
        // the colour runs from pale to strong along the route, so the direction of travel can be read
        m.addLayer({ id: 'trail-line', type: 'line', source: 'trail', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-width': 4.5, 'line-gradient': ['interpolate', ['linear'], ['line-progress'], 0, soft, 1, honey] } })
        m.addLayer({ id: 'trail-points', type: 'circle', source: 'points', paint: { 'circle-radius': 3.5, 'circle-color': honey, 'circle-stroke-color': ink, 'circle-stroke-width': 1.2 } })
        m.addLayer({ id: 'ends', type: 'circle', source: 'ends', paint: { 'circle-radius': 8, 'circle-color': ['match', ['get', 'kind'], 'start', ok, bad], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5 } })
        m.addLayer({ id: 'cursor', type: 'circle', source: 'cursor', paint: { 'circle-radius': 10, 'circle-color': honey, 'circle-stroke-color': ink, 'circle-stroke-width': 3 } })
        const pop = new mapboxgl.Popup({ closeButton: false, closeOnClick: false, offset: 10 })
        m.on('mousemove', 'trail-points', (e) => { const f: any = e.features?.[0]; if (!f) return; m.getCanvas().style.cursor = 'pointer'; pop.setLngLat((f.geometry as any).coordinates).setText(String(f.properties?.label)).addTo(m) })
        m.on('mouseleave', 'trail-points', () => { m.getCanvas().style.cursor = ''; pop.remove() })
        setReady(true)
      })
    })().catch(() => setProblem('The map could not be loaded. Check your connection and try again.'))
    const watch = new ResizeObserver(() => mapRef.current?.resize())
    if (holder.current) watch.observe(holder.current)
    return () => { dead = true; watch.disconnect(); setReady(false); mapRef.current = null; map?.remove() }
  }, [token])

  // draw the route whenever the points change; fit the view only when a different person or day is opened
  useEffect(() => {
    const m = mapRef.current
    if (!ready || !m) return
    const lines = pieces.filter((p) => p.length > 1).map((c) => ({ type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates: c } }))
    ;(m.getSource('trail') as any)?.setData(fc(lines))
    ;(m.getSource('points') as any)?.setData(fc(good.map((p) => pt([p.longitude, p.latitude], { label: `${at(p.at)}${p.accuracy != null ? ` · about ${Math.round(p.accuracy)} m accuracy` : ''}` }))))
    const first = good[0], last = good[good.length - 1]
    const ends: any[] = []
    if (first) ends.push(pt([first.longitude, first.latitude], { kind: 'start' }))
    const now = current ?? (last ? { latitude: last.latitude, longitude: last.longitude } : null)
    if (now) ends.push(pt([now.longitude, now.latitude], { kind: 'last' }))
    ;(m.getSource('ends') as any)?.setData(fc(ends))
    if (fitted.current !== viewKey) {
      const all: LL[] = [...good.map((p) => [p.longitude, p.latitude] as LL), ...(current ? [[current.longitude, current.latitude] as LL] : [])]
      if (all.length === 1) m.jumpTo({ center: all[0], zoom: 16 })
      else if (all.length > 1) {
        const lons = all.map((c) => c[0]), lats = all.map((c) => c[1])
        m.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 70, maxZoom: 17, duration: 900 })
        m.once('moveend', () => m.easeTo({ pitch: 55, duration: 700 })) // tilt once the route is in view, so the 3D buildings show
      }
      if (all.length) fitted.current = viewKey
    }
  }, [ready, good, pieces, current, viewKey])

  // the replay slider moves a marker along the route
  useEffect(() => { setIdx(Math.max(0, good.length - 1)); setPlaying(false) }, [viewKey, good.length])
  useEffect(() => {
    const m = mapRef.current, p = good[idx]
    if (!ready || !m) return
    ;(m.getSource('cursor') as any)?.setData(fc(p ? [pt([p.longitude, p.latitude])] : []))
    // while the replay plays, the camera follows the marker at street level, where the buildings stand out
    if (playing && p) m.easeTo({ center: [p.longitude, p.latitude], zoom: Math.max(m.getZoom(), 16.2), pitch: 60, duration: 160, essential: true })
  }, [ready, good, idx, playing])
  useEffect(() => {
    if (!playing) return
    const t = setInterval(() => setIdx((i) => { if (i >= good.length - 1) { setPlaying(false); return i } return i + 1 }), 150)
    return () => clearInterval(t)
  }, [playing, good.length])

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
  const p = good[idx]
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ position: 'relative' }}>
        <div ref={holder} role="img" aria-label={`Map of ${name ?? 'the'} route`} style={{ width: '100%', height, borderRadius: 18, overflow: 'hidden' }} />
        {problem && <div role="alert" className="pill danger" style={{ position: 'absolute', left: 10, top: 10, whiteSpace: 'normal', textTransform: 'none' }}>{problem}</div>}
      </div>
      {good.length > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { if (!playing && idx >= good.length - 1) setIdx(0); setPlaying(!playing) }}>{playing ? 'Pause' : 'Replay'}</button>
          <input type="range" aria-label="Replay the route" min={0} max={good.length - 1} value={idx} onChange={(e) => { setPlaying(false); setIdx(Number(e.target.value)) }} style={{ flex: '1 1 160px' }} />
          <span className="dim num" style={{ fontSize: 13, minWidth: 70, textAlign: 'right' }}>{p ? at(p.at) : ''}</span>
        </div>
      )}
      <span className="dim" style={{ fontSize: 12 }}>
        <span className="pill ok" style={{ marginRight: 6 }}>Start</span><span className="pill danger" style={{ marginRight: 6 }}>Last position</span>
        The line gets stronger towards the end of the route; hover a dot for its time. The map is loaded from Mapbox, which receives the location to draw it.
      </span>
    </div>
  )
}
