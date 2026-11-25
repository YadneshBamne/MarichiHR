import mongoose from 'mongoose'
import { Employee, OrgUnit, User } from '../../infrastructure/mongo/mongo'
import { businessToday } from '../../shared/utils/businessDate'

// MongoDB version of the "Next steps" list for a company's admins (see setup.service.ts): what is still missing before each part of the
// app works, checked live. Each step links to the screen that fixes it. Optional steps never block "all set".
export interface SetupStep { key: string; title: string; detail: string; done: boolean; to: string; app?: string; optional?: boolean }
const col = (n: string) => mongoose.connection.collection(n)
const holders = (tenantId: string, roleName: string) => User.countDocuments({ tenantId, active: true, userRoles: { $elemMatch: { roleName } } })

export async function setupStatus(tenantId: string): Promise<{ steps: SetupStep[]; done: number; total: number }> {
  const today = await businessToday(tenantId)
  const tenant: any = await col('tenants').findOne({ _id: tenantId } as any)
  const apps: string[] = tenant?.modules ?? []
  const active = (await Employee.find({ tenantId, active: true }).select('_id userId managerId').lean()) as any[]
  const noPw = (await User.find({ tenantId, passwordHash: { $in: [null, undefined] }, googleSub: { $in: [null, undefined] } }).select('_id').lean()) as any[]
  const noPwIds = new Set(noPw.map((u) => u._id))
  const published = await col('policy_versions').distinct('policyId', { status: 'published' } as any)
  const contractedIds = new Set(((await col('employee_contracts').distinct('employeeId', { active: true, status: 'running', employeeId: { $in: active.map((e) => e._id) } } as any)) as string[]))
  const [units, locations, managers, calendars, structures, payrollAdmins, policies] = await Promise.all([
    OrgUnit.countDocuments({ tenantId, active: true }),
    col('work_locations').countDocuments({ tenantId } as any),
    holders(tenantId, 'manager'),
    col('holiday_calendars').countDocuments({ tenantId, active: true, year: today.getUTCFullYear() } as any),
    col('salary_structures').countDocuments({ tenantId, active: true } as any),
    holders(tenantId, 'payroll_admin'),
    col('policies').countDocuments({ tenantId, active: true, _id: { $in: published } } as any),
  ])
  const people = active.length
  const withManager = active.filter((e) => e.managerId).length
  const noLogin = active.filter((e) => e.userId && noPwIds.has(e.userId)).length
  const contracted = active.filter((e) => contractedIds.has(e._id)).length
  const team = people > 1
  const steps: SetupStep[] = [
    { key: 'profile', title: 'Company profile', detail: tenant?.primaryCountry ? 'Country, currency and time zone set' : 'Set your country, currency and time zone', done: !!tenant?.primaryCountry, to: '/settings/company' },
    { key: 'departments', title: 'Departments', detail: units > 1 ? `${units - 1} department${units === 2 ? '' : 's'}` : 'Add your departments (Masters › Departments)', done: units > 1, to: '/settings/masters?tab=departments' },
    { key: 'locations', title: 'Offices', detail: locations ? `${locations} office${locations === 1 ? '' : 's'}` : 'Add at least one office (Masters › Work locations)', done: locations > 0, to: '/settings/masters?tab=locations' },
    { key: 'people', title: 'Add your people', detail: team ? `${people} people` : 'Add employees one by one or import a spreadsheet', done: team, to: '/employees' },
    { key: 'reporting', title: 'Who reports to whom', detail: !team ? 'After you add people' : withManager ? `${withManager} with a manager set` : 'Set "Reports to" on each person so requests reach their manager', done: team && withManager > 0, to: '/org-chart' },
    { key: 'logins', title: 'Give people a login', detail: !team ? 'After you add people' : noLogin ? `${noLogin} without a login yet` : 'Everyone can sign in', done: team && noLogin === 0, to: '/employees' },
    { key: 'managers', title: 'Give managers the Manager role', detail: !team ? 'After you add people' : managers ? `${managers} manager${managers === 1 ? '' : 's'}` : 'Managers need the role to see approvals (Login & access tab)', done: team && managers > 0, to: '/employees' },
    { key: 'holidays', title: 'Holiday calendar', detail: calendars ? `${today.getUTCFullYear()} calendar ready` : `Add this year's public holidays`, done: calendars > 0, to: '/holidays' },
    { key: 'structure', title: 'Salary structure', detail: structures ? `${structures} structure${structures === 1 ? '' : 's'}` : 'A Payroll admin starts from the ready-made structure for your country', done: structures > 0, to: '/compensation', app: 'payroll' },
    { key: 'contracts', title: 'Contracts for everyone', detail: contracted === people ? 'Everyone has a running contract' : `${people - contracted} of ${people} without a running contract (payroll skips them)`, done: contracted === people, to: '/compensation?tab=contracts', app: 'payroll' },
    { key: 'payrollAdmin', title: 'Two Payroll admins', detail: payrollAdmins >= 2 ? `${payrollAdmins} payroll admins` : payrollAdmins ? 'Only one: every payroll needs approvals from two different Payroll admins' : 'Payroll admins run payroll, contracts and salary structures; two are needed to approve a payroll', done: payrollAdmins >= 2, to: '/employees', app: 'payroll' },
    { key: 'policies', title: 'Publish a policy', detail: policies ? `${policies} polic${policies === 1 ? 'y' : 'ies'}` : 'Optional: share your handbook or code of conduct', done: policies > 0, to: '/policies', optional: true },
  ].filter((s) => !s.app || apps.includes(s.app))
  const required = steps.filter((s) => !s.optional)
  return { steps, done: required.filter((s) => s.done).length, total: required.length }
}
