import type { IconName } from '../components/ui/Icon'
import type { AppKey } from './apps'
import { tr } from './i18n'

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
  PAYROLL: ['payroll_admin', 'compliance_officer'], // pay: never HR
  APPROVERS: ['manager', 'hr_admin', 'system_admin'],
  DIRECTORY: ['manager', 'hr_admin', 'system_admin', 'payroll_admin', 'compliance_officer'],
}

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
      { label: 'Offboarding', path: '/exits', icon: 'door', app: 'exits', roles: ['hr_admin', 'payroll_admin'], keywords: 'exits resignation full and final settlement clearance' },
      { label: 'Onboarding & requests', selfLabel: 'My requests', path: '/requests', icon: 'mail', keywords: 'onboarding joining details data request profile update documents new joiner' },
      { label: 'Performance', selfLabel: 'My goals', path: '/performance', icon: 'target', keywords: 'appraisal goals kpi targets review rating okr' },
      { label: 'Org chart', path: '/org-chart', icon: 'layers', keywords: 'organisation hierarchy reporting lines tree managers departments' },
      { label: 'Recruitment', selfLabel: 'Jobs & referrals', path: '/recruitment', icon: 'briefcase', keywords: 'hiring jobs openings requisition candidates interviews offers referrals careers' },
    ],
  },
  {
    key: 'time', label: 'Time & Attendance', icon: 'clock', items: [
      { label: 'Attendance', selfLabel: 'My attendance', path: '/attendance', icon: 'clock', app: 'attendance', keywords: 'clock in out timesheet regularisation overtime' },
      { label: 'Leave', selfLabel: 'My leave', path: '/leave', icon: 'leaf', app: 'leave', keywords: 'time off holiday vacation balance' },
      { label: 'Attendance policies', path: '/attendance-policies', icon: 'sliders', roles: ROLE.ADMIN, app: 'attendance', keywords: 'office hours shift grace late penalty regularisation overtime comp off scheme' },
      { label: 'Shifts & rosters', path: '/rosters', icon: 'calendar', roles: ROLE.ADMIN, app: 'attendance', keywords: 'shift roster rota rotation split night schedule' },
      { label: 'Leave policies', path: '/leave-types', icon: 'sliders', roles: ['hr_admin'], app: 'leave', keywords: 'leave types accrual configuration' },
      { label: 'Holiday calendar', path: '/holidays', icon: 'calendar', keywords: 'public holidays festivals days off calendar' },
    ],
  },
  {
    key: 'payroll', label: 'Payroll & Expenses', icon: 'wallet', items: [
      { label: 'Payroll', selfLabel: 'My payslips', path: '/payroll', icon: 'wallet', app: 'payroll', keywords: 'payslips salary cycles bank file' },
      { label: 'Expenses', selfLabel: 'My expenses', path: '/expenses', icon: 'receipt', app: 'expenses', keywords: 'claims reimbursements per diem' },
      { label: 'Salary structures', path: '/compensation', icon: 'sliders', roles: ROLE.PAYROLL, app: 'payroll', keywords: 'compensation rules grade bands contracts' },
      { label: 'Pay review', path: '/compensation-review', icon: 'chart', roles: ['payroll_admin', 'manager'], app: 'payroll', keywords: 'compensation review increments raises budget team cost merit' },
      { label: 'Tax & compliance', selfLabel: 'My tax statement', path: '/tax', icon: 'scale', app: 'payroll', keywords: 'paye napsa nhima tds income tax statutory return filing certificate statement rates' },
      { label: 'Incentives', selfLabel: 'My awards', path: '/incentives', icon: 'gift', app: 'payroll', keywords: 'bonus award reward recognition nominate referral' },
    ],
  },
  {
    key: 'workplace', label: 'Workplace', icon: 'book', items: [
      { label: 'Policies', path: '/policies', icon: 'book', keywords: 'handbook rules code of conduct accept' },
      { label: 'Community', path: '/community', icon: 'message', keywords: 'forums discussions threads polls kudos recognition wall thanks' },
      { label: 'Grievances', path: '/grievances', icon: 'flag', keywords: 'complaint concern report confidential anonymous' },
      { label: 'Announcements', path: '/announcements', icon: 'message', keywords: 'news updates notices company communication' },
    ],
  },
  {
    key: 'reports', label: 'Reports & Audit', icon: 'chart', items: [
      { label: 'Reports', path: '/reports', icon: 'chart', roles: [...ROLE.HR, 'payroll_admin', 'compliance_officer', 'manager'], keywords: 'analytics headcount attendance leave payroll expenses attrition export' },
      { label: 'Audit log', path: '/audit', icon: 'audit', roles: [...ROLE.HR, 'compliance_officer'], keywords: 'history changes who changed security log' },
    ],
  },
  {
    key: 'admin', label: 'Administration', icon: 'settings', items: [
      { label: 'Masters', path: '/settings/masters', icon: 'layers', roles: ROLE.ADMIN, keywords: 'departments positions designations locations grades categories lists setup master data' },
      { label: 'Company profile', path: '/settings/company', icon: 'briefcase', roles: ROLE.ADMIN, keywords: 'name logo country currency time zone' },
      { label: 'Automation', path: '/settings/automation', icon: 'sparkle', roles: ROLE.ADMIN, keywords: 'rules workflows triggers alerts webhooks api keys integrations' },
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
export const labelFor = (item: NavItem, roleNames: string[]) => tr(englishLabel(item, roleNames))
const englishLabel = (item: NavItem, roleNames: string[]) => {
  if (!item.selfLabel) return item.label
  if (item.path === '/employees') return roleNames.some((r) => ROLE.HR.includes(r) || r === 'payroll_admin' || r === 'compliance_officer') ? item.label : item.selfLabel
  if (item.path === '/payroll') return roleNames.some((r) => ROLE.PAYROLL.includes(r)) ? item.label : item.selfLabel
  if (item.path === '/expenses') return roleNames.some((r) => [...ROLE.APPROVERS, 'payroll_admin'].includes(r)) ? item.label : item.selfLabel
  return hasTeamScope(roleNames) ? item.label : item.selfLabel
}

export function visibleSections(roleNames: string[], apps?: string[]) {
  return SECTIONS.map((s) => ({ ...s, label: tr(s.label), items: s.items.filter((i) => canSee(i, roleNames, apps)).map((i) => ({ ...i, label: labelFor(i, roleNames) })) })).filter((s) => s.items.length)
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
