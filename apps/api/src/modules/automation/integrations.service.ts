import crypto from 'crypto'
import dns from 'dns/promises'
import net from 'net'
import { z } from 'zod'
import { prisma } from '../../infrastructure/database/prisma'
import { AppError } from '../../shared/utils/AppError'
import { AccessUser } from '../../shared/utils/access'
import { encryptField, decryptField, lookupHash } from '../../shared/utils/crypto'
import { TRIGGER } from './automation.catalog'

// Integration layer: outbound webhooks (signed, retried) and inbound API keys (read-only scopes).

const SYSTEM = ['system_admin']
const assertSystem = (u: AccessUser) => { if (!u.roleIds.some((r) => SYSTEM.includes(r))) throw new AppError('Only system admins manage integrations', 403) }
const MAX_ATTEMPTS = 6
const BACKOFF_MIN = [1, 5, 30, 120, 720] // minutes before attempts 2..6

// ─── Webhook URL safety: https only, never a private, loopback or link-local address ─
function privateIp(ip: string) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
  }
  const x = ip.toLowerCase()
  if (x.startsWith('::ffff:')) return privateIp(x.slice(7))
  return x === '::' || x === '::1' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80') || x.startsWith('ff')
}
export async function assertPublicUrl(raw: string) {
  let u: URL
  try { u = new URL(raw) } catch { throw new AppError('Not a valid URL', 400) }
  if (u.protocol !== 'https:') throw new AppError('Webhook URLs must use https', 400)
  if (u.username || u.password) throw new AppError('Put credentials in the signing secret, not the URL', 400)
  const host = u.hostname.replace(/^\[|\]$/g, '')
  const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address)
  if (!ips.length) throw new AppError(`Cannot resolve ${host}`, 400)
  if (ips.some(privateIp)) throw new AppError('Webhook URLs must point to a public address', 400)
  return u
}

export const sign = (secret: string, ts: number, body: string) => crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')

export const WebhookBody = z.object({
  name: z.string().trim().min(2).max(80),
  url: z.string().trim().max(500),
  events: z.array(z.string().refine((e) => !!TRIGGER[e], 'Unknown event')).min(1).max(40),
  active: z.boolean().default(true),
}).strict()

// One delivery attempt; never throws (the result is recorded on the delivery row)
async function attempt(deliveryId: string) {
  const d = await prisma.webhookDelivery.findUnique({ where: { id: deliveryId } })
  if (!d || d.status === 'delivered' || d.status === 'dead') return
  const [hook, event] = await Promise.all([
    prisma.webhook.findFirst({ where: { id: d.webhookId, tenantId: d.tenantId } }),
    prisma.domainEvent.findFirst({ where: { id: d.eventId, tenantId: d.tenantId } }),
  ])
  if (!hook || !hook.active || !event) { await prisma.webhookDelivery.update({ where: { id: d.id }, data: { status: 'dead', lastError: 'Webhook disabled or event gone' } }); return }
  const body = JSON.stringify({ id: event.id, type: event.eventType, createdAt: event.createdAt, data: event.payload })
  const ts = Math.floor(Date.now() / 1000)
  let code: number | null = null, error: string | null = null
  try {
    await assertPublicUrl(hook.url) // again at send time: DNS may have changed since the URL was saved
    const res = await fetch(hook.url, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(8000),
      headers: { 'content-type': 'application/json', 'user-agent': 'MarichiHR-Webhooks/1', 'x-marichihr-event': event.eventType, 'x-marichihr-delivery': d.id, 'x-marichihr-signature': `t=${ts},v1=${sign(decryptField(hook.secret), ts, body)}` },
      body,
    })
    code = res.status
    if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`
  } catch (err: any) {
    error = String(err?.message ?? err).slice(0, 300)
  }
  const attempts = d.attempts + 1
  if (!error) await prisma.webhookDelivery.update({ where: { id: d.id }, data: { status: 'delivered', attempts, responseCode: code, lastError: null, deliveredAt: new Date(), nextAttemptAt: null } })
  else {
    const dead = attempts >= MAX_ATTEMPTS
    await prisma.webhookDelivery.update({ where: { id: d.id }, data: { status: dead ? 'dead' : 'failed', attempts, responseCode: code, lastError: error, nextAttemptAt: dead ? null : new Date(Date.now() + BACKOFF_MIN[attempts - 1] * 60_000) } })
  }
}

// Called by dispatchEvent: one delivery per subscribed webhook (idempotent), first attempt straight away
export async function queueWebhooks(e: { id: string; tenantId: string; eventType: string }) {
  const hooks = await prisma.webhook.findMany({ where: { tenantId: e.tenantId, active: true, events: { has: e.eventType } }, select: { id: true } })
  for (const h of hooks) {
    const d = await prisma.webhookDelivery.upsert({ where: { webhookId_eventId: { webhookId: h.id, eventId: e.id } }, create: { tenantId: e.tenantId, webhookId: h.id, eventId: e.id, eventType: e.eventType }, update: {} })
    if (d.status === 'pending') await attempt(d.id)
  }
}

// Job: retry failed deliveries whose backoff has passed
export async function retryWebhooks(tenantId?: string) {
  const due = await prisma.webhookDelivery.findMany({ where: { ...(tenantId && { tenantId }), status: 'failed', nextAttemptAt: { lte: new Date() } }, select: { id: true }, take: 200, orderBy: { nextAttemptAt: 'asc' } })
  for (const d of due) await attempt(d.id)
  return due.length
}

export const webhookService = {
  async list(user: AccessUser) {
    assertSystem(user)
    const hooks = await prisma.webhook.findMany({ where: { tenantId: user.tenantId }, orderBy: { name: 'asc' } })
    return hooks.map(({ secret: _s, ...h }) => h)
  },
  async create(user: AccessUser, body: z.infer<typeof WebhookBody>) {
    assertSystem(user)
    await assertPublicUrl(body.url)
    const secret = `whsec_${crypto.randomBytes(24).toString('hex')}`
    const hook = await prisma.webhook.create({ data: { tenantId: user.tenantId, name: body.name, url: body.url, events: body.events, active: body.active, secret: encryptField(secret), createdBy: user.userId } })
    await prisma.auditLog.create({ data: { tenantId: user.tenantId, userId: user.userId, action: 'WEBHOOK_CREATED', entityType: 'webhook', entityId: hook.id, newValue: { name: body.name, url: body.url, events: body.events } } })
    const { secret: _s, ...rest } = hook
    return { ...rest, signingSecret: secret } // shown once
  },
  async update(user: AccessUser, id: string, body: z.infer<typeof WebhookBody>) {
    assertSystem(user)
    await assertPublicUrl(body.url)
    const res = await prisma.webhook.updateMany({ where: { id, tenantId: user.tenantId }, data: { name: body.name, url: body.url, events: body.events, active: body.active } })
    if (!res.count) throw new AppError('Webhook not found', 404)
    await prisma.auditLog.create({ data: { tenantId: user.tenantId, userId: user.userId, action: 'WEBHOOK_UPDATED', entityType: 'webhook', entityId: id, newValue: body } })
    return (await webhookService.list(user)).find((h) => h.id === id)
  },
  async deliveries(user: AccessUser, id: string) {
    assertSystem(user)
    if (!(await prisma.webhook.findFirst({ where: { id, tenantId: user.tenantId }, select: { id: true } }))) throw new AppError('Webhook not found', 404)
    return prisma.webhookDelivery.findMany({ where: { webhookId: id, tenantId: user.tenantId }, orderBy: { createdAt: 'desc' }, take: 50 })
  },
  // Send a test ping right now (a real signed request, recorded like any delivery)
  async ping(user: AccessUser, id: string) {
    assertSystem(user)
    const hook = await prisma.webhook.findFirst({ where: { id, tenantId: user.tenantId } })
    if (!hook) throw new AppError('Webhook not found', 404)
    const event = await prisma.domainEvent.create({ data: { tenantId: user.tenantId, eventType: 'webhook.ping', payload: { webhookId: id, message: 'Test delivery from MarichiHR' }, status: 'delivered', deliveredAt: new Date() } })
    const d = await prisma.webhookDelivery.create({ data: { tenantId: user.tenantId, webhookId: id, eventId: event.id, eventType: 'webhook.ping' } })
    await attempt(d.id)
    return prisma.webhookDelivery.findUnique({ where: { id: d.id } })
  },
  async redeliver(user: AccessUser, deliveryId: string) {
    assertSystem(user)
    const d = await prisma.webhookDelivery.findFirst({ where: { id: deliveryId, tenantId: user.tenantId } })
    if (!d) throw new AppError('Delivery not found', 404)
    await prisma.webhookDelivery.update({ where: { id: d.id }, data: { status: 'pending', attempts: 0, nextAttemptAt: null } })
    await attempt(d.id)
    return prisma.webhookDelivery.findUnique({ where: { id: d.id } })
  },
}

// ─── API keys ─────────────────────────────────────────────────
export const API_SCOPES = ['employees:read', 'org:read', 'leave:read', 'attendance:read', 'attendance:write'] as const
export const ApiKeyBody = z.object({ name: z.string().trim().min(2).max(80), scopes: z.array(z.enum(API_SCOPES)).min(1), expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).strict()
const hashKey = (key: string) => lookupHash('api_key', key)

export const apiKeyService = {
  async list(user: AccessUser) {
    assertSystem(user)
    const keys = await prisma.apiKey.findMany({ where: { tenantId: user.tenantId }, orderBy: [{ active: 'desc' }, { createdAt: 'desc' }] })
    return keys.map(({ keyHash: _h, ...k }) => k)
  },
  async create(user: AccessUser, body: z.infer<typeof ApiKeyBody>) {
    assertSystem(user)
    if (body.expiresAt && body.expiresAt <= new Date().toISOString().slice(0, 10)) throw new AppError('The expiry date must be in the future', 400)
    const key = `mhr_${crypto.randomBytes(24).toString('hex')}`
    const row = await prisma.apiKey.create({ data: { tenantId: user.tenantId, name: body.name, prefix: key.slice(0, 12), keyHash: hashKey(key), scopes: body.scopes, expiresAt: body.expiresAt ? new Date(`${body.expiresAt}T23:59:59Z`) : null, createdBy: user.userId } })
    await prisma.auditLog.create({ data: { tenantId: user.tenantId, userId: user.userId, action: 'API_KEY_CREATED', entityType: 'api_key', entityId: row.id, newValue: { name: body.name, scopes: body.scopes, prefix: row.prefix } } })
    const { keyHash: _h, ...rest } = row
    return { ...rest, key } // shown once
  },
  async revoke(user: AccessUser, id: string) {
    assertSystem(user)
    const res = await prisma.apiKey.updateMany({ where: { id, tenantId: user.tenantId, active: true }, data: { active: false } })
    if (!res.count) throw new AppError('Key not found', 404)
    await prisma.auditLog.create({ data: { tenantId: user.tenantId, userId: user.userId, action: 'API_KEY_REVOKED', entityType: 'api_key', entityId: id } })
    return { revoked: true }
  },
  // For the integration API middleware: the active, unexpired key or null
  async resolve(key: string) {
    if (!/^mhr_[0-9a-f]{48}$/.test(key)) return null
    const row = await prisma.apiKey.findUnique({ where: { keyHash: hashKey(key) } })
    if (!row || !row.active || (row.expiresAt && row.expiresAt < new Date())) return null
    const tenant = await prisma.tenant.findFirst({ where: { id: row.tenantId, active: true }, select: { id: true } })
    if (!tenant) return null
    // ponytail: lastUsedAt written at most once a minute per key
    if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000) await prisma.apiKey.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
    return row
  },
}
