import { Router } from 'express'
import { authenticate } from '../../middleware/auth.middleware'
import { requirePermission } from '../../middleware/rbac.middleware'
import { activitiesController } from './activities.controller'

export const activitiesRouter = Router()

activitiesRouter.use(authenticate)

// Dashboard
activitiesRouter.get('/dashboard', activitiesController.dashboard)

// Chatter (before /:id routes to avoid param conflicts)
activitiesRouter.post('/chatter', activitiesController.postMessage)
activitiesRouter.get('/chatter/:entityType/:entityId', activitiesController.listMessages)

// Activities
activitiesRouter.get('/mine', activitiesController.listMine)
activitiesRouter.post('/', requirePermission('employees:write'), activitiesController.create)
activitiesRouter.get('/:entityType/:entityId', requirePermission('employees:read'), activitiesController.listForEntity)
activitiesRouter.post('/:id/complete', activitiesController.complete)
activitiesRouter.post('/:id/cancel', requirePermission('employees:write'), activitiesController.cancel)
