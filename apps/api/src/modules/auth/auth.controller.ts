import { Request, Response } from 'express'
import { authService } from './auth.service'
import { asyncHandler } from '../../shared/utils/asyncHandler'

export const authController = {
  login: asyncHandler(async (req: Request, res: Response) => {
    const { email, password, tenantSlug } = req.body
    const result = await authService.login({ email, password, tenantSlug })

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

  me: asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.user!
    const user = await authService.getMe(userId)

    res.status(200).json({
      success: true,
      data: user,
    })
  }),
}
