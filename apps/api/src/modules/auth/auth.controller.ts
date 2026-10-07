import { Request, Response } from 'express'
import { authService } from './auth.service'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { AppError } from '../../shared/utils/AppError'
import { redis } from '../../infrastructure/cache/redis'
import { companyService } from '../company/company.service'

export const authController = {
  login: asyncHandler(async (req: Request, res: Response) => {
    const { email, password, tenantSlug } = req.body
    const result = await authService.login({ email, password, tenantSlug }, req.ip)

    res.status(200).json({
      success: true,
      data: result,
    })
  }),

  refresh: asyncHandler(async (req: Request, res: Response) => {
    const { refreshToken } = req.body
    const tokens = await authService.refresh(refreshToken)

    res.status(200).json({
      success: true,
      data: tokens,
    })
  }),

  logout: asyncHandler(async (req: Request, res: Response) => {
    const { refreshToken } = req.body
    if (refreshToken) {
      await authService.logout(refreshToken)
    }

    res.status(200).json({
      success: true,
      message: 'Logged out successfully',
    })
  }),

  mfaVerify: asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await authService.verifyMfaLogin(req.body.mfaToken, req.body.code) })
  }),

  signup: asyncHandler(async (req: Request, res: Response) => {
    // A handful of new companies per address per hour is plenty for real people
    const key = `signup:ip:${req.ip}`
    const n = await redis.incr(key)
    if (n === 1) await redis.expire(key, 3600)
    if (n > 5) throw new AppError('Too many sign-ups from this network. Try again later.', 429)
    res.status(201).json({ success: true, data: await companyService.signup(req.body) })
  }),

  changePassword: asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await authService.changePassword(req.user!.userId, req.body.currentPassword, req.body.newPassword) })
  }),

  workspace: asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await authService.workspaceBranding(String(req.params.slug)) })
  }),

  setTour: asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await authService.setTour(req.user!.userId, req.body.status) })
  }),

  mfaSetup: asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await authService.mfaSetup(req.user!.userId) })
  }),

  mfaEnable: asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await authService.mfaEnable(req.user!.userId, req.body.code) })
  }),

  mfaDisable: asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await authService.mfaDisable(req.user!.userId, req.body.code) })
  }),

  me: asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.user!
    const user = await authService.getMe(userId)

    res.status(200).json({
      success: true,
      data: user,
    })
  }),
}
