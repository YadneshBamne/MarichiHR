import { Router } from 'express'
import { z } from 'zod'
import { authenticate } from '../../middleware/auth.middleware'
import { requireFeature, tenantModules } from '../../middleware/module.middleware'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { AppError } from '../../shared/utils/AppError'
import { redis, soft } from '../../infrastructure/cache/redis'
import { Tenant, Employee, AuditLog } from '../../infrastructure/mongo/mongo'
import { entitlements } from '../company/plans.catalog'
import { assistantConfigured, runAssistant } from './assistant.engine'

// The MarichiHR assistant (MongoDB mode). Needs the "assistant" feature on the company's plan and ANTHROPIC_API_KEY on the server.
// The browser sends the conversation so far; nothing is stored. Only the tool names used are written to the audit log, never the text.
export const assistantRouter = Router()
assistantRouter.use(authenticate, requireFeature('assistant'))
const PER_HOUR = 40

assistantRouter.get('/status', asyncHandler(async (_req, res) => { res.json({ success: true, data: { configured: assistantConfigured() } }) }))

const Chat = z.object({ messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().trim().min(1).max(2000) }).strict()).min(1).max(20) }).strict()
assistantRouter.post('/chat', validate(z.object({ body: Chat })), asyncHandler(async (req, res) => {
  const { tenantId, userId, employeeId, roleIds } = req.user!
  const messages = req.body.messages as { role: 'user' | 'assistant'; content: string }[]
  if (messages[messages.length - 1].role !== 'user') throw new AppError('The last message must be from you', 400)
  if (!assistantConfigured()) throw new AppError('The assistant is not set up on this server yet.', 503, 'ASSISTANT_NOT_CONFIGURED')
  const used = await soft(async () => { const k = `assistant:${userId}:${Math.floor(Date.now() / 3_600_000)}`; const n = await redis.incr(k); if (n === 1) await redis.expire(k, 3700); return n }, 0)
  if (used > PER_HOUR) throw new AppError(`You've reached ${PER_HOUR} assistant messages this hour. Try again later.`, 429)
  const [t, e]: any[] = await Promise.all([Tenant.findById(tenantId).select('name plan addons modules').lean(), employeeId ? Employee.findOne({ _id: employeeId, tenantId }).select('firstName lastName').lean() : null])
  const ent = entitlements(t?.plan, t?.addons)
  const features = [...new Set([...(await tenantModules(tenantId)), ...ent.features])]
  const r = await runAssistant({ tenantId, userId, employeeId, roleIds, features }, { company: t?.name ?? 'your company', name: e ? `${e.firstName} ${e.lastName}` : 'the user' }, messages)
  await AuditLog.create({ tenantId, userId, action: 'ASSISTANT_USED', entityType: 'assistant', entityId: userId, newValue: { tools: r.toolsUsed } })
  res.json({ success: true, data: { reply: r.reply, proposals: r.proposals } })
}))
