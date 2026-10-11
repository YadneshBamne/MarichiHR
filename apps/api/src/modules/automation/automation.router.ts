import { Router } from 'express'
import { z } from 'zod'
import { authenticate } from '../../middleware/auth.middleware'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { automationService, RuleBody } from './automation.service'
import { webhookService, WebhookBody, apiKeyService, ApiKeyBody, API_SCOPES } from './integrations.service'

// Admin API for automation rules (HR/system admins), webhooks and API keys (system admins)
export const automationRouter = Router()
automationRouter.use(authenticate)
const Id = z.object({ params: z.object({ id: z.string().uuid() }) })
const ok = (res: any, data: unknown, status = 200) => res.status(status).json({ success: true, data })

automationRouter.get('/catalog', asyncHandler(async (req, res) => ok(res, { ...automationService.catalog(req.user!), apiScopes: API_SCOPES })))
automationRouter.get('/rules', asyncHandler(async (req, res) => ok(res, await automationService.list(req.user!))))
automationRouter.post('/rules', validate(z.object({ body: RuleBody })), asyncHandler(async (req, res) => ok(res, await automationService.save(req.user!, req.body), 201)))
automationRouter.put('/rules/:id', validate(Id.extend({ body: RuleBody })), asyncHandler(async (req, res) => ok(res, await automationService.save(req.user!, req.body, String(req.params.id)))))
automationRouter.post('/rules/test', validate(z.object({ body: RuleBody })), asyncHandler(async (req, res) => ok(res, await automationService.test(req.user!, req.body))))
automationRouter.get('/runs', validate(z.object({ query: z.object({ ruleId: z.string().uuid().optional() }) })), asyncHandler(async (req, res) => ok(res, await automationService.runs(req.user!, req.query.ruleId as string | undefined))))

automationRouter.get('/webhooks', asyncHandler(async (req, res) => ok(res, await webhookService.list(req.user!))))
automationRouter.post('/webhooks', validate(z.object({ body: WebhookBody })), asyncHandler(async (req, res) => ok(res, await webhookService.create(req.user!, req.body), 201)))
automationRouter.put('/webhooks/:id', validate(Id.extend({ body: WebhookBody })), asyncHandler(async (req, res) => ok(res, await webhookService.update(req.user!, String(req.params.id), req.body))))
automationRouter.get('/webhooks/:id/deliveries', validate(Id), asyncHandler(async (req, res) => ok(res, await webhookService.deliveries(req.user!, String(req.params.id)))))
automationRouter.post('/webhooks/:id/ping', validate(Id), asyncHandler(async (req, res) => ok(res, await webhookService.ping(req.user!, String(req.params.id)))))
automationRouter.post('/deliveries/:id/redeliver', validate(Id), asyncHandler(async (req, res) => ok(res, await webhookService.redeliver(req.user!, String(req.params.id)))))

automationRouter.get('/api-keys', asyncHandler(async (req, res) => ok(res, await apiKeyService.list(req.user!))))
automationRouter.post('/api-keys', validate(z.object({ body: ApiKeyBody })), asyncHandler(async (req, res) => ok(res, await apiKeyService.create(req.user!, req.body), 201)))
automationRouter.post('/api-keys/:id/revoke', validate(Id), asyncHandler(async (req, res) => ok(res, await apiKeyService.revoke(req.user!, String(req.params.id)))))
