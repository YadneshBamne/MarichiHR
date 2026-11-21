import express, { Router } from 'express'
import crypto from 'crypto'
import mongoose from 'mongoose'
import { asyncHandler } from '../../shared/utils/asyncHandler'
import { Employee } from '../../infrastructure/mongo/mongo'
import { tenantHasFeature, tenantModules } from '../../middleware/module.middleware'
import { getTenantTimezone, zonedTimeToUtc } from '../../shared/utils/businessDate'
import { attendanceService } from '../attendance/attendance.service'

// Biometric terminals (ZKTeco and the makes built on it: eSSL, Realtime, Matrix, and others) speak the "ADMS" push protocol: the terminal
// calls US (so it needs no fixed address at the office), says who it is by serial number, and posts its punches as tab-separated text.
// Only the punches are used (who, when). Fingerprint, face and iris templates, user lists and photos are never asked for and are ignored
// if sent: they stay on the terminal. Worth knowing: the protocol has no real login (the serial number is all there is), so only serials a
// company has registered are accepted, and many terminals cannot use https (see DEVICE_PUSH_HOST/PORT in the devices setup screen).
// The text formats below follow the community implementations of the protocol, not an official document: check them against the first real terminal.
export const admsRouter = Router()
admsRouter.use(express.text({ type: () => true, limit: '1mb' }))

const col = (n: string) => mongoose.connection.collection(n)
const uuid = () => crypto.randomUUID()
const plain = (res: any, text: string, status = 200) => res.status(status).type('text/plain').send(text)
const MAX_LINES = 5000
const LINE = /^(\S+)[\t ]+(\d{4}-\d{2}-\d{2})[\t ]+(\d{2}:\d{2}:\d{2})(?:[\t ]+(\d+))?(?:[\t ]+(\d+))?/
export const serialOf = (v: unknown) => String(v ?? '').trim().toUpperCase()

let indexes: Promise<unknown> | null = null
export const deviceIndexes = () => (indexes ??= Promise.all([
  col('biometric_devices').createIndex({ serial: 1 }, { unique: true }),
  col('device_users').createIndex({ tenantId: 1, pin: 1 }, { unique: true }),
  col('device_users').createIndex({ tenantId: 1, employeeId: 1 }, { unique: true }),
  col('device_punches').createIndex({ deviceId: 1, pin: 1, at: 1 }, { unique: true }),
  col('device_punches').createIndex({ tenantId: 1, status: 1, at: -1 }),
]).catch((e) => { indexes = null; throw e }))

async function deviceOf(req: any): Promise<any | null> {
  const sn = serialOf(req.query.SN)
  if (!sn || sn.length > 40) return null
  await deviceIndexes()
  const d: any = await col('biometric_devices').findOne({ serial: sn, active: true } as any)
  if (!d) return null
  // a company that no longer has the add-on or the app is treated like an unknown terminal
  if (!(await tenantHasFeature(d.tenantId, 'biometricDevices')) || !(await tenantModules(d.tenantId)).includes('attendance')) return null
  return d
}
const touch = (d: any, req: any, extra: object = {}) => col('biometric_devices').updateOne({ _id: d._id } as any, { $set: { lastSeenAt: new Date(), lastIp: req.ip ?? null, ...extra } })

// The terminal's timestamps are its own wall clock: read them in the terminal's timezone (default: the company's)
async function instantOf(d: any, ymd: string, hms: string): Promise<Date> {
  const tz = d.timezone || (await getTenantTimezone(d.tenantId))
  const base = zonedTimeToUtc(ymd, hms.slice(0, 5), tz)
  return new Date(base.getTime() + Number(hms.slice(6, 8)) * 1000)
}

// One stored punch → attendance, or a reason it was not applied. Never throws: a bad punch must not stop the rest of a batch.
export async function applyPunch(d: any, p: any): Promise<string> {
  const set = async (status: string, extra: object = {}) => { await col('device_punches').updateOne({ _id: p._id } as any, { $set: { status, processedAt: new Date(), reason: null, ...extra } }); return status }
  try {
    if (p.at < d.acceptFrom) return set('ignored_old') // a terminal can resend its whole history; only recent punches count
    if (p.at.getTime() > Date.now() + 10 * 60000) return set('rejected', { reason: 'The terminal clock is ahead of real time. Check the date and time on the terminal.' })
    const m: any = await col('device_users').findOne({ tenantId: d.tenantId, pin: p.pin } as any)
    if (!m) return set('unknown_user', { reason: 'No employee has this terminal ID yet.' })
    const emp: any = await Employee.findOne({ _id: m.employeeId, tenantId: d.tenantId }).select('employmentStatus').lean()
    if (!emp || emp.employmentStatus === 'terminated') return set('rejected', { employeeId: m.employeeId, reason: 'This person has left the company.' })
    const last: any = await col('device_punches').find({ tenantId: d.tenantId, employeeId: m.employeeId, status: 'applied' } as any).sort({ at: -1 }).limit(1).next()
    if (last && p.at.getTime() - last.at.getTime() >= 0 && p.at.getTime() - last.at.getTime() < 60000) return set('duplicate_tap', { employeeId: m.employeeId })
    if (last && p.at <= last.at) return set('rejected', { employeeId: m.employeeId, reason: 'A later punch for this person is already recorded.' })
    // The terminal's own in/out key is honoured for "out"; otherwise the person is clocked in, or out if they already are
    const data = { method: 'biometric' as const, at: p.at, ...(d.workLocationId && { locationId: d.workLocationId }) }
    let direction: 'in' | 'out' = p.state === 1 || p.state === 5 ? 'out' : 'in'
    let rec: any
    try { rec = direction === 'in' ? await attendanceService.clockIn(m.employeeId, d.tenantId, data) : await attendanceService.clockOut(m.employeeId, d.tenantId, data) } catch (e: any) {
      if (direction === 'in' && /already clocked in/i.test(e?.message ?? '')) { direction = 'out'; rec = await attendanceService.clockOut(m.employeeId, d.tenantId, data) } else throw e
    }
    return set('applied', { employeeId: m.employeeId, direction, recordId: rec?.id ?? null })
  } catch (e: any) {
    return set('rejected', { reason: String(e?.message ?? 'Could not be recorded').slice(0, 200) })
  }
}
// Punches that arrived before their person had a terminal ID: run them once the ID is set
export async function replayUnknown(tenantId: string, pin: string) {
  const rows: any[] = await col('device_punches').find({ tenantId, pin, status: 'unknown_user' } as any).sort({ at: 1 }).limit(2000).toArray()
  const devices = new Map<string, any>()
  let applied = 0
  for (const p of rows) {
    if (!devices.has(p.deviceId)) devices.set(p.deviceId, await col('biometric_devices').findOne({ _id: p.deviceId } as any))
    const d = devices.get(p.deviceId)
    if (d && (await applyPunch(d, p)) === 'applied') applied++
  }
  return applied
}

// Handshake: the terminal asks how to behave. We ask for attendance logs only.
admsRouter.get('/cdata', asyncHandler(async (req, res) => {
  const d = await deviceOf(req)
  if (!d) return plain(res, 'ERROR: unknown terminal', 403)
  await touch(d, req, { firmware: String(req.query.pushver ?? d.firmware ?? '') || null })
  plain(res, ['GET OPTION FROM: ' + d.serial, 'ATTLOGStamp=None', 'OPERLOGStamp=9999', 'ATTPHOTOStamp=None', 'ErrorDelay=60', 'Delay=30', 'TransTimes=00:00;14:05', 'TransInterval=1', 'TransFlag=TransData AttLog', 'Realtime=1', 'Encrypt=None', ''].join('\n'))
}))
// Data from the terminal. Only table=ATTLOG is read; everything else is acknowledged and dropped.
admsRouter.post('/cdata', asyncHandler(async (req, res) => {
  const d = await deviceOf(req)
  if (!d) return plain(res, 'ERROR: unknown terminal', 403)
  const table = String(req.query.table ?? '').toUpperCase()
  const body = typeof req.body === 'string' ? req.body : ''
  if (table !== 'ATTLOG') { await touch(d, req); return plain(res, 'OK') }
  const parsed: { pin: string; at: Date; state: number; verify: number }[] = []
  for (const line of body.split(/\r?\n/).slice(0, MAX_LINES)) {
    const m = LINE.exec(line.trim())
    if (m) parsed.push({ pin: m[1], at: await instantOf(d, m[2], m[3]), state: Number(m[4] ?? 0), verify: Number(m[5] ?? 0) })
  }
  parsed.sort((a, b) => a.at.getTime() - b.at.getTime())
  for (const p of parsed) {
    // the same punch sent twice (the terminal retries until it hears "OK") is stored once and applied once
    const r = await col('device_punches').updateOne({ deviceId: d._id, pin: p.pin, at: p.at } as any, { $setOnInsert: { _id: uuid(), tenantId: d.tenantId, deviceId: d._id, pin: p.pin, at: p.at, state: p.state, verify: p.verify, status: 'received', receivedAt: new Date() } }, { upsert: true })
    if (r.upsertedId) await applyPunch(d, await col('device_punches').findOne({ _id: r.upsertedId } as any))
  }
  await touch(d, req, parsed.length ? { lastPunchAt: parsed[parsed.length - 1].at } : {})
  plain(res, `OK: ${parsed.length}`)
}))
// The terminal polls for commands. We never send any.
admsRouter.get('/getrequest', asyncHandler(async (req, res) => {
  const d = await deviceOf(req)
  if (!d) return plain(res, 'ERROR: unknown terminal', 403)
  await touch(d, req)
  plain(res, 'OK')
}))
admsRouter.post('/devicecmd', asyncHandler(async (req, res) => {
  const d = await deviceOf(req)
  if (!d) return plain(res, 'ERROR: unknown terminal', 403)
  plain(res, 'OK')
}))
