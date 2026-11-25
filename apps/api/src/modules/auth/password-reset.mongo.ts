import { Router } from 'express'
import crypto from 'crypto'
import bcrypt from 'bcryptjs'
import mongoose from 'mongoose'
import { z } from 'zod'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { AppError } from '../../shared/utils/AppError'
import { redis, soft } from '../../infrastructure/cache/redis'
import { emailTransport, type OutboundMessage } from '../../infrastructure/notifications/notify'
import { User, Tenant, Employee, RefreshToken, AuditLog } from '../../infrastructure/mongo/mongo'
import { strongPassword, PASSWORD_RULE } from './auth.mongo'

// Forgot password and the welcome emails, MongoDB API only.
// A link carries a random token; only its SHA-256 hash is stored (collection password_resets), it works once, and it expires
// (1 hour for "forgot password", 7 days for a welcome link). Asking for a reset never says whether the email has an account.
const col = () => mongoose.connection.collection('password_resets')
const sha = (t: string) => crypto.createHash('sha256').update(t).digest('hex')
const HOUR = 3_600_000
const CI = { locale: 'en', strength: 2 } as const
const base = () => (process.env.APP_URL || process.env.CLIENT_URL || '').replace(/\/$/, '')

// Mail goes out through the same transport as notifications (EMAIL_TRANSPORT); tests swap it
let mailer: (m: OutboundMessage) => Promise<void> = (m) => emailTransport().send(m)
export const setMailer = (f: typeof mailer) => { mailer = f }
const mail = (m: OutboundMessage) => mailer(m).catch((e) => console.warn('[mail] not sent:', e?.message))

let indexed = false
async function ready() {
  if (indexed) return
  await Promise.all([col().createIndex({ tokenHash: 1 }, { unique: true }), col().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 86_400 }), col().createIndex({ userId: 1, purpose: 1 })])
  indexed = true
}

async function makeToken(userId: string, tenantId: string, purpose: 'reset' | 'welcome', ttlMs: number) {
  await ready()
  const token = crypto.randomBytes(32).toString('base64url')
  // only the newest link of a kind works
  await col().updateMany({ userId, purpose, usedAt: null } as any, { $set: { usedAt: new Date() } })
  await col().insertOne({ _id: crypto.randomUUID(), userId, tenantId, purpose, tokenHash: sha(token), expiresAt: new Date(Date.now() + ttlMs), usedAt: null, createdAt: new Date() } as any)
  return token
}

// A person who left keeps no login (except the alumni portal); a user HR never gave a password to cannot get one by asking
async function canReset(u: any) {
  if (!u.active || !u.passwordHash) return false
  const t: any = await Tenant.findOne({ _id: u.tenantId, active: true }).select('_id').lean()
  if (!t) return false
  const emp: any = await Employee.findOne({ userId: u._id }).select('employmentStatus').lean()
  const alumniOnly = (u.userRoles ?? []).length > 0 && (u.userRoles ?? []).every((r: any) => r.roleName === 'alumni')
  return !(emp?.employmentStatus === 'terminated' && !alumniOnly)
}

export async function sendResetEmail(email: string, tenantSlug?: string) {
  let users: any[] = await User.find({ email }).collation(CI).limit(3).lean()
  if (tenantSlug) {
    const t: any = await Tenant.findOne({ slug: tenantSlug.toLowerCase() }).select('_id').lean()
    users = t ? users.filter((u) => u.tenantId === t._id) : []
  }
  for (const u of users) {
    if (!(await canReset(u))) continue
    const tenant: any = await Tenant.findById(u.tenantId).select('name').lean()
    const token = await makeToken(u._id, u.tenantId, 'reset', HOUR)
    await mail({
      to: { name: u.fullName, email: u.email }, type: 'auth.reset', link: `/reset-password?token=${token}`,
      subject: 'Reset your MarichiHR password',
      text: `Someone asked to reset the password for ${u.email} at ${tenant?.name ?? 'your company'}.\nThe button below works once and for one hour. If it was not you, ignore this email: your password stays as it is.`,
      button: 'Choose a new password', footer: 'You got this email because a password reset was asked for this address on MarichiHR.',
    })
  }
}

// Welcome emails. 'invite': HR has given this person a login (they choose their password from the link; a temporary password from HR still works).
// 'owner': the person who just created the workspace.
export async function sendWelcomeEmail(userId: string, kind: 'invite' | 'owner') {
  try {
    const u: any = await User.findById(userId).lean()
    if (!u?.email) return
    const tenant: any = await Tenant.findById(u.tenantId).select('name').lean()
    const company = tenant?.name ?? 'your company'
    if (kind === 'owner') {
      await mail({
        to: { name: u.fullName, email: u.email }, type: 'auth.welcome', link: '/onboarding', button: 'Finish setting up',
        subject: `Your ${company} workspace is ready`,
        text: `You can sign in with ${u.email}. Next, choose your apps, add your company profile and invite your first people.`,
        footer: 'You got this email because you created a workspace on MarichiHR.',
      })
      return
    }
    const token = await makeToken(u._id, u.tenantId, 'welcome', 7 * 24 * HOUR)
    await mail({
      to: { name: u.fullName, email: u.email }, type: 'auth.welcome', link: `/reset-password?token=${token}&welcome=1`, button: 'Choose your password',
      subject: `Welcome to ${company} on MarichiHR`,
      text: `${company} has set up your MarichiHR login. Your sign-in email is ${u.email}.\nUse the button to choose your password (the link works once, for 7 days). If your administrator gave you a temporary password, you can use that instead.`,
      footer: 'You got this email because your company added you to MarichiHR.',
    })
  } catch (e: any) { console.warn('[welcome] not sent:', e?.message) }
}

async function limited(key: string, max: number, ttl: number) {
  const n = Number(await soft(async () => { const c = await redis.incr(key); if (c === 1) await redis.expire(key, ttl); return c }, 0)) || 0
  return n > max
}

export const passwordResetRouter = Router()

passwordResetRouter.post('/forgot-password', validate(z.object({ body: z.object({ email: z.string().trim().toLowerCase().email().max(200), tenantSlug: z.string().trim().max(60).optional() }).strict() })), asyncHandler(async (req, res) => {
  const email = req.body.email as string
  if (await limited(`reset:ip:${req.ip}`, 20, 3600) || await limited(`reset:email:${email}`, 3, 3600)) throw new AppError('Too many reset requests. Try again in an hour.', 429)
  // answer first, work after: the reply and its timing never show whether the email has an account
  res.json({ success: true, data: { sent: true } })
  void sendResetEmail(email, req.body.tenantSlug).catch((e) => console.warn('[reset] failed:', e?.message))
}))

const find = (token: string) => col().findOne({ tokenHash: sha(token), usedAt: null, expiresAt: { $gt: new Date() } } as any)
const Token = z.string().min(20).max(100)

passwordResetRouter.post('/reset-password/check', validate(z.object({ body: z.object({ token: Token }).strict() })), asyncHandler(async (req, res) => {
  const t: any = await find(req.body.token)
  if (!t) throw new AppError('This link has expired or was already used. Ask for a new one.', 400, 'RESET_LINK_INVALID')
  const u: any = await User.findById(t.userId).select('email fullName').lean()
  const tenant: any = await Tenant.findById(t.tenantId).select('name').lean()
  res.json({ success: true, data: { email: u?.email, name: u?.fullName, company: tenant?.name, welcome: t.purpose === 'welcome' } })
}))

passwordResetRouter.post('/reset-password', validate(z.object({ body: z.object({ token: Token, newPassword: z.string().min(1).max(200) }).strict() })), asyncHandler(async (req, res) => {
  if (!strongPassword(req.body.newPassword)) throw new AppError(PASSWORD_RULE, 400)
  if (await limited(`reset:try:${req.ip}`, 30, 3600)) throw new AppError('Too many attempts. Try again in an hour.', 429)
  // single use: claiming the token and checking it is one atomic step
  const claimed: any = await col().findOneAndUpdate({ tokenHash: sha(req.body.token), usedAt: null, expiresAt: { $gt: new Date() } } as any, { $set: { usedAt: new Date() } }, { returnDocument: 'before' })
  const t = claimed && 'value' in claimed ? claimed.value : claimed // the driver returns the document itself (v6) or { value } (older)
  if (!t) throw new AppError('This link has expired or was already used. Ask for a new one.', 400, 'RESET_LINK_INVALID')
  const u: any = await User.findOne({ _id: t.userId, active: true }).lean()
  if (!u) throw new AppError('This account cannot be reset. Ask your administrator.', 400)
  await User.updateOne({ _id: u._id }, { $set: { passwordHash: await bcrypt.hash(req.body.newPassword, 12), mustChangePassword: false } })
  await RefreshToken.updateMany({ userId: u._id, revokedAt: null }, { revokedAt: new Date() })
  await col().updateMany({ userId: u._id, usedAt: null } as any, { $set: { usedAt: new Date() } })
  await AuditLog.create({ tenantId: u.tenantId, userId: u._id, action: t.purpose === 'welcome' ? 'PASSWORD_SET_FROM_WELCOME' : 'PASSWORD_RESET', entityType: 'user', entityId: u._id })
  res.json({ success: true, data: { done: true } })
}))
