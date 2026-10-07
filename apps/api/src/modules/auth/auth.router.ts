import { Router } from 'express'
import { authController } from './auth.controller'
import { validate } from '../../middleware/validate.middleware'
import { authenticate } from '../../middleware/auth.middleware'
import { LoginSchema, RefreshSchema } from './auth.schema'

export const authRouter = Router()

authRouter.post('/login', validate(LoginSchema), authController.login)
authRouter.post('/refresh', validate(RefreshSchema), authController.refresh)
authRouter.post('/logout', authController.logout)
authRouter.get('/me', authenticate, authController.me)
