// Snaps a phone's GPS points to the road network with Mapbox Map Matching, so a route follows the streets like a delivery app's
// instead of joining the points with straight lines. Built from Mapbox's Map Matching API (api.mapbox.com/matching/v5): up to 100
// coordinates a request, `radiuses` (metres each point may move, 0 to 50), `timestamps`, `gaps=ignore` to route across pauses,
// `tidy=true` to drop clusters when someone stands still. If Mapbox cannot match a stretch, that stretch keeps its straight line.
export type LL = [number, number]
export type GpsPoint = { latitude: number; longitude: number; accuracy?: number | null; at: string }
export type Snapped = { line: LL[]; snapped: LL[]; matched: boolean }

const R = 6_371_000
const rad = Math.PI / 180
export const metres = (a: LL, b: LL) => {
  const dLat = (b[1] - a[1]) * rad, dLng = (b[0] - a[0]) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}
export const cumulative = (line: LL[]) => { const c = [0]; for (let i = 1; i < line.length; i++) c.push(c[i - 1] + metres(line[i - 1], line[i])); return c }

// where along a line (in metres) each point sits; points are in travel order, so the search only moves forward (and a little ahead, not to the end,
// so a route that comes back along the same road is not confused)
export function alongLine(line: LL[], cum: number[], pts: LL[]) {
  const out: number[] = []
  let seg = 0
  for (const p of pts) {
    let best = Infinity, bestD = out.length ? out[out.length - 1] : 0, bestSeg = seg
    const end = Math.min(line.length - 1, seg + 150)
    for (let i = seg; i < end; i++) {
      const a = line[i], b = line[i + 1]
      const k = Math.cos(a[1] * rad) * 111_320
      const bx = (b[0] - a[0]) * k, by = (b[1] - a[1]) * 110_540, px = (p[0] - a[0]) * k, py = (p[1] - a[1]) * 110_540
      const len2 = bx * bx + by * by
      const t = len2 ? Math.max(0, Math.min(1, (px * bx + py * by) / len2)) : 0
      const dist = Math.hypot(px - t * bx, py - t * by)
      if (dist < best) { best = dist; bestD = cum[i] + t * (cum[i + 1] - cum[i]); bestSeg = i }
    }
    out.push(Math.max(bestD, out.length ? out[out.length - 1] : 0)); seg = bestSeg
  }
  return out
}
export function pointAt(line: LL[], cum: number[], d: number): LL {
  if (d <= 0 || line.length < 2) return line[0]
  if (d >= cum[cum.length - 1]) return line[line.length - 1]
  let lo = 0, hi = cum.length - 1
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= d) lo = mid; else hi = mid }
  const t = (d - cum[lo]) / ((cum[hi] - cum[lo]) || 1)
  return [line[lo][0] + t * (line[hi][0] - line[lo][0]), line[lo][1] + t * (line[hi][1] - line[lo][1])]
}

const CHUNK = 90 // coordinates a request (the API allows 100)
const cache = new Map<string, { line: LL[]; snapped: LL[] } | null>()
const ll = (p: GpsPoint): LL => [p.longitude, p.latitude]
const profileFor = (pts: GpsPoint[]) => {
  let m = 0
  for (let i = 1; i < pts.length; i++) m += metres(ll(pts[i - 1]), ll(pts[i]))
  const s = (+new Date(pts[pts.length - 1].at) - +new Date(pts[0].at)) / 1000
  return s > 0 && m / s < 2.5 ? 'walking' : 'driving' // under about 9 km/h is a person on foot
}

async function matchChunk(pts: GpsPoint[], token: string, signal?: AbortSignal) {
  const key = `${profileFor(pts)}|${pts[0].at}|${pts[pts.length - 1].at}|${pts.length}`
  if (cache.has(key)) return cache.get(key)!
  const profile = profileFor(pts)
  let last = 0
  const times = pts.map((p) => { last = Math.max(last + 1, Math.floor(+new Date(p.at) / 1000)); return last }) // strictly increasing seconds
  const radiuses = pts.map((p) => Math.round(Math.min(50, Math.max(15, p.accuracy ?? 25))))
  const url = `https://api.mapbox.com/matching/v5/mapbox/${profile}/${pts.map((p) => `${p.longitude.toFixed(6)},${p.latitude.toFixed(6)}`).join(';')}?geometries=geojson&overview=full&gaps=ignore&tidy=true&radiuses=${radiuses.join(';')}&timestamps=${times.join(';')}&access_token=${encodeURIComponent(token)}`
  let result: { line: LL[]; snapped: LL[] } | null = null
  try {
    const res = await fetch(url, { signal })
    const body: any = await res.json()
    if (body?.code === 'Ok' && body.matchings?.length) {
      const line: LL[] = []
      for (const m of body.matchings) for (const c of m.geometry.coordinates as LL[]) line.push(c)
      const snapped = pts.map((p, i) => (body.tracepoints?.[i]?.location as LL | undefined) ?? ll(p))
      if (line.length > 1) result = { line, snapped }
    }
  } catch (e: any) { if (e?.name === 'AbortError') throw e }
  cache.set(key, result) // a failed stretch is remembered too, so it is not asked again every refresh
  return result
}

// One continuous piece of a route (no long pause inside it) -> the road-following line and each point's snapped place
export async function snapPiece(pts: GpsPoint[], token: string, signal?: AbortSignal): Promise<Snapped> {
  const raw = pts.map(ll)
  if (pts.length < 2) return { line: raw, snapped: raw, matched: false }
  const line: LL[] = [], snapped: LL[] = []
  let any = false
  for (let from = 0; from < pts.length - 1; from += CHUNK - 1) {
    const part = pts.slice(from, Math.min(pts.length, from + CHUNK))
    if (part.length < 2) break
    const r = await matchChunk(part, token, signal)
    if (r) { any = true; line.push(...(line.length ? r.line.slice(1) : r.line)); snapped.push(...(snapped.length ? r.snapped.slice(1) : r.snapped)) }
    else { const rr = part.map(ll); line.push(...(line.length ? rr.slice(1) : rr)); snapped.push(...(snapped.length ? rr.slice(1) : rr)) }
  }
  return { line, snapped, matched: any }
}

// Self-check: npx ts-node --transpile-only src/lib/roadSnap.ts
declare const require: any, module: any
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  const line: LL[] = [[0, 0], [0, 0.001], [0.001, 0.001]]
  const cum = cumulative(line)
  console.assert(Math.abs(cum[1] - 111.2) < 1 && Math.abs(cum[2] - 222.4) < 2, 'distances along a line')
  const d = alongLine(line, cum, [[0, 0.0005], [0.0005, 0.001]])
  console.assert(Math.abs(d[0] - 55.6) < 1.5 && Math.abs(d[1] - (111.2 + 55.6)) < 2, 'points are placed along the line')
  const mid = pointAt(line, cum, 111.2 + 55.6)
  console.assert(Math.abs(mid[0] - 0.0005) < 1e-5 && Math.abs(mid[1] - 0.001) < 1e-5, 'a distance gives back its place on the line')
  console.assert(metres([0, 0], [0, 0.001]) > 110 && metres([0, 0], [0, 0.001]) < 112, 'haversine')
  console.log('road snap check done')
}
