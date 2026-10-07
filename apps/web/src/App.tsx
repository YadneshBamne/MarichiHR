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

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              path="/"
              element={
                <ProtectedRoute>
                  <AppShell />
                </ProtectedRoute>
              }
            >
              <Route index element={<Navigate to="/dashboard" replace />} />
              <Route path="dashboard" element={<DashboardPage />} />
              <Route path="employees" element={<EmployeeListPage />} />
              <Route path="employees/:id" element={<EmployeeProfilePage />} />
              <Route path="leave" element={<LeavePage />} />
              <Route path="attendance" element={<AttendancePage />} />
              <Route path="payroll" element={<PayrollPage />} />
              <Route path="payroll/cycles/:id" element={<CycleDetailPage />} />
              <Route path="payroll/payslips/:id" element={<PayslipPage />} />
              <Route path="expenses" element={<ExpensesPage />} />
              <Route path="approvals" element={<ApprovalsPage />} />
              <Route path="activities" element={<ActivitiesPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  )
}
