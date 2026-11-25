// Turns a phone's sparse, noisy GPS points into a route that follows the roads, like a delivery app's. Built from Mapbox's own APIs:
//  1. clean the points (drop very vague ones, merge points that are only GPS jitter);
//  2. Map Matching (api.mapbox.com/matching/v5): snaps the trace to the road network, when the points are good enough to match;
//  3. if a stretch cannot be matched (indoors, a compound, poor accuracy), Directions (api.mapbox.com/directions/v5) routes each hop over the roads,
//     and a hop whose road route is far longer than the straight distance (a GPS-noise detour) stays a straight line.
// Nothing is invented: every line is either a Mapbox road geometry or the straight line between two points.
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

// where along a line (in metres) each point sits; points are in travel order, so the search only moves forward (and a limited way ahead,
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

const ll = (p: GpsPoint): LL => [p.longitude, p.latitude]
const acc = (p: GpsPoint) => p.accuracy ?? 25

// Which points to keep: drop the very vague ones (over 100 m), then drop a point that is closer to the last kept one than the GPS could tell
// apart (0.8 x the vaguer accuracy, between 40 and 150 m). The last point always stays. Returns indices into the original list.
export function keepIndices(pts: GpsPoint[]): number[] {
  if (!pts.length) return []
  const usable = pts.map((_, i) => i).filter((i) => acc(pts[i]) <= 100)
  const base = usable.length >= 2 ? usable : pts.map((_, i) => i)
  const keep = [base[0]]
  for (let k = 1; k < base.length; k++) {
    const a = pts[keep[keep.length - 1]], b = pts[base[k]]
    const min = Math.min(150, Math.max(40, 0.8 * Math.max(acc(a), acc(b))))
    if (k === base.length - 1 || metres(ll(a), ll(b)) >= min) keep.push(base[k])
  }
  return keep
}

const profileFor = (pts: GpsPoint[]) => {
  let m = 0
  for (let i = 1; i < pts.length; i++) m += metres(ll(pts[i - 1]), ll(pts[i]))
  const s = (+new Date(pts[pts.length - 1].at) - +new Date(pts[0].at)) / 1000
  return s > 0 && m / s < 2.5 ? 'walking' : 'driving' // under about 9 km/h is a person on foot
}

// Answers are remembered for the tab (a day's points never change), so reopening a route, or a live route growing, only asks for what is new
const store = (() => { try { return window.sessionStorage } catch { return null } })()
const KEY = 'marichi.road.v1'
const mem = new Map<string, LL[] | null>()
try { for (const [k, v] of JSON.parse(store?.getItem(KEY) ?? '[]')) mem.set(k, v) } catch { /* no saved answers */ }
let saving: ReturnType<typeof setTimeout> | null = null
const remember = (k: string, v: LL[] | null) => {
  mem.set(k, v)
  if (mem.size > 700) for (const old of [...mem.keys()].slice(0, 100)) mem.delete(old)
  if (saving) return
  saving = setTimeout(() => { saving = null; try { store?.setItem(KEY, JSON.stringify([...mem])) } catch { /* storage full or off */ } }, 800)
}
const c6 = (c: LL) => `${c[0].toFixed(5)},${c[1].toFixed(5)}`

async function matchChunk(pts: GpsPoint[], profile: string, token: string, signal?: AbortSignal): Promise<{ line: LL[]; snapped: LL[] } | null> {
  const key = `m|${profile}|${pts.map((p) => c6(ll(p))).join(';')}`
  if (mem.has(key)) { const v: any = mem.get(key); return v ? { line: v.line ?? v, snapped: v.snapped ?? v } : null }
  const radiuses = pts.map((p) => Math.round(Math.min(50, Math.max(15, acc(p)))))
  const url = `https://api.mapbox.com/matching/v5/mapbox/${profile}/${pts.map((p) => `${p.longitude.toFixed(6)},${p.latitude.toFixed(6)}`).join(';')}?geometries=geojson&overview=full&radiuses=${radiuses.join(';')}&access_token=${encodeURIComponent(token)}`
  let result: { line: LL[]; snapped: LL[] } | null = null
  try {
    const body: any = await (await fetch(url, { signal })).json()
    if (body?.code === 'Ok' && body.matchings?.length) {
      const line: LL[] = []
      for (const m of body.matchings) for (const c of m.geometry.coordinates as LL[]) line.push(c)
      if (line.length > 1) result = { line, snapped: pts.map((p, i) => (body.tracepoints?.[i]?.location as LL | undefined) ?? ll(p)) }
    }
  } catch (e: any) { if (e?.name === 'AbortError') throw e }
  remember(key, result ? ({ line: result.line, snapped: result.snapped } as any) : null)
  return result
}

// One hop between two points routed over the roads; a route much longer than the straight distance is a noise detour, so it is not used
async function routeHop(a: LL, b: LL, profile: string, token: string, signal?: AbortSignal): Promise<LL[] | null> {
  const straight = metres(a, b)
  if (straight < 30) return null
  const key = `d|${profile}|${c6(a)}|${c6(b)}`
  if (mem.has(key)) return mem.get(key)!
  let out: LL[] | null = null
  try {
    const j: any = await (await fetch(`https://api.mapbox.com/directions/v5/mapbox/${profile}/${a[0].toFixed(6)},${a[1].toFixed(6)};${b[0].toFixed(6)},${b[1].toFixed(6)}?geometries=geojson&overview=full&radiuses=unlimited;unlimited&access_token=${encodeURIComponent(token)}`, { signal })).json()
    const r = j?.routes?.[0]
    if (j?.code === 'Ok' && r && r.distance <= straight * 1.8 + 60) out = r.geometry.coordinates
  } catch (e: any) { if (e?.name === 'AbortError') throw e }
  remember(key, out)
  return out
}

const CHUNK = 90 // coordinates a matching request (the API allows 100)
const join = (into: LL[], more: LL[]) => { into.push(...(into.length && more.length && metres(into[into.length - 1], more[0]) < 1 ? more.slice(1) : more)) }

// One continuous piece of a route (no long pause inside it) -> the road-following line, and where each original point sits on it
export async function snapPiece(pts: GpsPoint[], token: string, signal?: AbortSignal): Promise<Snapped> {
  const rawAll = pts.map(ll)
  const idx = keepIndices(pts)
  const kept = idx.map((i) => pts[i])
  if (kept.length < 2) return { line: rawAll, snapped: rawAll, matched: false }
  const profile = profileFor(kept)
  const line: LL[] = [], snapKept: LL[] = []
  let matched = false
  for (let from = 0; from < kept.length - 1; from += CHUNK - 1) {
    const part = kept.slice(from, Math.min(kept.length, from + CHUNK))
    if (part.length < 2) break
    const m = await matchChunk(part, profile, token, signal)
    let piece: LL[], snaps: LL[]
    if (m) { matched = true; piece = m.line; snaps = m.snapped }
    else {
      // hop by hop over the roads (a few at a time), a straight line where a hop cannot be routed sensibly
      const raw = part.map(ll)
      const hops: (LL[] | null)[] = new Array(raw.length - 1).fill(null)
      for (let s = 0; s < hops.length; s += 6) await Promise.all(hops.slice(s, s + 6).map(async (_, o) => { hops[s + o] = await routeHop(raw[s + o], raw[s + o + 1], profile, token, signal) }))
      piece = []; snaps = []
      hops.forEach((h, i) => { if (h) matched = true; join(piece, h ?? [raw[i], raw[i + 1]]); snaps.push(h ? h[0] : raw[i]) })
      snaps.push(hops[hops.length - 1] ? hops[hops.length - 1]![hops[hops.length - 1]!.length - 1] : raw[raw.length - 1])
    }
    join(line, piece)
    snapKept.push(...(snapKept.length ? snaps.slice(1) : snaps))
  }
  // every original point gets the snapped place of the latest kept point at or before it
  const snapped: LL[] = []
  let k = 0
  for (let i = 0; i < pts.length; i++) { while (k + 1 < idx.length && idx[k + 1] <= i) k++; snapped.push(snapKept[Math.min(k, snapKept.length - 1)] ?? rawAll[i]) }
  return { line, snapped, matched }
}

// Self-check: copy this file outside apps/web and run it with ts-node (the web package is an ES module)
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
  const P = (lat: number, accuracy: number, s: number): GpsPoint => ({ latitude: lat, longitude: 0, accuracy, at: new Date(s * 1000).toISOString() })
  const jitter = [P(0, 30, 0), P(0.0001, 30, 30), P(0.0002, 30, 60), P(0.002, 30, 90), P(0.0021, 30, 120)] // 11 m hops, then a 200 m jump, then 11 m
  console.assert(keepIndices(jitter).join() === '0,3,4', `jitter is merged, a real move and the last point stay (${keepIndices(jitter).join()})`)
  console.assert(keepIndices([P(0, 200, 0), P(0.003, 20, 30), P(0.006, 20, 60)]).join() === '1,2', 'a very vague point is dropped')
  console.assert(keepIndices([P(0, 200, 0), P(0.003, 300, 30)]).join() === '0,1', 'if too few are usable, all are kept')
  console.log('road snap check done')
}
