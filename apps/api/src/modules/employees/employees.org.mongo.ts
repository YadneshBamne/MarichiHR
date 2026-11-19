import mongoose from 'mongoose'
import { AppError } from '../../shared/utils/AppError'
import { assertRefsInTenant } from './employees.mongo'
import { CreateOrgUnitDto, CreateJobPositionDto, CreateWorkLocationDto, AddSkillDto, AddResumeLineDto } from './employees.types'
import { OrgUnit, JobPosition, WorkLocation, Employee, AuditLog } from '../../infrastructure/mongo/mongo'

// MongoDB version of the org unit, job position and work location services (and the Masters hub), plus the employee
// skills and resume lines, which are not ported yet and answer 501.

const ser = (d: any) => { if (!d) return d; const { _id, ...rest } = d; return { id: _id, ...rest } }
const col = (n: string) => mongoose.connection.collection(n)
const CI = { locale: 'en', strength: 2 } as const

async function headcounts(tenantId: string) {
  const rows: any[] = await Employee.aggregate([{ $match: { tenantId, active: true } }, { $group: { _id: '$orgUnitId', n: { $sum: 1 } } }])
  return new Map<string, number>(rows.map((r) => [r._id, r.n]))
}
async function positionsByUnit(tenantId: string) {
  const rows: any[] = await JobPosition.find({ tenantId, active: true }).select('title code orgUnitId').lean()
  const m = new Map<string, any[]>()
  for (const r of rows) m.set(r.orgUnitId, [...(m.get(r.orgUnitId) ?? []), { id: r._id, title: r.title, code: r.code }])
  return m
}

export const orgUnitService = {
  // The whole company as a tree: every unit with its sub-units, positions and headcount
  async getTree(tenantId: string) {
    const [units, heads, pos]: any[] = await Promise.all([OrgUnit.find({ tenantId, active: true }).collation(CI).sort({ name: 1 }).lean(), headcounts(tenantId), positionsByUnit(tenantId)])
    const node = (u: any): any => ({ ...ser(u), children: units.filter((c: any) => c.parentId === u._id).map(node), jobPositions: pos.get(u._id) ?? [], _count: { employees: heads.get(u._id) ?? 0 } })
    return units.filter((u: any) => !u.parentId).map(node)
  },

  async getById(id: string, tenantId: string) {
    const u: any = await OrgUnit.findOne({ _id: id, tenantId, active: true }).lean()
    if (!u) throw new AppError('Org unit not found', 404)
    const [parent, children, jobs, n]: any[] = await Promise.all([
      u.parentId ? OrgUnit.findById(u.parentId).select('name type').lean() : null,
      OrgUnit.find({ tenantId, parentId: id, active: true }).select('name type').lean(),
      JobPosition.find({ tenantId, orgUnitId: id, active: true }).lean(),
      Employee.countDocuments({ tenantId, orgUnitId: id, active: true }),
    ])
    return { ...ser(u), parent: parent && ser(parent), children: children.map(ser), jobPositions: jobs.map(ser), _count: { employees: n } }
  },

  async create(tenantId: string, data: CreateOrgUnitDto) {
    await assertRefsInTenant(tenantId, { parentOrgUnitId: data.parentId })
    return ser((await OrgUnit.create({ ...data, tenantId, active: true })).toObject())
  },

  async update(id: string, tenantId: string, data: Partial<CreateOrgUnitDto>, _updatedBy: string) {
    const unit: any = await OrgUnit.findOne({ _id: id, tenantId, active: true }).lean()
    if (!unit) throw new AppError('Org unit not found', 404)
    if (data.parentId === id) throw new AppError('An org unit cannot be its own parent', 400)
    await assertRefsInTenant(tenantId, { parentOrgUnitId: data.parentId })
    if (data.parentId) {
      const all: any[] = await OrgUnit.find({ tenantId }).select('parentId').lean()
      const parentOf = new Map<string, string | undefined>(all.map((u) => [u._id, u.parentId]))
      for (let p: string | undefined = data.parentId, hops = 0; p && hops < 50; p = parentOf.get(p), hops++) {
        if (p === id) throw new AppError('A unit cannot move under one of its own sub-units', 400)
      }
    }
    return ser(await OrgUnit.findOneAndUpdate({ _id: id, tenantId }, { $set: data }, { returnDocument: 'after' }).lean())
  },

  async archive(id: string, tenantId: string, archivedBy: string, reason: string) {
    const unit: any = await OrgUnit.findOne({ _id: id, tenantId, active: true }).lean()
    if (!unit) throw new AppError('Org unit not found', 404)
    const people = await Employee.countDocuments({ tenantId, orgUnitId: id, active: true })
    if (people > 0) throw new AppError(`Cannot archive org unit with ${people} active employees`, 400)
    const children = await OrgUnit.countDocuments({ tenantId, parentId: id, active: true })
    if (children) throw new AppError(`Move or archive its ${children} sub-unit${children > 1 ? 's' : ''} first`, 400)
    const done: any = await OrgUnit.findOneAndUpdate({ _id: id, tenantId }, { $set: { active: false, archivedAt: new Date() } }, { returnDocument: 'after' }).lean()
    await AuditLog.create({ tenantId, userId: archivedBy, action: 'ORG_UNIT_ARCHIVED', entityType: 'org_unit', entityId: id, newValue: { reason } })
    return ser(done)
  },
}

export const jobPositionService = {
  async list(tenantId: string, orgUnitId?: string) {
    const rows: any[] = await JobPosition.find({ tenantId, active: true, ...(orgUnitId && { orgUnitId }) }).collation(CI).sort({ title: 1 }).lean()
    const [units, heads]: any[] = await Promise.all([
      OrgUnit.find({ _id: { $in: rows.map((r) => r.orgUnitId) } }).select('name').lean(),
      Employee.aggregate([{ $match: { tenantId, active: true, jobPositionId: { $in: rows.map((r) => r._id) } } }, { $group: { _id: '$jobPositionId', n: { $sum: 1 } } }]),
    ])
    const U = new Map<string, any>(units.map((u: any) => [u._id, u])), H = new Map<string, number>(heads.map((h: any) => [h._id, h.n]))
    return rows.map((r) => ({ ...ser(r), orgUnit: U.get(r.orgUnitId) && { id: r.orgUnitId, name: U.get(r.orgUnitId).name }, _count: { employees: H.get(r._id) ?? 0 } }))
  },
  async create(tenantId: string, data: CreateJobPositionDto) {
    await assertRefsInTenant(tenantId, { orgUnitId: data.orgUnitId })
    return ser((await JobPosition.create({ ...data, tenantId, active: true })).toObject())
  },
  async update(id: string, tenantId: string, data: Partial<CreateJobPositionDto>) {
    if (!(await JobPosition.exists({ _id: id, tenantId }))) throw new AppError('Job position not found', 404)
    await assertRefsInTenant(tenantId, { orgUnitId: data.orgUnitId })
    return ser(await JobPosition.findOneAndUpdate({ _id: id, tenantId }, { $set: data }, { returnDocument: 'after' }).lean())
  },
}

export const workLocationService = {
  async list(tenantId: string) { return ((await WorkLocation.find({ tenantId, active: true }).collation(CI).sort({ name: 1 }).lean()) as any[]).map(ser) },
  async create(tenantId: string, data: CreateWorkLocationDto) { return ser((await WorkLocation.create({ ...data, tenantId, active: true })).toObject()) },
  async update(id: string, tenantId: string, data: Partial<CreateWorkLocationDto>) {
    const r: any = await WorkLocation.findOneAndUpdate({ _id: id, tenantId }, { $set: data }, { returnDocument: 'after' }).lean()
    if (!r) throw new AppError('Work location not found', 404)
    return ser(r)
  },
}

// Positions and locations are archived (never deleted) once nobody active holds them
async function archiveMaster(kind: 'jobPosition' | 'workLocation', id: string, tenantId: string, userId: string) {
  const model: any = kind === 'jobPosition' ? JobPosition : WorkLocation
  if (!(await model.exists({ _id: id, tenantId }))) throw new AppError(kind === 'jobPosition' ? 'Job position not found' : 'Work location not found', 404)
  const inUse = await Employee.countDocuments({ tenantId, active: true, [kind === 'jobPosition' ? 'jobPositionId' : 'workLocationId']: id })
  if (inUse) throw new AppError(`${inUse} active ${inUse === 1 ? 'person uses' : 'people use'} it; move them first`, 400)
  await model.updateOne({ _id: id, tenantId }, { active: false })
  await AuditLog.create({ tenantId, userId, action: kind === 'jobPosition' ? 'JOB_POSITION_ARCHIVED' : 'WORK_LOCATION_ARCHIVED', entityType: kind === 'jobPosition' ? 'job_position' : 'work_location', entityId: id })
  return { archived: true }
}
export const archiveJobPosition = (id: string, tenantId: string, userId: string) => archiveMaster('jobPosition', id, tenantId, userId)
export const archiveWorkLocation = (id: string, tenantId: string, userId: string) => archiveMaster('workLocation', id, tenantId, userId)

// Every master list with how many entries it has, for the Masters hub
export async function mastersOverview(tenantId: string) {
  const [units, heads]: any[] = await Promise.all([OrgUnit.find({ tenantId, active: true }).lean(), headcounts(tenantId)])
  const n = (c: string, f: object = { tenantId }) => col(c).countDocuments(f as any)
  const [positions, locations, grades, leaveTypes, calendars, expenseCats, incentiveTypes, inputTypes, structures, activityTypes] = await Promise.all([
    n('job_positions', { tenantId, active: true }), n('work_locations', { tenantId, active: true }), n('grade_bands'), n('leave_types', { tenantId, active: true }), n('holiday_calendars', { tenantId, active: true }),
    n('expense_categories'), n('incentive_types', { tenantId, active: true }), n('payroll_input_types', { tenantId, active: true }), n('salary_structures'), n('activity_types'),
  ])
  return {
    units: units.map((u: any) => ({ id: u._id, name: u.name, type: u.type, parentId: u.parentId ?? null, costCenter: u.costCenter ?? null, headcount: heads.get(u._id) ?? 0 })),
    counts: { departments: units.length, positions, locations, grades, leaveTypes, calendars, expenseCats, incentiveTypes, inputTypes, structures, activityTypes },
  }
}

// Not ported yet
const later = (what: string) => { throw new AppError(`${what} are not available on the MongoDB version yet`, 501, 'NOT_AVAILABLE_ON_MONGO') }
export const employeeExtras = {
  async addSkill(_e: string, _t: string, _d: AddSkillDto) { return later('Skills') },
  async removeSkill(_s: string, _e: string, _t: string) { return later('Skills') },
  async addResumeLine(_e: string, _t: string, _d: AddResumeLineDto) { return later('Resume lines') },
  async updateResumeLine(_i: string, _e: string, _t: string, _d: Partial<AddResumeLineDto>) { return later('Resume lines') },
  async removeResumeLine(_i: string, _e: string, _t: string) { return later('Resume lines') },
  async getSkillTypes(_t: string) { return [] as any[] },
}
