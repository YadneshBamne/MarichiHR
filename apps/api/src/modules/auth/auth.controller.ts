import { Request, Response } from 'express'
import { authService } from './auth.service'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { AppError } from '../../shared/utils/AppError'
import { redis } from '../../infrastructure/cache/redis'
import { companyService } from '../company/company.service'
import { clientIp } from '../../shared/utils/clientIp'

const SIGNUPS_PER_IP = 10
const SIGNUPS_PER_EMAIL = 3

export const authController = {
  login: asyncHandler(async (req: Request, res: Response) => {
    const { email, password, tenantSlug } = req.body
    const result = await authService.login({ email, password, tenantSlug }, clientIp(req))

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

  // Abuse limits count workspaces actually created (a failed or retried attempt costs nothing): 10 per visitor IP and
  // 3 per email per hour. A Google sign-up's email isn't in the body, so it is limited by IP only.
  signup: asyncHandler(async (req: Request, res: Response) => {
    const ipKey = `signup:ip:${clientIp(req)}`
    const emailKey = req.body.email ? `signup:email:${String(req.body.email).toLowerCase()}` : null
    const [byIp, byEmail] = await Promise.all([redis.get(ipKey), emailKey ? redis.get(emailKey) : null])
    if (Number(byIp) >= SIGNUPS_PER_IP) throw new AppError('Too many new workspaces from this network. Try again in an hour.', 429)
    if (Number(byEmail) >= SIGNUPS_PER_EMAIL) throw new AppError('Too many new workspaces for this email. Try again in an hour.', 429)
    const result = await companyService.signup(req.body)
    await Promise.all([ipKey, emailKey].filter((k): k is string => !!k).map(async (k) => { if ((await redis.incr(k)) === 1) await redis.expire(k, 3600) }))
    res.status(201).json({ success: true, data: result })
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
