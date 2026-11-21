// Health and status endpoints.
//   GET /health         liveness: always 200 and instant (what Railway's healthcheck calls). Browsers get the status page, everything else gets JSON.
//   GET /health/status  the same data as JSON, with the history bars' samples.
//   GET /health/ready   readiness for load balancers: live database + Redis check, 503 if either is down.
// Public, so it shows only component states and timings: never keys, hosts or user data.
import { Router, type Request } from 'express'
import mongoose from 'mongoose'
import { prisma as db } from '../database/prisma'
import { redis } from '../cache/redis'

type State = 'up' | 'degraded' | 'down'
type Sample = { t: number; s: State; ms: number }
const IS_MONGO = process.env.DB_PROVIDER === 'mongo'
const BARS = 90
const EVERY_MS = Math.max(30, Number(process.env.HEALTH_SAMPLE_SECONDS) || 120) * 1000 // each sample is one Mongo ping and one Redis ping
const startedAt = Date.now()
const history: Record<string, Sample[]> = { api: [], database: [], redis: [] }

async function timed(f: () => Promise<unknown>) {
  const t = Date.now()
  try {
    await Promise.race([f(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))])
    const ms = Date.now() - t
    return { ok: true, ms, state: (ms > 1000 ? 'degraded' : 'up') as State }
  } catch (e: any) { return { ok: false, ms: Date.now() - t, state: 'down' as State, error: String(e?.message || e).slice(0, 120) } }
}
const checkDb = () => timed(() => (IS_MONGO ? mongoose.connection.db!.admin().ping() : db.$queryRaw`SELECT 1`))
const checkRedis = () => timed(() => redis.ping())

let last = 0
async function sample() {
  const [d, r] = await Promise.all([checkDb(), checkRedis()])
  const t = Date.now()
  last = t
  for (const [k, v] of [['api', { state: 'up' as State, ms: 0 }], ['database', d], ['redis', r]] as const) {
    const h = history[k]; h.push({ t, s: v.state, ms: v.ms }); if (h.length > BARS) h.shift()
  }
}

const pct = (h: Sample[]) => (h.length ? Math.round((h.filter((x) => x.s !== 'down').length / h.length) * 1000) / 10 : 100)
const worst = (...s: State[]): State => (s.includes('down') ? 'down' : s.includes('degraded') ? 'degraded' : 'up')
const on = (v: unknown) => !!v && String(v).trim() !== ''

async function snapshot() {
  if (Date.now() - last > 30_000) await sample() // a burst of page loads costs one check, not one each
  const cur = (k: string) => history[k][history[k].length - 1] ?? { t: 0, s: 'up' as State, ms: 0 }
  const lagStart = Date.now(); await new Promise((r) => setImmediate(r)); const lag = Date.now() - lagStart
  const comps = [
    { key: 'api', name: 'API', note: 'HTTP server', detail: `event loop lag ${lag} ms` },
    { key: 'database', name: IS_MONGO ? 'Database (MongoDB)' : 'Database (PostgreSQL)', note: 'Ping round trip', detail: '' },
    { key: 'redis', name: 'Cache and queues (Redis)', note: 'Ping round trip', detail: '' },
  ].map((c) => ({ ...c, state: cur(c.key).s, ms: cur(c.key).ms, uptimePct: pct(history[c.key]), history: history[c.key] }))
  const mem = process.memoryUsage()
  const env = process.env
  return {
    status: worst(...comps.map((c) => c.state)),
    timestamp: new Date().toISOString(),
    service: 'MarichiHR API',
    environment: env.NODE_ENV ?? 'development',
    database: IS_MONGO ? 'mongodb' : 'postgres',
    version: env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? env.GIT_COMMIT?.slice(0, 7) ?? null,
    region: env.RAILWAY_REPLICA_REGION ?? null,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    runtime: { node: process.version, heapMb: Math.round(mem.heapUsed / 1048576), rssMb: Math.round(mem.rss / 1048576), eventLoopLagMs: lag },
    sampling: { everySeconds: EVERY_MS / 1000, window: BARS, note: 'History is kept in memory and restarts with the service' },
    components: comps,
    // Configured or not, never the values
    features: {
      scheduledJobs: env.JOBS_ENABLED === 'true' || !IS_MONGO,
      eventDelivery: IS_MONGO ? env.EVENT_PUMP !== 'false' : true,
      email: env.EMAIL_TRANSPORT === 'smtp' ? 'smtp' : env.EMAIL_TRANSPORT === 'resend' ? 'resend' : 'log only',
      storage: env.STORAGE_PROVIDER === 'cloudinary' ? on(env.CLOUDINARY_API_SECRET) : on(env.S3_SECRET_KEY),
      webPush: env.PUSH_ENABLED === 'true' && on(env.VAPID_PRIVATE_KEY),
      assistant: on(env.ANTHROPIC_API_KEY),
    },
  }
}
type Snap = Awaited<ReturnType<typeof snapshot>>

const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const LABEL: Record<State, string> = { up: 'Operational', degraded: 'Degraded', down: 'Outage' }
function dur(s: number) { const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s` }

function page(s: Snap) {
  const banner = { up: 'All systems operational', degraded: 'Some systems are slow', down: 'A service is down' }[s.status]
  const rows = s.components.map((c) => {
    const pad = Array.from({ length: BARS - c.history.length }, () => '<i class="e" title="No data yet"></i>')
    const bars = c.history.map((x) => `<i class="${x.s}" title="${esc(new Date(x.t).toISOString().slice(11, 19))} UTC · ${LABEL[x.s]}${x.ms ? ` · ${x.ms} ms` : ''}"></i>`)
    return `<section class="row"><div class="top"><div><b>${esc(c.name)}</b><small>${esc(c.note)}${c.detail ? ' · ' + esc(c.detail) : ''}</small></div><span class="pill ${c.state}">${c.ms && c.key !== 'api' ? c.ms + ' ms · ' : ''}${LABEL[c.state as State]}</span></div><div class="bars">${pad.join('')}${bars.join('')}</div><div class="foot"><span>${Math.round((BARS * EVERY_MS) / 60000)} min ago</span><span>${c.uptimePct}% up in this window</span><span>Now</span></div></section>`
  }).join('')
  const f = s.features
  const flag = (v: unknown, yes = 'Enabled', no = 'Off') => `<span class="pill ${v ? 'up' : 'mute'}">${typeof v === 'string' ? esc(v) : v ? yes : no}</span>`
  const feat = [
    ['Scheduled jobs', flag(f.scheduledJobs)], ['Event delivery (automations, webhooks)', flag(f.eventDelivery)], ['Email', flag(f.email !== 'log only' ? f.email : false, '', 'Log only')],
    ['Document storage', flag(f.storage, 'Configured', 'Not set up')], ['Web push', flag(f.webPush)], ['AI assistant', flag(f.assistant, 'Configured', 'Not set up')],
  ].map(([k, v]) => `<div class="kv"><span>${k}</span>${v}</div>`).join('')
  const meta = [['Environment', s.environment], ['Database', s.database], ['Build', s.version ?? 'n/a'], ['Region', s.region ?? 'n/a'], ['Uptime', dur(s.uptimeSeconds)], ['Node', s.runtime.node], ['Memory', `${s.runtime.rssMb} MB`], ['Last checked', s.timestamp.slice(11, 19) + ' UTC']]
    .map(([k, v]) => `<div class="m"><small>${k}</small><b>${esc(v)}</b></div>`).join('')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="30"><meta name="robots" content="noindex"><title>MarichiHR status</title><style>
:root{--bg:#faf8f3;--card:#fff;--ink:#252523;--mute:#74726b;--line:#e8e4da;--ok:#2f9e63;--warn:#e0a21c;--bad:#d64545;--e:#e3e0d6}
@media(prefers-color-scheme:dark){:root{--bg:#161614;--card:#1f1f1c;--ink:#f2efe6;--mute:#9a978d;--line:#34332e;--e:#2e2d29}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 Inter,system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 16px 64px}h1{font-size:20px;margin:0 0 20px;display:flex;gap:10px;align-items:center}h1 i{width:10px;height:10px;border-radius:50%;background:#f6c343}
.banner{border-radius:14px;padding:20px 22px;color:#fff;font-size:20px;font-weight:600;margin-bottom:20px}.banner.up{background:var(--ok)}.banner.degraded{background:var(--warn)}.banner.down{background:var(--bad)}
.banner small{display:block;font-weight:400;font-size:13px;opacity:.9;margin-top:2px}
.row,.box{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin-bottom:12px}
.top{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:12px}.top b{display:block}small{color:var(--mute);font-size:12.5px}
.bars{display:flex;gap:2px;height:34px}.bars i{flex:1;border-radius:2px;background:var(--ok);min-width:1px}.bars i.degraded{background:var(--warn)}.bars i.down{background:var(--bad)}.bars i.e{background:var(--e)}.bars i:hover{opacity:.7}
.foot{display:flex;justify-content:space-between;font-size:12px;color:var(--mute);margin-top:6px}
.pill{font-size:12px;font-weight:600;padding:3px 10px;border-radius:99px;white-space:nowrap;background:var(--e);color:var(--mute)}.pill.up{background:#2f9e6322;color:var(--ok)}.pill.degraded{background:#e0a21c26;color:var(--warn)}.pill.down{background:#d6454526;color:var(--bad)}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--mute);margin:28px 0 10px}
.kv{display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid var(--line)}.kv:last-child{border:0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px}.m small{display:block}.m b{font-weight:600;word-break:break-word}
.links{margin-top:22px;font-size:13px;color:var(--mute)}a{color:inherit}code{background:var(--e);padding:1px 6px;border-radius:5px}
</style></head><body><main><h1><i></i>MarichiHR status</h1>
<div class="banner ${s.status}">${banner}<small>Refreshes every 30 seconds · checked ${esc(s.timestamp.slice(11, 19))} UTC</small></div>
<h2>Components</h2>${rows}
<h2>Features on this server</h2><div class="box">${feat}</div>
<h2>Service</h2><div class="box grid">${meta}</div>
<p class="links">For tools: <a href="/health?format=json"><code>/health?format=json</code></a> · <a href="/health/status"><code>/health/status</code></a> · <a href="/health/ready"><code>/health/ready</code></a> (503 when the database or Redis is down). Bars show one check every ${EVERY_MS / 1000} seconds since the service last started.</p>
</main></body></html>`
}

const wantsHtml = (req: Request) => req.query.format !== 'json' && (req.headers.accept ?? '').includes('text/html')

export function healthRouter() {
  const r = Router()
  // No sample at start-up: the app is built before the database connects, so it would record a false outage
  setInterval(() => void sample().catch(() => {}), EVERY_MS).unref()

  r.get('/health', async (req, res) => {
    if (wantsHtml(req)) { res.setHeader('Cache-Control', 'no-store'); return res.type('html').send(page(await snapshot())) }
    // Liveness only: no database call, so a slow dependency never makes the host restart a healthy process
    res.json({ status: 'ok', timestamp: new Date().toISOString(), environment: process.env.NODE_ENV, service: 'MarichiHR API', database: IS_MONGO ? 'mongodb' : 'postgres', uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) })
  })
  r.get('/health/status', async (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json(await snapshot()) })
  r.get('/health/ready', async (_req, res) => {
    const [database, cache] = await Promise.all([checkDb(), checkRedis()])
    const ok = database.ok && cache.ok
    res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'degraded', database, redis: cache, timestamp: new Date().toISOString() })
  })
  return r
}
