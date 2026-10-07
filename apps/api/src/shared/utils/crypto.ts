import crypto from 'crypto'

const PREFIX = 'v1:'
const IV_LEN = 12
const TAG_LEN = 16

function getKey(): Buffer {
  const hex = process.env.BANK_ENCRYPTION_KEY
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('BANK_ENCRYPTION_KEY is missing or invalid: it must be 64 hex characters (32 bytes)')
  }
  return Buffer.from(hex, 'hex')
}

export function encryptField(plain: string): string {
  const key = getKey()
  const iv = crypto.randomBytes(IV_LEN)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return PREFIX + Buffer.concat([iv, tag, ciphertext]).toString('base64')
}

export function decryptField(stored: string): string {
  if (typeof stored !== 'string' || !stored.startsWith(PREFIX)) {
    throw new Error('Cannot decrypt: value is not in the expected encrypted format')
  }
  const key = getKey()
  const raw = Buffer.from(stored.slice(PREFIX.length), 'base64')
  if (raw.length < IV_LEN + TAG_LEN + 1) throw new Error('Cannot decrypt: encrypted value is truncated')
  const iv = raw.subarray(0, IV_LEN)
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN)
  const ciphertext = raw.subarray(IV_LEN + TAG_LEN)
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch {
    throw new Error('Cannot decrypt: data was tampered with or the encryption key is wrong')
  }
}

export function last4(plain: string): string {
  return plain.slice(-4)
}
