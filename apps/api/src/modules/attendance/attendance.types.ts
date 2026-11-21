export interface ClockInDto {
  locationId?: string
  latitude?: number
  longitude?: number
  method?: 'web' | 'mobile' | 'biometric' | 'qr' | 'nfc'
  notes?: string
  qrToken?: string
  at?: Date // the moment of the punch when it is not "now" (a biometric terminal sends its own timestamps)
}

export interface ClockOutDto {
  latitude?: number
  longitude?: number
  method?: 'web' | 'mobile' | 'biometric' | 'qr' | 'nfc'
  at?: Date
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
