import { Request } from 'express'

// The visitor's address for rate limits. On Render every request arrives through Render's edge (Cloudflare), so the
// socket address is a shared proxy: Cloudflare's CF-Connecting-IP (it overwrites any client-sent value) is the real
// client. Elsewhere `trust proxy` (TRUST_PROXY hops, default 1 in production) makes req.ip the address the nearest
// trusted proxy saw. Locally there's no proxy and req.ip is the socket address.
export function clientIp(req: Request): string {
  const cf = process.env.NODE_ENV === 'production' ? req.headers['cf-connecting-ip'] : undefined
  return (typeof cf === 'string' && cf) || req.ip || 'unknown'
}
