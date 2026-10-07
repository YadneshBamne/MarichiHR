import crypto from 'crypto'

// RFC 6238 TOTP (HMAC-SHA1, 30 s steps, 6 digits), the variant every authenticator app supports
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const STEP_SECONDS = 30

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, '').replace(/\s/g, '')
  let bits = 0, value = 0
  const out: number[] = []
  for (const ch of clean) {
    const i = B32.indexOf(ch)
    if (i < 0) throw new Error('Invalid base32')
    value = (value << 5) | i
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

export const generateTotpSecret = () => base32Encode(crypto.randomBytes(20))
export const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP_SECONDS)

export function totpAt(secretB32: string, step: number): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const h = crypto.createHmac('sha1', base32Decode(secretB32)).update(counter).digest()
  const off = h[h.length - 1] & 0xf
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3]
  return String(bin % 1_000_000).padStart(6, '0')
}

// Accepts the current step ±1 (clock drift). Returns the matched step, or null. A step at or before lastStep is a replay.
export function verifyTotp(secretB32: string, code: string, lastStep?: number | null, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null
  const step = currentStep(now)
  for (const s of [step - 1, step, step + 1]) {
    if (lastStep != null && s <= lastStep) continue
    const expected = totpAt(secretB32, s)
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(code))) return s
  }
  return null
}

export function otpauthUrl(secretB32: string, account: string, issuer = 'MarichiHR') {
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`
}
