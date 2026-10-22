import { Router } from 'express'
import { authenticate } from '../../middleware/auth.middleware'
import { requirePermission, requireRoles } from '../../middleware/rbac.middleware'
import { validate } from '../../middleware/validate.middleware'
import { exitsController as c } from './exits.controller'
import { InitiateExitSchema, ExitIdSchema, SignClearanceSchema, ComputeSchema, CancelExitSchema } from './exits.schema'

export const exitsRouter = Router()

exitsRouter.use(authenticate)

// HR initiates and runs clearances; Payroll admins compute, approve and pay the settlement (two different people,
// enforced in the service). Only Payroll admins see its amounts.
const hr = requireRoles('hr_admin')
const payroll = requireRoles('payroll_admin')
const staff = requireRoles('hr_admin', 'payroll_admin')

exitsRouter.post('/', hr, validate(InitiateExitSchema), c.initiate)
exitsRouter.get('/', staff, c.list)
exitsRouter.get('/assignable-users', hr, c.assignableUsers)
// Any user can be assigned a sign-off, so these two are open to every authenticated user (filtered in the service)
exitsRouter.get('/clearances/mine', c.myClearances)
exitsRouter.post('/:id/clearances/:department/sign', validate(SignClearanceSchema), c.sign)

exitsRouter.get('/:id', validate(ExitIdSchema), c.get)
exitsRouter.post('/:id/compute', payroll, validate(ComputeSchema), c.compute)
exitsRouter.post('/:id/approve', requirePermission('payroll:disburse'), validate(ExitIdSchema), c.approve)
exitsRouter.post('/:id/pay', requirePermission('payroll:disburse'), validate(ExitIdSchema), c.pay)
exitsRouter.post('/:id/cancel', hr, validate(CancelExitSchema), c.cancel)
exitsRouter.get('/:id/settlement.pdf', payroll, validate(ExitIdSchema), c.pdf)
