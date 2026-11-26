import { APP_KEYS, AppKey } from './company.catalog'

// Plans and add-ons. A company's entitlements = its plan's features + any add-ons it has bought.
// `status: 'planned'` features are sold on the plan but not built yet; the screens say "coming soon".
export type Feature = {
  key: string
  name: string
  blurb: string
  status: 'live' | 'planned'
  app?: AppKey // the installable app this feature switches on
}

export const FEATURES: Feature[] = [
  { key: 'payroll', name: 'Complete payroll processing', blurb: 'Salary structures, statutory tax, two-person approval, payslips, bank file', status: 'live', app: 'payroll' },
  { key: 'leave', name: 'Leave management, unlimited types', blurb: 'Any number of leave types, accrual, carry forward, approval chains', status: 'live', app: 'leave' },
  { key: 'selfOnboarding', name: 'Employee self-onboarding', blurb: 'New joiners fill in their own details; HR approves', status: 'live' },
  { key: 'exits', name: 'Exit and full & final', blurb: 'Resignation, offboarding and settlement', status: 'live', app: 'exits' },
  { key: 'helpdesk', name: 'Helpdesk', blurb: 'Employees raise HR queries; tickets with owners and a response target', status: 'live' },
  { key: 'attendance', name: 'Attendance and shifts', blurb: 'Clock-in, shifts, rosters, regularisation, period lock', status: 'live', app: 'attendance' },
  { key: 'advancedAttendance', name: 'Overtime, permissions and geo-fencing', blurb: 'Overtime rules, short permissions, location fences', status: 'live' },
  { key: 'confirmation', name: 'Confirmation workflow', blurb: 'Probation review and confirmation with approvals', status: 'live' },
  { key: 'expenses', name: 'Expense management', blurb: 'Claims, per diem, approvals, reimbursement through payroll', status: 'live', app: 'expenses' },
  { key: 'pms', name: 'Performance management', blurb: 'Goals, KPI appraisal, review cycles', status: 'live' },
  { key: 'pmsAdvanced', name: 'Performance management, advanced', blurb: 'Competencies, self and manager appraisal, 360 feedback, calibration, 9-box and improvement plans', status: 'live' },
  { key: 'geomark', name: 'Face and location check-in', blurb: 'Selfie and location proof when marking attendance, with review of anything odd', status: 'live' },
  { key: 'biometricDevices', name: 'Biometric terminals', blurb: 'Fingerprint, face and card terminals send punches straight into attendance; the templates stay on the device', status: 'live' },
  { key: 'gpsTracking', name: 'GPS live tracking', blurb: 'Field-staff location during working hours, started by the person and visible to their managers', status: 'live' },
  { key: 'timesheets', name: 'Timesheets', blurb: 'Hours by project and task, approval, billing export', status: 'live' },
  { key: 'recruitment', name: 'Recruitment', blurb: 'Openings, candidates and the hiring pipeline', status: 'live' },
  { key: 'alumni', name: 'Alumni portal', blurb: 'Former staff keep access to letters and records', status: 'live' },
  { key: 'api', name: 'API and webhooks', blurb: 'API keys with scopes, signed webhooks, integration endpoints', status: 'live' },
  { key: 'sso', name: 'Single sign-on', blurb: 'Sign in through the company identity provider (OpenID Connect)', status: 'live' },
  { key: 'multiCompany', name: 'Multi-company', blurb: 'Several legal entities in one workspace', status: 'live' },
  { key: 'assistant', name: 'AI assistant', blurb: 'Ask HR questions and act on them, scoped to your role and company', status: 'live' },
]
const FEATURE_KEYS = FEATURES.map((f) => f.key)

export type Plan = { key: string; name: string; tagline: string; features: string[] }
const starter = ['payroll', 'leave', 'selfOnboarding', 'exits', 'helpdesk']
const growth = [...starter, 'attendance', 'advancedAttendance', 'confirmation']
const enterprise = [...growth, 'expenses', 'pms', 'pmsAdvanced', 'geomark', 'api', 'sso', 'multiCompany', 'timesheets', 'assistant']
export const PLANS: Plan[] = [
  { key: 'payroll', name: 'Payroll only', tagline: 'Payroll and statutory tax for your people, and nothing else', features: ['payroll'] },
  { key: 'starter', name: 'Starter', tagline: 'Payroll, leave and the basics', features: starter },
  { key: 'growth', name: 'Growth', tagline: 'Adds attendance, shifts and confirmations', features: growth },
  { key: 'enterprise', name: 'Enterprise', tagline: 'Everything, including performance, expenses, API and multi-company', features: enterprise },
]
export const DEFAULT_PLAN = 'growth' // new self-serve workspaces

// Any feature not in a plan can be bought on top of it
export const ADDONABLE = FEATURE_KEYS

export function entitlements(plan: string | undefined | null, addons: string[] = []) {
  // companies made before plans existed have no plan: they keep everything
  const p = PLANS.find((x) => x.key === (plan ?? 'enterprise')) ?? PLANS.find((x) => x.key === DEFAULT_PLAN)!
  const features = new Set([...p.features, ...addons.filter((a) => ADDONABLE.includes(a))])
  const apps = APP_KEYS.filter((a) => FEATURES.some((f) => f.app === a && features.has(f.key)))
  return { plan: p.key, features: [...features], apps }
}

export const hasFeature = (plan: string | undefined | null, addons: string[], key: string) => entitlements(plan, addons).features.includes(key)

if (require.main === module) {
  const s = entitlements('starter')
  console.assert(!s.apps.includes('attendance') && s.apps.includes('payroll'), 'starter has payroll, no attendance')
  console.assert(entitlements('starter', ['expenses']).apps.includes('expenses'), 'add-on unlocks the app')
  console.assert(entitlements('enterprise').apps.length === APP_KEYS.length, 'enterprise has every app')
  console.assert(entitlements('nonsense').plan === DEFAULT_PLAN && entitlements(undefined).plan === 'enterprise', 'unknown plan falls back, missing plan is grandfathered')
  console.assert(!entitlements('growth', ['bogus']).features.includes('bogus'), 'unknown add-ons are ignored')
  console.log('plans.catalog ok')
}
