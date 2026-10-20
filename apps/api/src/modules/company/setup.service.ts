import { prisma } from '../../infrastructure/database/prisma'
import { businessToday } from '../../shared/utils/businessDate'

// "Next steps" for a company's admins: what is still missing before each part of the app works, checked live.
// Each step links to the screen that fixes it. Optional steps never block "all set".
export interface SetupStep { key: string; title: string; detail: string; done: boolean; to: string; app?: string; optional?: boolean }

const roleHolders = (tenantId: string, name: string) => prisma.userRole.count({ where: { role: { tenantId, name }, user: { tenantId, active: true } } })

export async function setupStatus(tenantId: string): Promise<{ steps: SetupStep[]; done: number; total: number }> {
  const today = await businessToday(tenantId)
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { primaryCountry: true, modules: true } })
  const apps = tenant?.modules ?? []
  const [units, locations, people, withManager, noLogin, managers, calendars, structures, contracted, payrollAdmins, policies] = await Promise.all([
    prisma.orgUnit.count({ where: { tenantId, active: true } }),
    prisma.workLocation.count({ where: { tenantId } }),
    prisma.employee.count({ where: { tenantId, active: true } }),
    prisma.employee.count({ where: { tenantId, active: true, managerId: { not: null } } }),
    prisma.employee.count({ where: { tenantId, active: true, user: { passwordHash: null, googleSub: null } } }),
    roleHolders(tenantId, 'manager'),
    prisma.holidayCalendar.count({ where: { tenantId, active: true, year: today.getUTCFullYear() } }),
    prisma.salaryStructure.count({ where: { tenantId, active: true } }),
    prisma.employee.count({ where: { tenantId, active: true, contracts: { some: { active: true, status: 'running' } } } }),
    roleHolders(tenantId, 'payroll_admin'),
    prisma.policy.count({ where: { tenantId, active: true, versions: { some: { status: 'published' } } } }),
  ])
  const team = people > 1
  const steps: SetupStep[] = [
    { key: 'profile', title: 'Company profile', detail: tenant?.primaryCountry ? 'Country, currency and time zone set' : 'Set your country, currency and time zone', done: !!tenant?.primaryCountry, to: '/settings/company' },
    { key: 'departments', title: 'Departments', detail: units > 1 ? `${units - 1} department${units === 2 ? '' : 's'}` : 'Add your departments (Masters › Departments)', done: units > 1, to: '/settings/masters?tab=departments' },
    { key: 'locations', title: 'Offices', detail: locations ? `${locations} office${locations === 1 ? '' : 's'}` : 'Add at least one office (Masters › Work locations)', done: locations > 0, to: '/settings/masters?tab=locations' },
    { key: 'people', title: 'Add your people', detail: team ? `${people} people` : 'Add employees one by one or import a spreadsheet', done: team, to: '/employees' },
    { key: 'reporting', title: 'Who reports to whom', detail: withManager ? `${withManager} with a manager set` : 'Set "Reports to" on each person so requests reach their manager', done: !team || withManager > 0, to: '/org-chart' },
    { key: 'logins', title: 'Give people a login', detail: noLogin ? `${noLogin} without a login yet` : 'Everyone can sign in', done: team && noLogin === 0, to: '/employees' },
    { key: 'managers', title: 'Give managers the Manager role', detail: managers ? `${managers} manager${managers === 1 ? '' : 's'}` : 'Managers need the role to see approvals (Login & access tab)', done: !team || managers > 0, to: '/employees' },
    { key: 'holidays', title: 'Holiday calendar', detail: calendars ? `${today.getUTCFullYear()} calendar ready` : `Add this year's public holidays`, done: calendars > 0, to: '/holidays' },
    { key: 'structure', title: 'Salary structure', detail: structures ? `${structures} structure${structures === 1 ? '' : 's'}` : 'Start from the ready-made structure for your country', done: structures > 0, to: '/compensation', app: 'payroll' },
    { key: 'contracts', title: 'Contracts for everyone', detail: contracted === people ? 'Everyone has a running contract' : `${people - contracted} of ${people} without a running contract (payroll skips them)`, done: contracted === people, to: '/compensation?tab=contracts', app: 'payroll' },
    { key: 'payrollAdmin', title: 'A Payroll admin', detail: payrollAdmins ? `${payrollAdmins} payroll admin${payrollAdmins === 1 ? '' : 's'}` : 'Payroll needs a second person for the finance approval', done: payrollAdmins > 0, to: '/employees', app: 'payroll' },
    { key: 'policies', title: 'Publish a policy', detail: policies ? `${policies} polic${policies === 1 ? 'y' : 'ies'}` : 'Optional: share your handbook or code of conduct', done: policies > 0, to: '/policies', optional: true },
  ].filter((s) => !s.app || apps.includes(s.app))
  const required = steps.filter((s) => !s.optional)
  return { steps, done: required.filter((s) => s.done).length, total: required.length }
}
