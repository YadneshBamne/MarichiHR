import mongoose from 'mongoose'

// When someone's access ends (their exit is paid, they are archived) their sign-in tokens must stop working at once, not when the 15-minute
// access token runs out. The moment is remembered per user (users.tokensValidFrom on MongoDB) and kept in memory for authenticate(), which
// checks it without any database call: a once-a-minute refresh picks up revocations made by another server instance.
const from = new Map<string, number>()
const WINDOW = 30 * 60_000 // longer than any access token lives
let timer: ReturnType<typeof setInterval> | null = null

export async function revokeUserAccess(userId: string, at = new Date()) {
  from.set(userId, at.getTime())
  if (process.env.DB_PROVIDER === 'mongo') {
    try { await mongoose.connection.collection('users').updateOne({ _id: userId } as any, { $set: { tokensValidFrom: at } }) } catch { /* the in-memory mark still protects this instance */ }
  }
}

// A token issued before the revocation (iat is in whole seconds) is refused; one issued in the same second stays valid
export const accessRevoked = (userId: string, issuedAtSeconds?: number) => {
  const t = from.get(userId)
  return !!t && !!issuedAtSeconds && issuedAtSeconds < Math.floor(t / 1000)
}

export function watchRevocations() {
  if (timer || process.env.DB_PROVIDER !== 'mongo') return
  const sync = async () => {
    try {
      const rows: any[] = await mongoose.connection.collection('users').find({ tokensValidFrom: { $gt: new Date(Date.now() - WINDOW) } } as any, { projection: { tokensValidFrom: 1 } }).toArray()
      rows.forEach((r) => from.set(String(r._id), +new Date(r.tokensValidFrom)))
    } catch { /* try again next minute */ }
    for (const [k, v] of from) if (v < Date.now() - WINDOW) from.delete(k)
  }
  void sync()
  timer = setInterval(sync, 60_000)
  timer.unref()
}

// Self-check: node -r ts-node/register/transpile-only src/infrastructure/auth/revoke.ts
if (require.main === module) {
  ;(async () => {
    console.assert(!accessRevoked('u1', 1000), 'nobody is revoked at first')
    await revokeUserAccess('u1', new Date(5_000_000))
    console.assert(accessRevoked('u1', 4999), 'a token from before is refused')
    console.assert(!accessRevoked('u1', 5000), 'a token from the same second stays valid')
    console.assert(!accessRevoked('u1', 5001), 'a later token is fine')
    console.assert(!accessRevoked('u2', 1), 'other people are untouched')
    console.log('revoke check done')
  })()
}
