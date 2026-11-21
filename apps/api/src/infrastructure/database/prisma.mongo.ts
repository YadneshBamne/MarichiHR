import crypto from 'crypto'
import mongoose from 'mongoose'
import { Prisma } from '@prisma/client'
import { AppError } from '../../shared/utils/AppError'
import { ALL_MODELS } from '../mongo/mongo'

// A Prisma-compatible client on MongoDB. The Postgres services (leave, attendance, ...) keep calling `prisma.<model>.<method>(...)`
// with the same arguments and get the same shapes back; this file turns those calls into MongoDB operations. It reads the model
// list, field types, relations, defaults and unique keys from Prisma's own schema metadata, so there is no second schema to keep in step.
// Collections are the old table names, ids are UUID strings stored as _id (same as the hand-written Mongo ports, which share them).
//
// Supported: find*/count/aggregate/groupBy, create/createMany/update/updateMany/upsert/delete/deleteMany, where (scalar operators,
// AND/OR/NOT, relation filters is/isNot/some/none/every), include/select (nested, _count), orderBy (scalar fields), increment/decrement,
// connect and nested create, and $transaction (array or function, on a MongoDB session).
// Not supported (throws, never guesses): raw SQL, relation orderBy, many-to-many implicit relations, divide.
// Only models listed in ENABLED are served; every other model still answers 501 until its module has been tested here.

const dm: any = (Prisma as any).dmmf.datamodel
type F = { name: string; kind: string; type: string; isList: boolean; isRequired: boolean; isId: boolean; hasDefaultValue: boolean; default?: any; relationName?: string; relationFromFields?: string[]; relationToFields?: string[]; isUpdatedAt?: boolean }
type M = { name: string; coll: string; fields: Map<string, F>; scalars: F[]; relations: F[]; uniques: string[][] }
const MODELS = new Map<string, M>()
const BY_DELEGATE = new Map<string, M>()
for (const m of dm.models) {
  const fields = new Map<string, F>(m.fields.map((f: F) => [f.name, f]))
  const uniques: string[][] = [...(m.primaryKey?.fields ? [m.primaryKey.fields] : []), ...(m.uniqueFields ?? []), ...(m.uniqueIndexes ?? []).map((u: any) => u.fields)]
  for (const f of m.fields) if ((f as any).isUnique && f.kind !== 'object') uniques.push([f.name])
  const mm: M = { name: m.name, coll: m.dbName ?? m.name, fields, scalars: m.fields.filter((f: F) => f.kind !== 'object'), relations: m.fields.filter((f: F) => f.kind === 'object'), uniques }
  MODELS.set(m.name, mm)
  BY_DELEGATE.set(m.name[0].toLowerCase() + m.name.slice(1), mm)
}

// Models whose module has been tested on MongoDB. Add a model here when its module's flow test passes.
export const ENABLED = new Set<string>([
  'leaveType', 'leaveBalance', 'leaveRequest', 'leaveApproval', 'leaveAllocation', 'leaveAllocationRequest', 'leaveBlackout', 'leaveYearEndRun',
  'attendanceRecord', 'attendanceRegularisation', 'attendanceAdjustment', 'attendancePolicy', 'overtimeRequest', 'rosterDay', 'shiftTemplate', 'employeeShift',
  'holiday', 'holidayCalendar', 'workLocation',
  'employee', 'orgUnit', 'tenant', 'auditLog', 'notification', 'domainEvent', 'employeeDocument', 'employeeContract', 'activity', 'activityType', 'payrollCycle', 'user', 'approvalChain', 'approvalStep', 'approvalDelegation', 'pushSubscription', 'chatterMessage', 'reimbursementClaim', 'expenseRequest', 'expenseCategory', 'perDiemRate', 'fxRate', 'employeeExit', 'exitClearance', 'payslip', 'payrollInputType', 'masterValue', 'contractStateTransition', 'refreshToken', 'candidate', 'interview', 'jobOpening', 'jobPosition', 'performanceGoal', 'performanceCycle', 'performanceKpi', 'webhook', 'webhookDelivery', 'automationRule', 'automationRun', 'apiKey',
])

const col = (m: M) => mongoose.connection.collection(m.coll)
const key = (n: string) => (n === 'id' ? '_id' : n)
const arr = (v: any) => (Array.isArray(v) ? v : [v])
const isPlain = (v: any) => v !== null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) && !Buffer.isBuffer(v) && typeof v.toNumber !== 'function'
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const dec = (v: any) => (v && typeof v.toNumber === 'function' ? v.toNumber() : v)

function known(code: string, message: string, meta?: any) {
  return new (Prisma as any).PrismaClientKnownRequestError(message, { code, clientVersion: (Prisma as any).prismaVersion?.client ?? '5', meta })
}
const notAvailable = (what: string) => new AppError(`${what} is not available on the MongoDB version yet`, 501, 'NOT_AVAILABLE_ON_MONGO')

function coerce(f: F, v: any): any {
  if (v === undefined || v === null) return v ?? null
  if (f.isList) return arr(v).map((x) => coerce({ ...f, isList: false }, x))
  if (f.type === 'DateTime') return v instanceof Date ? v : new Date(v)
  if (f.type === 'Decimal' || f.type === 'Float' || f.type === 'Int' || f.type === 'BigInt') return typeof v === 'bigint' ? Number(v) : Number(dec(v))
  return v
}

// ── where → MongoDB filter (async: relation filters become sub-queries)
async function relOpposite(m: M, f: F): Promise<{ r: M; fk: string; ref: string } | null> {
  const r = MODELS.get(f.type)!
  const o = r.relations.find((x) => x.relationName === f.relationName && (x.name !== f.name || r !== m))
  if (!o?.relationFromFields?.length) return null
  return { r, fk: o.relationFromFields[0], ref: key(o.relationToFields![0]) }
}
async function relationCond(m: M, f: F, v: any, session?: any): Promise<any> {
  const r = MODELS.get(f.type)!
  if (f.relationFromFields?.length) { // this model holds the foreign key
    const fk = f.relationFromFields[0], to = key(f.relationToFields![0])
    if (v === null || (isPlain(v) && 'is' in v && v.is === null)) return { [fk]: null }
    const neg = isPlain(v) && 'isNot' in v
    const where = isPlain(v) && ('is' in v || 'isNot' in v) ? (v.is ?? v.isNot) : v
    if (neg && where === null) return { [fk]: { $ne: null } }
    const ids = await col(r).distinct(to, await buildWhere(r, where, session))
    return { [fk]: neg ? { $nin: ids } : { $in: ids } }
  }
  const o = await relOpposite(m, f)
  if (!o) throw notAvailable(`Filtering ${m.name}.${f.name}`)
  const mine = '_id' // relationToFields is the id on every relation in this schema
  if (!isPlain(v) || !(['some', 'none', 'every', 'is', 'isNot'].some((k) => k in v))) { const ids = await col(o.r).distinct(o.fk, await buildWhere(o.r, v, session)); return { [mine]: { $in: ids } } }
  const and: any[] = []
  if ('some' in v) and.push({ [mine]: { $in: await col(o.r).distinct(o.fk, await buildWhere(o.r, v.some, session)) } })
  if ('is' in v) and.push(v.is === null ? { [mine]: { $nin: await col(o.r).distinct(o.fk, {}) } } : { [mine]: { $in: await col(o.r).distinct(o.fk, await buildWhere(o.r, v.is, session)) } })
  if ('isNot' in v) and.push({ [mine]: { $nin: await col(o.r).distinct(o.fk, await buildWhere(o.r, v.isNot, session)) } })
  if ('none' in v) and.push({ [mine]: { $nin: await col(o.r).distinct(o.fk, await buildWhere(o.r, v.none, session)) } })
  if ('every' in v) and.push({ [mine]: { $nin: await col(o.r).distinct(o.fk, { $nor: [await buildWhere(o.r, v.every, session)] }) } })
  return and.length === 1 ? and[0] : { $and: and }
}
function opCond(f: F, ops: any): any {
  const out: any = {}
  const ci = ops.mode === 'insensitive' ? 'i' : ''
  for (const [op, raw] of Object.entries(ops)) {
    if (raw === undefined || op === 'mode') continue
    const v = coerce({ ...f, isList: op === 'in' || op === 'notIn' || op === 'hasSome' || op === 'hasEvery' }, raw)
    if (op === 'equals') out.$eq = v
    else if (op === 'not') { if (isPlain(raw)) out.$not = opCond(f, raw); else out.$ne = v }
    else if (op === 'in') out.$in = v
    else if (op === 'notIn') out.$nin = v
    else if (op === 'lt') out.$lt = v
    else if (op === 'lte') out.$lte = v
    else if (op === 'gt') out.$gt = v
    else if (op === 'gte') out.$gte = v
    else if (op === 'contains') out.$regex = new RegExp(esc(String(v)), ci)
    else if (op === 'startsWith') out.$regex = new RegExp(`^${esc(String(v))}`, ci)
    else if (op === 'endsWith') out.$regex = new RegExp(`${esc(String(v))}$`, ci)
    else if (op === 'has') out.$eq = coerce({ ...f, isList: false }, raw)
    else if (op === 'hasSome') out.$in = v
    else if (op === 'hasEvery') out.$all = v
    else if (op === 'isEmpty') out.$size = 0
    else throw notAvailable(`The "${op}" filter`)
  }
  return out
}
function scalarCond(f: F, v: any) {
  if (v === null) return { [key(f.name)]: null }
  if (f.type !== 'Json' && isPlain(v)) {
    const c = opCond(f, v)
    return { [key(f.name)]: c.$eq !== undefined && Object.keys(c).length === 1 ? c.$eq : c }
  }
  return { [key(f.name)]: coerce(f, v) }
}
async function buildWhere(m: M, w: any, session?: any): Promise<any> {
  if (!w) return {}
  const and: any[] = []
  for (const [k, v] of Object.entries<any>(w)) {
    if (v === undefined) continue
    if (k === 'AND') for (const x of arr(v)) and.push(await buildWhere(m, x, session))
    else if (k === 'OR') { const p = []; for (const x of arr(v)) p.push(await buildWhere(m, x, session)); and.push(p.length ? { $or: p } : { _id: { $in: [] } }) }
    else if (k === 'NOT') { const p = []; for (const x of arr(v)) p.push(await buildWhere(m, x, session)); and.push({ $nor: p }) }
    else {
      const f = m.fields.get(k)
      if (!f) {
        const uq = m.uniques.find((u) => u.join('_') === k) // compound unique: { employeeId_date: { employeeId, date } }
        if (!uq) throw new Error(`Unknown field ${m.name}.${k}`)
        for (const n of uq) and.push(scalarCond(m.fields.get(n)!, v[n]))
      } else if (f.kind === 'object') and.push(await relationCond(m, f, v, session))
      else and.push(scalarCond(f, v))
    }
  }
  return and.length === 0 ? {} : and.length === 1 ? and[0] : { $and: and }
}

// ── results: documents → Prisma-shaped objects with include/select
const plain = (m: M, d: any) => { const o: any = {}; for (const f of m.scalars) { const v = f.name === 'id' ? d._id : d[f.name]; o[f.name] = v === undefined ? (f.isList ? [] : null) : v } return o }
const sortOf = (orderBy: any) => {
  const s: any = {}
  for (const o of arr(orderBy ?? [])) for (const [k, v] of Object.entries<any>(o)) { const dir = typeof v === 'string' ? v : v?.sort; if (typeof v === 'object' && v && !('sort' in v)) throw notAvailable('Ordering by a relation'); s[key(k)] = dir === 'desc' ? -1 : 1 }
  s._id = s._id ?? 1
  return s
}
async function loadRelation(m: M, f: F, spec: any, raws: any[], session?: any): Promise<Map<string, any>> {
  const r = MODELS.get(f.type)!
  const sp = spec === true ? {} : spec
  const out = new Map<string, any>()
  if (f.relationFromFields?.length) { // many-to-one: the foreign key is on the parent
    const from = f.relationFromFields[0], to = key(f.relationToFields![0])
    const vals = [...new Set(raws.map((d) => d[key(from)]).filter((x) => x != null))]
    const docs = vals.length ? await col(r).find({ [to]: { $in: vals } }, { session }).toArray() : []
    const shaped = await shape(r, docs, sp, session)
    docs.forEach((d, i) => out.set(String(d[to]), shaped[i]))
    for (const d of raws) out.set(`p:${d._id}`, out.get(String(d[key(from)])) ?? null)
    return out
  }
  if (f.isList && raws.some((d) => Array.isArray(d[f.name]))) { // children stored inside the parent (embedded)
    for (const d of raws) out.set(`p:${d._id}`, await shape(r, (d[f.name] ?? []).map((c: any) => ({ _id: c._id ?? c.id, ...c })), sp, session))
    return out
  }
  const o = await relOpposite(m, f)
  if (!o) throw notAvailable(`Including ${m.name}.${f.name}`)
  const ids = raws.map((d) => d._id)
  const filter: any = { $and: [{ [o.fk]: { $in: ids } }, await buildWhere(r, sp.where, session)] }
  let cur = col(r).find(filter, { session })
  cur = cur.sort(sortOf(sp.orderBy))
  const docs = await cur.toArray()
  const shaped = await shape(r, docs, sp, session)
  const groups = new Map<string, any[]>()
  docs.forEach((d, i) => { const g = groups.get(String(d[o.fk])) ?? []; g.push(shaped[i]); groups.set(String(d[o.fk]), g) })
  for (const d of raws) {
    let list = groups.get(String(d._id)) ?? []
    if (sp.skip) list = list.slice(sp.skip)
    if (sp.take != null) list = list.slice(0, sp.take)
    out.set(`p:${d._id}`, f.isList ? list : (list[0] ?? null))
  }
  return out
}
async function countRelation(m: M, f: F, where: any, raws: any[], session?: any): Promise<Map<string, number>> {
  const o = await relOpposite(m, f)
  if (!o) throw notAvailable(`Counting ${m.name}.${f.name}`)
  const rows = await col(o.r).aggregate([{ $match: { $and: [{ [o.fk]: { $in: raws.map((d) => d._id) } }, await buildWhere(o.r, where, session)] } }, { $group: { _id: `$${o.fk}`, n: { $sum: 1 } } }], { session }).toArray()
  return new Map(rows.map((x: any) => [String(x._id), x.n]))
}
async function shape(m: M, docs: any[], args: any = {}, session?: any): Promise<any[]> {
  if (!docs.length) return []
  const sel = args.select, inc = args.include
  const rels: Record<string, any> = {}
  if (sel) for (const [k, v] of Object.entries<any>(sel)) { if (m.fields.get(k)?.kind === 'object' && v) rels[k] = v }
  if (inc) for (const [k, v] of Object.entries<any>(inc)) { if (m.fields.get(k)?.kind === 'object' && v) rels[k] = v }
  const loaded: Record<string, Map<string, any>> = {}
  for (const [k, v] of Object.entries(rels)) loaded[k] = await loadRelation(m, m.fields.get(k)!, v, docs, session)
  const cspec = sel?._count ?? inc?._count
  const counts: Record<string, Map<string, number>> = {}
  if (cspec) {
    const names = cspec === true ? m.relations.filter((f) => f.isList).map((f) => f.name) : Object.keys(cspec.select ?? {}).filter((k) => cspec.select[k])
    for (const n of names) counts[n] = await countRelation(m, m.fields.get(n)!, cspec !== true ? cspec.select[n]?.where : undefined, docs, session)
  }
  return docs.map((d) => {
    let o = plain(m, d)
    if (sel) { const p: any = {}; for (const [k, v] of Object.entries(sel)) if (v && m.fields.get(k)?.kind !== 'object' && k !== '_count') p[k] = o[k]; o = p }
    for (const k of Object.keys(rels)) o[k] = loaded[k].get(`p:${d._id}`)
    if (cspec) { o._count = {}; for (const [n, mp] of Object.entries(counts)) o._count[n] = mp.get(String(d._id)) ?? 0 }
    return o
  })
}

// ── creating and updating
function defaultFor(f: F): any {
  const d = f.default
  if (d && typeof d === 'object' && !Array.isArray(d) && 'name' in d) {
    if (d.name.startsWith('uuid') || d.name.startsWith('cuid')) return crypto.randomUUID()
    if (d.name === 'now') return new Date()
    if (d.name === 'autoincrement') return Date.now()
    return null
  }
  if (d === undefined) return f.isList ? [] : null
  return f.type === 'DateTime' && typeof d === 'string' ? new Date(d) : d
}
async function toDoc(m: M, data: any, session: any, after: Array<(id: string) => Promise<void>>): Promise<any> {
  const doc: any = {}
  const rel = new Map(m.relations.map((r) => [r.name, r]))
  for (const f of m.scalars) {
    if (f.isUpdatedAt) { doc[key(f.name)] = new Date(); continue }
    const v = data[f.name]
    doc[key(f.name)] = v !== undefined ? coerce(f, v) : defaultFor(f)
  }
  for (const [k, v] of Object.entries<any>(data)) {
    const f = rel.get(k)
    if (!f || v == null) continue
    const r = MODELS.get(f.type)!
    if (f.relationFromFields?.length) { // to-one: connect or create, then set our foreign key
      const fk = f.relationFromFields[0], to = f.relationToFields![0]
      if (v.connect) doc[key(fk)] = v.connect[to] ?? (await col(r).findOne(await buildWhere(r, v.connect), { session }))?.[key(to)]
      else if (v.create) { const rd = await toDoc(r, v.create, session, after); await col(r).insertOne(rd, { session }); doc[key(fk)] = rd[key(to)] }
    } else { // to-many: create children once we have our id
      const o = await relOpposite(m, f)
      if (!o) throw notAvailable(`Creating ${m.name}.${k}`)
      for (const c of arr(v.create ?? [])) after.push(async (id) => { const rd = await toDoc(r, { ...c, [o.fk]: id }, session, after); await col(r).insertOne(rd, { session }) })
      if (v.createMany) for (const c of v.createMany.data) after.push(async (id) => { const rd = await toDoc(r, { ...c, [o.fk]: id }, session, after); await col(r).insertOne(rd, { session }) })
    }
  }
  return doc
}
async function splitNested(m: M, data: any, session: any): Promise<{ rest: any; run: (id: string) => Promise<void> }> {
  const rest: any = {}, jobs: Array<(id: string) => Promise<void>> = []
  for (const [k, v] of Object.entries<any>(data)) {
    const f = m.fields.get(k)
    if (f?.kind === 'object' && v && !f.relationFromFields?.length && (v.create || v.createMany)) {
      const o = await relOpposite(m, f)
      if (!o) throw notAvailable(`Updating ${m.name}.${k}`)
      const items = [...arr(v.create ?? []), ...(v.createMany?.data ?? [])]
      jobs.push(async (id) => { for (const c of items) { const rd = await toDoc(o.r, { ...c, [o.fk]: id }, session, []); await col(o.r).insertOne(rd, { session }) } })
    } else rest[k] = v
  }
  return { rest, run: async (id) => { for (const j of jobs) await j(id) } }
}
function updateOps(m: M, data: any) {
  const $set: any = {}, $inc: any = {}, $push: any = {}
  for (const f of m.scalars) if (f.isUpdatedAt) $set[f.name] = new Date()
  for (const [k, v] of Object.entries<any>(data)) {
    if (v === undefined) continue
    const f = m.fields.get(k)
    if (!f) throw new Error(`Unknown field ${m.name}.${k}`)
    if (f.kind === 'object') {
      const fk = f.relationFromFields?.[0]
      if (!fk) throw notAvailable(`Updating ${m.name}.${k}`)
      if (v.connect) $set[fk] = Object.values(v.connect)[0]
      if (v.disconnect) $set[fk] = null
      continue
    }
    const kk = key(k)
    if (isPlain(v) && f.type !== 'Json' && ['set', 'increment', 'decrement', 'multiply', 'divide', 'push'].some((o) => o in v)) {
      if ('set' in v) $set[kk] = coerce(f, v.set)
      if ('increment' in v) $inc[kk] = (($inc[kk] ?? 0) + Number(dec(v.increment)))
      if ('decrement' in v) $inc[kk] = (($inc[kk] ?? 0) - Number(dec(v.decrement)))
      if ('push' in v) $push[kk] = { $each: arr(v.push) }
      if ('multiply' in v || 'divide' in v) throw notAvailable('multiply and divide updates')
    } else $set[kk] = coerce(f, v)
  }
  const u: any = {}
  if (Object.keys($set).length) u.$set = $set
  if (Object.keys($inc).length) u.$inc = $inc
  if (Object.keys($push).length) u.$push = $push
  return u
}

// ── indexes: created once per collection on first use (unique keys from the schema; NULLs stay distinct like in Postgres)
const HAND = () => new Set(ALL_MODELS.map((x: any) => x.collection.name))
const ready = new Map<string, Promise<void>>()
const NON_NULL = ['string', 'date', 'int', 'long', 'double', 'decimal', 'bool']
function ensure(m: M): Promise<void> {
  let p = ready.get(m.coll)
  if (!p) {
    p = (async () => {
      const c = col(m)
      await mongoose.connection.createCollection(m.coll).catch(() => undefined)
      const have = new Set((await c.indexes().catch(() => [])).map((i: any) => JSON.stringify(i.key))) // hand-written models may already have it
      for (const u of m.uniques) {
        const spec: any = {}, pf: any = {}
        for (const n of u) { spec[key(n)] = 1; if (n !== 'id') pf[key(n)] = { $type: NON_NULL } }
        if (have.has(JSON.stringify(spec)) || u.length === 1 && u[0] === 'id') continue
        await c.createIndex(spec, { unique: true, ...(Object.keys(pf).length ? { partialFilterExpression: pf } : {}) }).catch((e: any) => console.error(`[mongo] unique index on ${m.coll} failed:`, e?.message))
      }
      if (HAND().has(m.coll)) return // the hand-written ports tune their own lookup indexes
      if (m.fields.has('tenantId')) await c.createIndex({ tenantId: 1 }).catch(() => undefined)
      for (const r of m.relations) if (r.relationFromFields?.length && r.relationFromFields[0] !== 'tenantId') await c.createIndex({ [r.relationFromFields[0]]: 1 }).catch(() => undefined)
    })()
    ready.set(m.coll, p)
  }
  return p
}
const dupError = (m: M, e: any) => (e?.code === 11000 ? known('P2002', `Unique constraint failed on ${m.coll}`, { target: Object.keys(e.keyPattern ?? {}) }) : e)

// ── the delegate for one model
class Lazy<T> implements PromiseLike<T> { // runs on first await, like Prisma's queries, so $transaction([...]) can run it on a session
  private p?: Promise<T>
  constructor(private fn: (s?: any) => Promise<T>) {}
  exec(s?: any) { return (this.p ??= this.fn(s)) }
  then<A = T, B = never>(a?: any, b?: any): Promise<A | B> { return this.exec().then(a, b) }
  catch(b?: any) { return this.exec().catch(b) }
  finally(f?: any) { return this.exec().finally(f) }
}
function delegate(m: M, delegateName: string, tx?: any) {
  const op = <T>(fn: (s?: any) => Promise<T>) => new Lazy<T>(async (s) => {
    if (!ENABLED.has(delegateName)) throw notAvailable(`${m.name}`)
    await ensure(m)
    const sess = s ?? tx
    if (!sess) return fn(undefined)
    const run = () => fn(sess)
    const next = (sess.__chain ?? Promise.resolve()).then(run, run)
    sess.__chain = next.catch(() => undefined)
    return next
  })
  const findDocs = async (args: any, s: any, one = false) => {
    const filter = await buildWhere(m, args?.where, s)
    let cur = col(m).find(filter, { session: s })
    cur = cur.sort(sortOf(args?.orderBy))
    if (args?.skip) cur = cur.skip(args.skip)
    if (one) cur = cur.limit(1); else if (args?.take != null && !args?.distinct) cur = cur.limit(Math.abs(args.take))
    let docs = await cur.toArray()
    if (args?.take != null && args.take < 0) docs = docs.reverse()
    if (args?.distinct) { const seen = new Set<string>(); docs = docs.filter((d) => { const k = JSON.stringify(arr(args.distinct).map((n: string) => d[key(n)])); if (seen.has(k)) return false; seen.add(k); return true }); if (args.take != null) docs = docs.slice(0, args.take) }
    return docs
  }
  const miss = () => known('P2025', 'An operation failed because it depends on one or more records that were required but not found.')
  const aggFields = (args: any, op: string) => Object.entries<any>(args[op] ?? {}).filter(([, v]) => v).map(([k]) => k)
  const accum = (args: any) => {
    const g: any = {}
    for (const [o, mo] of [['_sum', '$sum'], ['_avg', '$avg'], ['_min', '$min'], ['_max', '$max']]) for (const f of aggFields(args, o)) g[`${o}__${f}`] = { [mo]: `$${key(f)}` }
    if (args._count) { if (args._count === true) g['_count___all'] = { $sum: 1 }; else for (const f of aggFields(args, '_count')) g[`_count__${f}`] = f === '_all' ? { $sum: 1 } : { $sum: { $cond: [{ $ne: [`$${key(f)}`, null] }, 1, 0] } } }
    return g
  }
  const unflat = (row: any, args: any) => {
    const o: any = {}
    for (const [k, v] of Object.entries<any>(row)) { if (k === '_id') continue; const [a, b] = k.split('__'); (o[a] ??= {})[b] = v }
    for (const op of ['_sum', '_avg', '_min', '_max']) for (const f of aggFields(args, op)) { o[op] ??= {}; o[op][f] ??= null }
    if (args._count === true) o._count = o._count?._all ?? 0
    return o
  }
  return {
    findMany: (args: any) => op(async (s) => shape(m, await findDocs(args, s), args, s)),
    findFirst: (args: any) => op(async (s) => (await shape(m, await findDocs(args, s, true), args, s))[0] ?? null),
    findFirstOrThrow: (args: any) => op(async (s) => { const r = (await shape(m, await findDocs(args, s, true), args, s))[0]; if (!r) throw known('P2025', 'No record found'); return r }),
    findUnique: (args: any) => op(async (s) => (await shape(m, await findDocs(args, s, true), args, s))[0] ?? null),
    findUniqueOrThrow: (args: any) => op(async (s) => { const r = (await shape(m, await findDocs(args, s, true), args, s))[0]; if (!r) throw known('P2025', 'No record found'); return r }),
    count: (args: any) => op(async (s) => col(m).countDocuments(await buildWhere(m, args?.where, s), { session: s, ...(args?.skip && { skip: args.skip }), ...(args?.take != null && { limit: args.take }) })),
    aggregate: (args: any) => op(async (s) => {
      const rows = await col(m).aggregate([{ $match: await buildWhere(m, args?.where, s) }, { $group: { _id: null, ...accum(args) } }], { session: s }).toArray()
      return unflat(rows[0] ?? {}, args)
    }),
    groupBy: (args: any) => op(async (s) => {
      const by = arr(args.by)
      const id: any = {}; for (const b of by) id[b] = `$${key(b)}`
      const rows = await col(m).aggregate([{ $match: await buildWhere(m, args?.where, s) }, { $group: { _id: id, ...accum(args) } }], { session: s }).toArray()
      let out = rows.map((r: any) => ({ ...Object.fromEntries(by.map((b: string) => [b, r._id[b]])), ...unflat(r, args) }))
      if (args.orderBy) for (const o of arr(args.orderBy).reverse()) for (const [k, v] of Object.entries<any>(o)) { const dir = (typeof v === 'string' ? v : 'asc') === 'desc' ? -1 : 1; if (k.startsWith('_')) continue; out = out.sort((a: any, b: any) => (a[k] > b[k] ? dir : a[k] < b[k] ? -dir : 0)) }
      if (args.take != null) out = out.slice(args.skip ?? 0, (args.skip ?? 0) + args.take)
      return out
    }),
    create: (args: any) => op(async (s) => {
      const after: Array<(id: string) => Promise<void>> = []
      const doc = await toDoc(m, args.data, s, after)
      await col(m).insertOne(doc, { session: s }).catch((e) => { throw dupError(m, e) })
      for (const f of after) await f(doc._id)
      return (await shape(m, [doc], args, s))[0]
    }),
    createMany: (args: any) => op(async (s) => {
      const docs = []
      for (const d of arr(args.data)) docs.push(await toDoc(m, d, s, []))
      if (!docs.length) return { count: 0 }
      try { const r = await col(m).insertMany(docs, { session: s, ordered: !args.skipDuplicates }); return { count: r.insertedCount } }
      catch (e: any) { if (args.skipDuplicates && e?.code === 11000) return { count: e.result?.insertedCount ?? e.insertedCount ?? 0 }; throw dupError(m, e) }
    }),
    update: (args: any) => op(async (s) => {
      const nested = await splitNested(m, args.data, s)
      const u = updateOps(m, nested.rest)
      if (!Object.keys(u).length) { const d0 = await col(m).findOne(await buildWhere(m, args.where, s), { session: s }); if (!d0) throw miss(); await nested.run(d0._id as any); return (await shape(m, [d0], args, s))[0] }
      const d = await col(m).findOneAndUpdate(await buildWhere(m, args.where, s), u, { returnDocument: 'after', session: s }).catch((e) => { throw dupError(m, e) })
      if (!d) throw miss()
      await nested.run(d._id as any)
      return (await shape(m, [d], args, s))[0]
    }),
    updateMany: (args: any) => op(async (s) => {
      const filter = await buildWhere(m, args.where, s)
      const u = updateOps(m, args.data ?? {})
      if (!Object.keys(u).length) return { count: await col(m).countDocuments(filter, { session: s }) }
      const r = await col(m).updateMany(filter, u, { session: s }).catch((e) => { throw dupError(m, e) })
      return { count: r.matchedCount }
    }),
    upsert: (args: any) => op(async (s) => {
      const filter = await buildWhere(m, args.where, s)
      const found = await col(m).findOne(filter, { session: s })
      if (found) return (await shape(m, [await col(m).findOneAndUpdate({ _id: found._id }, updateOps(m, args.update), { returnDocument: 'after', session: s }) as any], args, s))[0]
      const after: Array<(id: string) => Promise<void>> = []
      const doc = await toDoc(m, args.create, s, after)
      await col(m).insertOne(doc, { session: s }).catch((e) => { throw dupError(m, e) })
      for (const f of after) await f(doc._id)
      return (await shape(m, [doc], args, s))[0]
    }),
    delete: (args: any) => op(async (s) => {
      const d = await col(m).findOneAndDelete(await buildWhere(m, args.where, s), { session: s })
      if (!d) throw miss()
      return (await shape(m, [d], args, s))[0]
    }),
    deleteMany: (args: any) => op(async (s) => ({ count: (await col(m).deleteMany(await buildWhere(m, args?.where, s), { session: s })).deletedCount })),
  }
}

function makeClient(tx?: any): any {
  const cache = new Map<string, any>()
  return new Proxy({}, {
    get(_t, p: string) {
      if (p === 'then') return undefined
      if (p === '$connect' || p === '$disconnect') return async () => undefined
      if (p === '$executeRaw') return (strings: any) => Promise.resolve(0).then((n) => { if (/pg_advisory_xact_lock/.test(String(strings?.[0] ?? strings))) return n; throw notAvailable('Raw SQL') }) // advisory locks are a Postgres detail; transactions cover it here
      if (p === '$queryRaw' || p === '$queryRawUnsafe' || p === '$executeRawUnsafe') return () => { const e = Promise.reject(notAvailable('Raw SQL')); e.catch(() => undefined); return e }
      if (p === '$transaction') {
        return async (work: any) => {
          if (tx) return typeof work === 'function' ? work(makeClient(tx)) : Promise.all(work) // already inside one
          const session = await mongoose.startSession()
          session.startTransaction()
          try {
            let result: any
            if (typeof work === 'function') result = await work(makeClient(session))
            else { result = []; for (const q of work) result.push(q instanceof Lazy ? await q.exec(session) : await q) }
            await session.commitTransaction()
            return result
          } catch (e) { await session.abortTransaction().catch(() => undefined); throw e }
          finally { await session.endSession() }
        }
      }
      const m = BY_DELEGATE.get(p)
      if (!m) return undefined
      let d = cache.get(p)
      if (!d) { d = delegate(m, p, tx); cache.set(p, d) }
      return d
    },
  })
}

export async function ensureEnabledModels() {
  for (const name of ENABLED) { const m = BY_DELEGATE.get(name); if (m) await ensure(m) }
}

export const prisma: any = makeClient()
