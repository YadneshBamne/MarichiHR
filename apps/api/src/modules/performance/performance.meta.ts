import crypto from 'crypto'

// Extras of a goal that the shared Postgres schema has no columns for (MongoDB API only, collection performance_goal_meta, one row per goal):
// the deadline, the person's progress updates and a short history of what happened (withdrawn, reopened). Everywhere else these are no-ops,
// so the Postgres API keeps type-checking and behaving as before.
export type GoalMeta = { deadline: string | null; progress: number | null; progressLog: { percent: number; note: string | null; at: Date }[]; history: { action: string; by: string; reason: string | null; at: Date }[]; remindedOn: Record<string, string> }
const on = () => process.env.DB_PROVIDER === 'mongo'
const col = () => (require('mongoose') as typeof import('mongoose')).connection.collection('performance_goal_meta')
const empty = (): GoalMeta => ({ deadline: null, progress: null, progressLog: [], history: [], remindedOn: {} })

export async function metaFor(goalIds: string[]): Promise<Map<string, GoalMeta>> {
  const out = new Map<string, GoalMeta>()
  if (!on() || !goalIds.length) return out
  try {
    for (const r of await col().find({ _id: { $in: goalIds } } as any).toArray()) out.set(String(r._id), { ...empty(), ...(r as any) })
  } catch { /* extras are optional */ }
  return out
}
export async function setDeadline(tenantId: string, goalId: string, deadline: string | null) {
  if (!on()) return
  await col().updateOne({ _id: goalId } as any, { $set: { tenantId, deadline }, $setOnInsert: { createdAt: new Date() } }, { upsert: true })
}
export async function addProgress(tenantId: string, goalId: string, percent: number, note: string | null) {
  await col().updateOne({ _id: goalId } as any, { $set: { tenantId, progress: percent }, $push: { progressLog: { $each: [{ percent, note, at: new Date() }], $slice: -50 } } as any, $setOnInsert: { createdAt: new Date() } }, { upsert: true })
}
export async function addHistory(tenantId: string, goalId: string, action: string, by: string, reason: string | null) {
  if (!on()) return
  await col().updateOne({ _id: goalId } as any, { $set: { tenantId }, $push: { history: { $each: [{ action, by, reason, at: new Date() }], $slice: -50 } } as any, $setOnInsert: { createdAt: new Date() } }, { upsert: true })
}
// Reminders: true the first time a (goal, kind, day) is claimed, false after, so a job that runs twice a day nudges once
export async function claimReminder(tenantId: string, goalId: string, kind: string, day: string) {
  const r = await col().updateOne({ _id: goalId, [`remindedOn.${kind}`]: { $ne: day } } as any, { $set: { tenantId, [`remindedOn.${kind}`]: day }, $setOnInsert: { createdAt: new Date() } }, { upsert: true }).catch((e: any) => { if (e?.code === 11000) return null; throw e })
  return !!r && (r.modifiedCount > 0 || r.upsertedCount > 0)
}
export const newId = () => crypto.randomUUID()

// Self-check: node -r dotenv/config -r ts-node/register/transpile-only src/modules/performance/performance.meta.ts
if (require.main === module) {
  console.assert(!on(), 'extras are off outside MongoDB mode')
  console.log('goal meta check done')
}
