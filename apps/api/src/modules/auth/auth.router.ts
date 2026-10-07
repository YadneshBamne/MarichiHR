import { Router } from 'express'
import { authController } from './auth.controller'
import { validate } from '../../middleware/validate.middleware'
import { authenticate } from '../../middleware/auth.middleware'
import { LoginSchema, RefreshSchema, MfaVerifySchema, MfaCodeSchema, SsoExchangeSchema, GoogleIdTokenSchema, TourSchema, SignupSchema, ChangePasswordSchema } from './auth.schema'
import { googleSso } from './google.sso'

export const authRouter = Router()

authRouter.post('/login', validate(LoginSchema), authController.login)
authRouter.post('/signup', validate(SignupSchema), authController.signup)
authRouter.get('/workspace/:slug', authController.workspace)
authRouter.post('/change-password', authenticate, validate(ChangePasswordSchema), authController.changePassword)
authRouter.post('/refresh', validate(RefreshSchema), authController.refresh)
authRouter.post('/logout', authController.logout)
authRouter.get('/me', authenticate, authController.me)
authRouter.post('/me/tour', authenticate, validate(TourSchema), authController.setTour)

// ─── MFA (TOTP) ───────────────────────────────────────────────
authRouter.post('/mfa/verify', validate(MfaVerifySchema), authController.mfaVerify)
authRouter.post('/mfa/setup', authenticate, authController.mfaSetup)
authRouter.post('/mfa/enable', authenticate, validate(MfaCodeSchema), authController.mfaEnable)
authRouter.post('/mfa/disable', authenticate, validate(MfaCodeSchema), authController.mfaDisable)

// ─── GOOGLE SSO ───────────────────────────────────────────────
authRouter.get('/providers', googleSso.providers)
authRouter.get('/google', googleSso.start)
authRouter.get('/google/callback', googleSso.callback)
authRouter.get('/google/signup/:code', googleSso.signupProfile)
authRouter.post('/google/exchange', validate(SsoExchangeSchema), googleSso.exchange)
authRouter.post('/google/id-token', validate(GoogleIdTokenSchema), googleSso.idToken)
