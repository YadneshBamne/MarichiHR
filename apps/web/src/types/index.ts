export interface User {
  id: string
  email: string
  fullName: string
  avatarUrl?: string
  mfaEnabled?: boolean
  tourDoneAt?: string | null
  mustChangePassword?: boolean
  roles: { id: string; name: string }[]
  employee: {
    id: string
    code: string
    firstName: string
    lastName: string
    orgUnit?: { id: string; name: string; type: string }
    jobPosition?: { id: string; title: string }
    manager?: { user: { fullName: string } }
  } | null
  tenant: {
    id: string
    name: string
    slug: string
    baseCurrency?: string
    timezone?: string
    logoUrl?: string | null
    modules?: string[]
    onboardedAt?: string | null
    ownerUserId?: string | null
  }
}

export interface ApiResponse<T> {
  success: boolean
  data: T
}

export interface PaginatedResponse<T> {
  success: boolean
  data: T[]
  meta: {
    total: number
    page: number
    limit: number
    totalPages: number
    hasNext: boolean
    hasPrev: boolean
  }
}

export interface Employee {
  id: string
  employeeCode: string
  firstName: string
  lastName: string
  workEmail: string
  employmentType: string
  employmentStatus: string
  hireDate: string
  active: boolean
  orgUnit?: { id: string; name: string }
  jobPosition?: { id: string; title: string }
  workLocation?: { id: string; name: string; city: string }
  manager?: { user: { fullName: string; avatarUrl?: string } }
  user?: { email: string; avatarUrl?: string; lastLoginAt?: string }
  bankName?: string | null
  bankAccountLast4?: string | null
  bankIfscSwift?: string | null
  bankVerified?: boolean
  _count?: { contracts: number; leaveRequests: number; attendanceRecords: number }
}

export interface LeaveBalance {
  leaveType: string
  code: string
  isPaid: boolean
  available: number
  used: number
  pending: number
  total: number
}

export interface LeaveRequest {
  id: string
  leaveTypeId: string
  startDate: string
  endDate: string
  totalDays: number
  status: string
  reason?: string
  leaveType: { name: string; code: string }
  appliedAt: string
}

export interface AttendanceRecord {
  id: string
  date: string
  checkInTime?: string
  checkOutTime?: string
  workedHours?: number
  overtimeHours?: number
  status: string
  checkInMethod?: string
  isLocked: boolean
}

export interface DashboardData {
  employee: {
    id: string
    leaveBalances: LeaveBalance[]
    todayAttendance: {
      clockedIn: boolean
      clockedOut: boolean
      status: string
      workedHours: number
      checkInTime?: string
      checkOutTime?: string
    }
    pendingActivities: number
    recentLeaveRequests: LeaveRequest[]
  }
  manager?: {
    teamSize: number
    pendingLeaveApprovals: number
    pendingRegularisations: number
  }
}
