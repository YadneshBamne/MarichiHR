export interface ClockInDto {
  locationId?: string
  latitude?: number
  longitude?: number
  method?: 'web' | 'mobile' | 'biometric' | 'qr' | 'nfc'
  notes?: string
}

export interface ClockOutDto {
  latitude?: number
  longitude?: number
  method?: 'web' | 'mobile' | 'biometric' | 'qr' | 'nfc'
}

export interface RegularisationDto {
  date: string
  actualIn: string
  actualOut: string
  reason: string
}

export interface OvertimeRequestDto {
  date: string
  overtimeHours: number
  reason: string
}

export interface AttendanceOverrideDto {
  employeeId: string
  date: string
  status: 'present' | 'absent' | 'half_day' | 'on_leave' | 'holiday' | 'week_off' | 'lwp'
  reason: string
}
