import { lazy, Suspense, type ReactNode } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { AuthProvider } from './contexts/AuthContext'
import { queryClient } from './lib/queryClient'
import ProtectedRoute, { SplashScreen } from './components/ProtectedRoute'
import { ToastProvider } from './components/ui/Toast'
import { ErrorBoundary } from './pages/system/StatusPages'

// Every page is its own chunk: the first load only pulls the shell and the page being opened
const AppShell = lazy(() => import('./components/AppShell'))
const LandingPage = lazy(() => import('./pages/public/LandingPage'))
const LoginPage = lazy(() => import('./pages/LoginPage'))
const OrgChartPage = lazy(() => import('./pages/employees/OrgChartPage'))
const HolidaysPage = lazy(() => import('./pages/holidays/HolidaysPage'))
const SignupPage = lazy(() => import('./pages/public/SignupPage'))
const ChangePasswordPage = lazy(() => import('./pages/public/ChangePasswordPage'))
const SsoCallbackPage = lazy(() => import('./pages/SsoCallbackPage'))
const OnboardingPage = lazy(() => import('./pages/onboarding/OnboardingPage'))
const DashboardPage = lazy(() => import('./pages/DashboardPage'))
const EmployeeListPage = lazy(() => import('./pages/employees/EmployeeListPage'))
const EmployeeProfilePage = lazy(() => import('./pages/employees/EmployeeProfilePage'))
const LeavePage = lazy(() => import('./pages/leave/LeavePage'))
const LeaveTypesPage = lazy(() => import('./pages/leave/LeaveTypesPage'))
const AttendancePage = lazy(() => import('./pages/attendance/AttendancePage'))
const PayrollPage = lazy(() => import('./pages/payroll/PayrollPage'))
const CycleDetailPage = lazy(() => import('./pages/payroll/CycleDetailPage'))
const PayslipPage = lazy(() => import('./pages/payroll/PayslipPage'))
const ExpensesPage = lazy(() => import('./pages/expenses/ExpensesPage'))
const ApprovalsPage = lazy(() => import('./pages/approvals/ApprovalsPage'))
const ActivitiesPage = lazy(() => import('./pages/activities/ActivitiesPage'))
const ExitsPage = lazy(() => import('./pages/exits/ExitsPage'))
const ExitDetailPage = lazy(() => import('./pages/exits/ExitDetailPage'))
const SalarySetupPage = lazy(() => import('./pages/salary/SalarySetupPage'))
const SecurityPage = lazy(() => import('./pages/SecurityPage'))
const SettingsPage = lazy(() => import('./pages/SettingsPage'))
const CompanySettingsPage = lazy(() => import('./pages/settings/CompanySettings').then((m) => ({ default: m.CompanySettingsPage })))
const AppsSettingsPage = lazy(() => import('./pages/settings/CompanySettings').then((m) => ({ default: m.AppsSettingsPage })))
const NotFoundPage = lazy(() => import('./pages/system/StatusPages').then((m) => ({ default: m.NotFoundPage })))
const ComingSoonPage = lazy(() => import('./pages/system/StatusPages').then((m) => ({ default: m.ComingSoonPage })))

const HR = ['hr_admin', 'system_admin']
const DIRECTORY = ['manager', 'hr_admin', 'system_admin', 'payroll_admin', 'compliance_officer']
const STAFF = ['hr_admin', 'payroll_admin', 'compliance_officer']
const ADMINS = ['hr_admin', 'system_admin']
const guard = (el: ReactNode, opts: { roles?: string[]; app?: string } = {}) => <ProtectedRoute {...opts}>{el}</ProtectedRoute>

// Inside the shell a page loads under the bar, so a quiet placeholder is enough
const PageLoading = () => <div style={{ padding: 8 }}>{[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: i ? 120 : 56, marginBottom: 14, borderRadius: 'var(--r-card)' }} />)}</div>
const page = (el: ReactNode) => <Suspense fallback={<PageLoading />}>{el}</Suspense>

export default function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <ToastProvider>
            <BrowserRouter>
              <Suspense fallback={<SplashScreen />}>
                <Routes>
                  <Route path="/" element={<LandingPage />} />
                  <Route path="/login" element={<LoginPage />} />
                  <Route path="/signup" element={<SignupPage />} />
                  <Route path="/auth/sso" element={<SsoCallbackPage />} />
                  <Route path="/change-password" element={<ProtectedRoute stage="password"><ChangePasswordPage /></ProtectedRoute>} />
                  <Route path="/onboarding" element={<ProtectedRoute stage="onboarding"><OnboardingPage /></ProtectedRoute>} />
                  <Route element={<ProtectedRoute><AppShell /></ProtectedRoute>}>
                    <Route path="dashboard" element={page(<DashboardPage />)} />
                    <Route path="employees" element={page(guard(<EmployeeListPage />, { roles: DIRECTORY }))} />
                    <Route path="employees/:id" element={page(<EmployeeProfilePage />)} />
                    <Route path="org-chart" element={page(<OrgChartPage />)} />
                    <Route path="holidays" element={page(<HolidaysPage />)} />
                    <Route path="leave" element={page(guard(<LeavePage />, { app: 'leave' }))} />
                    <Route path="leave-types" element={page(guard(<LeaveTypesPage />, { roles: ['hr_admin'], app: 'leave' }))} />
                    <Route path="attendance" element={page(guard(<AttendancePage />, { app: 'attendance' }))} />
                    <Route path="payroll" element={page(guard(<PayrollPage />, { app: 'payroll' }))} />
                    <Route path="payroll/cycles/:id" element={page(guard(<CycleDetailPage />, { roles: STAFF, app: 'payroll' }))} />
                    <Route path="payroll/payslips/:id" element={page(guard(<PayslipPage />, { app: 'payroll' }))} />
                    <Route path="expenses" element={page(guard(<ExpensesPage />, { app: 'expenses' }))} />
                    <Route path="approvals" element={page(guard(<ApprovalsPage />, { roles: ['manager', ...HR] }))} />
                    <Route path="activities" element={page(<ActivitiesPage />)} />
                    <Route path="exits" element={page(guard(<ExitsPage />, { app: 'exits' }))} />
                    <Route path="exits/:id" element={page(guard(<ExitDetailPage />, { app: 'exits' }))} />
                    <Route path="compensation" element={page(guard(<SalarySetupPage />, { roles: STAFF, app: 'payroll' }))} />
                    <Route path="security" element={page(<SecurityPage />)} />
                    <Route path="settings" element={page(guard(<SettingsPage />, { roles: [...ADMINS, 'payroll_admin'] }))} />
                    <Route path="settings/company" element={page(guard(<CompanySettingsPage />, { roles: ADMINS }))} />
                    <Route path="settings/apps" element={page(guard(<AppsSettingsPage />, { roles: ADMINS }))} />
                    <Route path="soon/:slug" element={page(<ComingSoonPage />)} />
                    <Route path="*" element={page(<NotFoundPage />)} />
                  </Route>
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </Suspense>
            </BrowserRouter>
          </ToastProvider>
        </AuthProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  )
}
