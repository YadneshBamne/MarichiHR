import { Request } from 'express'
import { soft } from '../../infrastructure/cache/redis'
import { clientIp } from './clientIp'
import { AuditLog } from '../../infrastructure/mongo/mongo'

// MongoDB version of auditSignIn: a completed sign-in with where it came from. Never blocks the sign-in.
export async function auditSignIn(req: Request, data: any, method: 'password' | 'mfa' | 'google') {
  if (!data?.accessToken || !data.user?.id || !data.user.tenant?.id) return
  await soft(() => AuditLog.create({
    tenantId: data.user.tenant.id, userId: data.user.id, action: 'SIGNED_IN', entityType: 'user', entityId: data.user.id,
    newValue: { method }, ipAddress: clientIp(req), userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300) || null,
  }), null, 3000)
}
