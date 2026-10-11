export const PAYROLL_CONFIG = {
  HALF_DAY_LWP_FACTOR: 0.5,
  VARIANCE_THRESHOLD: 0.10,
  STANDARD_HOURS_PER_DAY: 8,
  DEFAULT_WORKING_DAYS: [0, 1, 2, 3, 4],
}

// REPLACE WITH YOUR CHART OF ACCOUNTS
export const GL_ACCOUNTS = {
  SALARY_EXPENSE: { code: '5000', name: 'Salaries & Wages Expense' },
  EMPLOYER_CONTRIB_EXPENSE: { code: '5010', name: 'Employer Statutory Contributions Expense' },
  NET_PAYABLE: { code: '2100', name: 'Net Salaries Payable' },
  TAX_PAYABLE: { code: '2110', name: 'PAYE Payable' },
  DEDUCTIONS_PAYABLE: { code: '2120', name: 'Employee Deductions Payable' },
  EMPLOYER_CONTRIB_PAYABLE: { code: '2130', name: 'Employer Contributions Payable' },
  // REPLACE WITH YOUR CHART OF ACCOUNTS
  REIMBURSEMENT_EXPENSE: { code: '5020', name: 'Employee Reimbursements Expense' },
}
