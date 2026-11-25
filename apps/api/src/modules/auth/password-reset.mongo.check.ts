// Check: node -r dotenv/config -r ts-node/register/transpile-only src/modules/auth/password-reset.mongo.check.ts
// Runs the reset router in-process with a capturing mailer (no email is sent); creates a workspace and removes it again.
import express from 'express'
import bcrypt from 'bcryptjs'
import mongoose from 'mongoose'
import { connectMongo, syncMongoIndexes, Tenant, User, RefreshToken } from '../../infrastructure/mongo/mongo'
import { redis } from '../../infrastructure/cache/redis'
import { errorMiddleware } from '../../middleware/error.middleware'
import { bootstrapCompany } from '../company/company.bootstrap.mongo'
import { authService } from './auth.mongo'
import { passwordResetRouter, setMailer, sendWelcomeEmail } from './password-reset.mongo'

;(async () => {
  await connectMongo(); await syncMongoIndexes()
  const sent: any[] = []
  setMailer(async (m) => { sent.push(m) })
  const app = express(); app.use(express.json()); app.use('/auth', passwordResetRouter); app.use(errorMiddleware)
  const server = app.listen(0); const port = (server.address() as any).port
  const post = async (p: string, body: any) => { const r = await fetch(`http://localhost:${port}/auth${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) } as any }
  const tokenOf = (m: any) => new URL(m.link, 'http://x').searchParams.get('token')!
  const slug = `rstcheck-${Date.now()}`, email = `${slug}@example.com`, pw = 'Correct-horse-1'
  const { tenantId, userId } = await bootstrapCompany({ companyName: 'Reset Check Ltd', slug, email, fullName: 'Reset Check', passwordHash: await bcrypt.hash(pw, 4) })
  const keys = [`reset:email:${email}`]
  try {
    let r = await post('/forgot-password', { email })
    console.assert(r.status === 200 && r.body.data.sent, 'forgot-password answers 200')
    r = await post('/forgot-password', { email: `nobody-${slug}@example.com` })
    console.assert(r.status === 200 && r.body.data.sent, 'an unknown email gets the same answer')
    await new Promise((x) => setTimeout(x, 800))
    console.assert(sent.length === 1 && sent[0].to.email === email, 'only the real account gets a mail')
    const t1 = tokenOf(sent[0])
    console.assert(sent[0].button && sent[0].subject.includes('Reset'), 'mail has a subject and button')
    console.assert((await post('/reset-password/check', { token: t1 })).body.data.email === email, 'check shows whose link it is')
    console.assert((await post('/reset-password', { token: t1, newPassword: 'short' })).status === 400, 'weak password refused')
    const old = await authService.login({ email, password: pw, tenantSlug: slug }, 'check') as any
    r = await post('/reset-password', { token: t1, newPassword: 'Brand-new-pass-9' })
    console.assert(r.status === 200, 'reset works')
    console.assert((await post('/reset-password', { token: t1, newPassword: 'Another-pass-99' })).status === 400, 'the link works once')
    console.assert((await authService.login({ email, password: 'Brand-new-pass-9', tenantSlug: slug }, 'check') as any).accessToken, 'new password signs in')
    const refused = await authService.login({ email, password: pw, tenantSlug: slug }, 'check').then(() => false, () => true)
    console.assert(refused, 'old password no longer works')
    console.assert(!!(await RefreshToken.findOne({ token: old.refreshToken }).lean() as any)?.revokedAt, 'old sessions are signed out')
    // a newer link replaces the older one
    await redis.del(keys[0])
    await post('/forgot-password', { email }); await new Promise((x) => setTimeout(x, 800))
    await post('/forgot-password', { email }); await new Promise((x) => setTimeout(x, 800))
    const [a, b] = [tokenOf(sent[sent.length - 2]), tokenOf(sent[sent.length - 1])]
    console.assert((await post('/reset-password/check', { token: a })).status === 400 && (await post('/reset-password/check', { token: b })).status === 200, 'only the newest link works')
    // expiry
    await mongoose.connection.collection('password_resets').updateMany({ userId } as any, { $set: { expiresAt: new Date(Date.now() - 1000) } })
    console.assert((await post('/reset-password/check', { token: b })).status === 400, 'an expired link is refused')
    // a user HR never gave a password cannot get one by asking
    await User.updateOne({ _id: userId }, { $set: { passwordHash: null } })
    const before = sent.length
    await redis.del(keys[0]); await post('/forgot-password', { email }); await new Promise((x) => setTimeout(x, 800))
    console.assert(sent.length === before, 'no mail for an account without a password')
    // welcome mails
    await sendWelcomeEmail(userId, 'owner')
    console.assert(sent[sent.length - 1].subject.includes('workspace is ready') && !sent[sent.length - 1].link.includes('token'), 'owner welcome has no token')
    await sendWelcomeEmail(userId, 'invite')
    const w = sent[sent.length - 1]
    console.assert(w.subject.startsWith('Welcome to Reset Check Ltd') && w.link.includes('welcome=1'), 'invite welcome carries a link')
    r = await post('/reset-password', { token: tokenOf(w), newPassword: 'Chosen-by-me-77' })
    console.assert(r.status === 200 && (await authService.login({ email, password: 'Chosen-by-me-77', tenantSlug: slug }, 'check') as any).accessToken, 'the welcome link lets the person choose a password')
    console.log('password reset check done')
  } finally {
    server.close()
    for (const c of ['roles', 'users', 'org_units', 'employees', 'audit_logs', 'leave_types', 'activity_types', 'expense_categories', 'payroll_input_types', 'shift_templates', 'resource_calendars', 'password_resets', 'leave_balances'])
      await mongoose.connection.collection(c).deleteMany({ tenantId } as any)
    await mongoose.connection.collection('password_resets').deleteMany({ userId } as any)
    await Tenant.deleteOne({ _id: tenantId }); await RefreshToken.deleteMany({ userId })
    await redis.del(...keys, `reset:ip:::1`, `reset:ip:::ffff:127.0.0.1`, `reset:ip:127.0.0.1`, `reset:try:::1`, `reset:try:::ffff:127.0.0.1`, `reset:try:127.0.0.1`).catch(() => {})
    await mongoose.disconnect(); redis.disconnect()
  }
})().catch((e) => { console.error(e); process.exit(1) })
