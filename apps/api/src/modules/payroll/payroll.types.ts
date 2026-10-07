export interface CreateCycleDto {
  payPeriodStart: string
  payPeriodEnd: string
  cycleType?: 'monthly' | 'bi_weekly' | 'weekly'
}

export interface AddPayrollInputDto {
  employeeId: string
  inputTypeId: string
  amount: number
  description?: string
}
