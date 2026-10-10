import type { IconName } from '../components/ui/Icon'
import type { AppKey } from './apps'

// The product map, in standard HRMS terms. It drives the sidebar, the command palette, route titles and the tour.
// `soon` modules are on the roadmap: admins see them with a "Soon" tag and a preview page.
export interface NavItem {
  label: string
  selfLabel?: string // shown to people who only see their own records (no team or company scope)
  path: string
  icon: IconName
  roles?: string[] // any of these role names; omitted = everyone
  app?: AppKey // hidden unless the company installed this app
  soon?: { phase: string; blurb: string; features: string[] }
  keywords?: string
}
export interface NavSection { key: string; label: string; icon: IconName; items: NavItem[] }

export const ROLE = {
  HR: ['hr_admin', 'system_admin'],
  ADMIN: ['hr_admin', 'system_admin'],
  PAYROLL: ['hr_admin', 'payroll_admin', 'compliance_officer'],
  APPROVERS: ['manager', 'hr_admin', 'system_admin'],
  DIRECTORY: ['manager', 'hr_admin', 'system_admin', 'payroll_admin', 'compliance_officer'],
}
const soon = (phase: string, blurb: string, features: string[]) => ({ phase, blurb, features })

export const SECTIONS: NavSection[] = [
  {
    key: 'home', label: 'Home', icon: 'home', items: [
      { label: 'Dashboard', path: '/dashboard', icon: 'home', keywords: 'home today overview' },
      { label: 'Approvals', path: '/approvals', icon: 'checkCircle', roles: ROLE.APPROVERS, keywords: 'pending requests inbox leave attendance' },
      { label: 'Tasks', path: '/activities', icon: 'list', keywords: 'activities to do follow ups' },
    ],
  },
  {
    key: 'employees', label: 'Employees', icon: 'users', items: [
      { label: 'Employees', selfLabel: 'My team', path: '/employees', icon: 'users', roles: ROLE.DIRECTORY, keywords: 'directory staff people team' },
      { label: 'Offboarding', path: '/exits', icon: 'door', app: 'exits', roles: ROLE.PAYROLL, keywords: 'exits resignation full and final settlement clearance' },
      { label: 'Org chart', path: '/org-chart', icon: 'layers', keywords: 'organisation hierarchy reporting lines tree managers departments' },
      { label: 'Recruitment', path: '/soon/recruitment', icon: 'briefcase', roles: ROLE.ADMIN, soon: soon('Later', 'Requisitions, candidates and offers that flow straight into onboarding.', ['Job requisitions with approval', 'Candidate pipeline and interview kits', 'Offer letters that create the employee record']) },
    ],
  },
  {
    key: 'time', label: 'Time & Attendance', icon: 'clock', items: [
      { label: 'Attendance', selfLabel: 'My attendance', path: '/attendance', icon: 'clock', app: 'attendance', keywords: 'clock in out timesheet regularisation overtime' },
      { label: 'Leave', selfLabel: 'My leave', path: '/leave', icon: 'leaf', app: 'leave', keywords: 'time off holiday vacation balance' },
      { label: 'Leave policies', path: '/leave-types', icon: 'sliders', roles: ['hr_admin'], app: 'leave', keywords: 'leave types accrual configuration' },
      { label: 'Holiday calendar', path: '/holidays', icon: 'calendar', keywords: 'public holidays festivals days off calendar' },
    ],
  },
  {
    key: 'payroll', label: 'Payroll & Expenses', icon: 'wallet', items: [
      { label: 'Payroll', selfLabel: 'My payslips', path: '/payroll', icon: 'wallet', app: 'payroll', keywords: 'payslips salary cycles bank file' },
      { label: 'Expenses', selfLabel: 'My expenses', path: '/expenses', icon: 'receipt', app: 'expenses', keywords: 'claims reimbursements per diem' },
      { label: 'Salary structures', path: '/compensation', icon: 'sliders', roles: ROLE.PAYROLL, app: 'payroll', keywords: 'compensation rules grade bands contracts' },
      { label: 'Tax & compliance', path: '/soon/tax', icon: 'scale', roles: ROLE.PAYROLL, soon: soon('Phase 3', 'Versioned statutory tables and filings for every country you employ in.', ['Zambia PAYE, NAPSA and NHIMA tables by effective date', 'India TDS (cumulative), Kenya and Nigeria', 'Tax declarations, certificates and statutory filing exports']) },
      { label: 'Incentives', path: '/soon/incentives', icon: 'gift', roles: ROLE.PAYROLL, soon: soon('Phase 4', 'Bonuses, commissions and recognition paid through payroll.', ['Nominations with approval', 'Commission plans and targets', 'Payouts posted as payroll inputs']) },
    ],
  },
  {
    key: 'workplace', label: 'Workplace', icon: 'book', items: [
      { label: 'Policies', path: '/policies', icon: 'book', keywords: 'handbook rules code of conduct accept' },
      { label: 'Grievances', path: '/grievances', icon: 'flag', keywords: 'complaint concern report confidential anonymous' },
      { label: 'Announcements', path: '/announcements', icon: 'message', keywords: 'news updates notices company communication' },
    ],
  },
  {
    key: 'reports', label: 'Reports & Audit', icon: 'chart', items: [
      { label: 'Reports', path: '/soon/reports', icon: 'chart', roles: [...ROLE.HR, 'payroll_admin'], soon: soon('Phase 5', 'Headcount, attrition, leave and payroll analytics with exports.', ['Ready-made people and payroll reports', 'Filters by unit, location and period', 'Scheduled exports to CSV and PDF']) },
      { label: 'Audit log', path: '/soon/audit', icon: 'audit', roles: [...ROLE.HR, 'compliance_officer'], soon: soon('Phase 5', 'Every sensitive change, who made it and when, searchable.', ['Filter by person, record and action', 'Before and after values', 'Export for auditors']) },
    ],
  },
  {
    key: 'admin', label: 'Administration', icon: 'settings', items: [
      { label: 'Company profile', path: '/settings/company', icon: 'briefcase', roles: ROLE.ADMIN, keywords: 'name logo country currency time zone' },
      { label: 'Apps', path: '/settings/apps', icon: 'grid', roles: ROLE.ADMIN, keywords: 'modules install' },
      { label: 'Settings', path: '/settings', icon: 'settings', roles: [...ROLE.ADMIN, 'payroll_admin'], keywords: 'configuration scheduled jobs' },
    ],
  },
]

// Account pages everyone has, outside the groups
export const ACCOUNT_ITEMS: NavItem[] = [
  { label: 'Security', path: '/security', icon: 'lock', keywords: 'two-factor mfa password' },
]

export const ALL_ITEMS = SECTIONS.flatMap((s) => s.items.map((i) => ({ ...i, section: s })))

export const canSee = (item: NavItem, roleNames: string[], apps?: string[]) =>
  (!item.roles || item.roles.some((r) => roleNames.includes(r))) && (!item.app || !apps || apps.includes(item.app))

// People who only see their own records get "My …" labels
export const hasTeamScope = (roleNames: string[]) => roleNames.some((r) => ROLE.DIRECTORY.includes(r))
export const labelFor = (item: NavItem, roleNames: string[]) => {
  if (!item.selfLabel) return item.label
  if (item.path === '/employees') return roleNames.some((r) => ROLE.HR.includes(r) || r === 'payroll_admin' || r === 'compliance_officer') ? item.label : item.selfLabel
  if (item.path === '/payroll') return roleNames.some((r) => ROLE.PAYROLL.includes(r)) ? item.label : item.selfLabel
  if (item.path === '/expenses') return roleNames.some((r) => [...ROLE.APPROVERS, 'payroll_admin'].includes(r)) ? item.label : item.selfLabel
  return hasTeamScope(roleNames) ? item.label : item.selfLabel
}

export function visibleSections(roleNames: string[], apps?: string[]) {
  return SECTIONS.map((s) => ({ ...s, items: s.items.filter((i) => canSee(i, roleNames, apps)).map((i) => ({ ...i, label: labelFor(i, roleNames) })) })).filter((s) => s.items.length)
}

// Most specific match wins (/settings/apps before /settings)
export function itemFor(pathname: string) {
  const p = pathname === '/' ? '/dashboard' : pathname
  return [...ALL_ITEMS, ...ACCOUNT_ITEMS.map((i) => ({ ...i, section: null as any }))]
    .filter((i) => p === i.path || p.startsWith(i.path + '/'))
    .sort((a, b) => b.path.length - a.path.length)[0] ?? null
}
export const sectionFor = (pathname: string) => itemFor(pathname)?.section ?? null

// Page title for a route, in the same words as the sidebar ("My leave" for self-service users, "Leave" for approvers)
export function navLabel(path: string, roleNames: string[]) {
  const it = ALL_ITEMS.find((i) => i.path === path)
  return it ? labelFor(it, roleNames) : ''
}
