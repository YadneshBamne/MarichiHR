import { Router } from 'express'
import { z } from 'zod'
import { authenticate } from '../../middleware/auth.middleware'
import { requirePermission } from '../../middleware/rbac.middleware'
import { validate } from '../../middleware/validate.middleware'
import { activitiesController } from './activities.controller'

export const activitiesRouter = Router()

activitiesRouter.use(authenticate)

// Dashboard
activitiesRouter.get('/dashboard', activitiesController.dashboard)

// Chatter (before /:id routes to avoid param conflicts)
activitiesRouter.post('/chatter', activitiesController.postMessage)
activitiesRouter.get('/chatter/:entityType/:entityId', activitiesController.listMessages)

// Tasks: anyone makes their own; managers for their team and HR for anyone (checked in the service); only the maker cancels
const NewTask = z.object({
  activityTypeId: z.string().uuid(),
  title: z.string().trim().min(2).max(140),
  note: z.string().trim().max(1000).optional(),
  assignedToId: z.string().uuid(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'Choose a due date'),
  entityType: z.enum(['employee', 'leave_request', 'contract', 'attendance_regularisation']).optional(),
  entityId: z.string().uuid().optional(),
}).strict().refine((b) => !!b.entityType === !!b.entityId, 'Say both what it is about and which record')
activitiesRouter.get('/types', activitiesController.types)
activitiesRouter.get('/mine', activitiesController.listMine)
activitiesRouter.get('/created', activitiesController.listCreated)
activitiesRouter.post('/', validate(z.object({ body: NewTask })), activitiesController.create)
activitiesRouter.get('/:entityType/:entityId', requirePermission('employees:read'), activitiesController.listForEntity)
activitiesRouter.post('/:id/complete', validate(z.object({ body: z.object({ doneNote: z.string().trim().max(500).default('') }).strict() })), activitiesController.complete)
activitiesRouter.post('/:id/cancel', activitiesController.cancel)
