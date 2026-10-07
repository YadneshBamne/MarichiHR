import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { AuthProvider } from './contexts/AuthContext'
import { queryClient } from './lib/queryClient'
import ProtectedRoute from './components/ProtectedRoute'
import AppShell from './components/AppShell'
import LoginPage from './pages/LoginPage'
import DashboardPage from './pages/DashboardPage'
import EmployeeListPage from './pages/employees/EmployeeListPage'
import EmployeeProfilePage from './pages/employees/EmployeeProfilePage'
import LeavePage from './pages/leave/LeavePage'
import AttendancePage from './pages/attendance/AttendancePage'
import PayrollPage from './pages/payroll/PayrollPage'
import CycleDetailPage from './pages/payroll/CycleDetailPage'
import PayslipPage from './pages/payroll/PayslipPage'
import ExpensesPage from './pages/expenses/ExpensesPage'
import ApprovalsPage from './pages/approvals/ApprovalsPage'
import ActivitiesPage from './pages/activities/ActivitiesPage'
import ExitsPage from './pages/exits/ExitsPage'
import ExitDetailPage from './pages/exits/ExitDetailPage'
import SalarySetupPage from './pages/salary/SalarySetupPage'
import LeaveTypesPage from './pages/leave/LeaveTypesPage'
import SecurityPage from './pages/SecurityPage'
import SsoCallbackPage from './pages/SsoCallbackPage'
import SettingsPage from './pages/SettingsPage'
import { ToastProvider } from './components/ui/Toast'
import { ErrorBoundary, NotFoundPage, ComingSoonPage } from './pages/system/StatusPages'

const HR = ['hr_admin', 'system_admin']
const STAFF = ['hr_admin', 'payroll_admin', 'compliance_officer']
const gate = (roles: string[], el: React.ReactNode) => <ProtectedRoute roles={roles}>{el}</ProtectedRoute>

export default function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <ToastProvider>
            <BrowserRouter>
              <Routes>
                <Route path="/login" element={<LoginPage />} />
                <Route path="/auth/sso" element={<SsoCallbackPage />} />
                <Route path="/" element={<ProtectedRoute><AppShell /></ProtectedRoute>}>
                  <Route index element={<Navigate to="/dashboard" replace />} />
                  <Route path="dashboard" element={<DashboardPage />} />
                  <Route path="employees" element={gate(HR, <EmployeeListPage />)} />
                  <Route path="employees/:id" element={<EmployeeProfilePage />} />
                  <Route path="leave" element={<LeavePage />} />
                  <Route path="leave-types" element={gate(['hr_admin'], <LeaveTypesPage />)} />
                  <Route path="attendance" element={<AttendancePage />} />
                  <Route path="payroll" element={<PayrollPage />} />
                  <Route path="payroll/cycles/:id" element={gate(STAFF, <CycleDetailPage />)} />
                  <Route path="payroll/payslips/:id" element={<PayslipPage />} />
                  <Route path="expenses" element={<ExpensesPage />} />
                  <Route path="approvals" element={gate(['manager', ...HR], <ApprovalsPage />)} />
                  <Route path="activities" element={<ActivitiesPage />} />
                  <Route path="exits" element={<ExitsPage />} />
                  <Route path="exits/:id" element={<ExitDetailPage />} />
                  <Route path="compensation" element={gate(STAFF, <SalarySetupPage />)} />
                  <Route path="security" element={<SecurityPage />} />
                  <Route path="settings" element={<SettingsPage />} />
                  <Route path="soon/:slug" element={<ComingSoonPage />} />
                  <Route path="*" element={<NotFoundPage />} />
                </Route>
              </Routes>
            </BrowserRouter>
          </ToastProvider>
        </AuthProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  )
}
