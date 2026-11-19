import mongoose from 'mongoose'
import { payrollService } from './payroll.mongo'
import { renderPayslipHtml } from './payslip.pdf'
import * as m from '../../infrastructure/mongo/mongo'
import { bootstrapCompany } from '../company/company.bootstrap.mongo'
import { createStarterStructure } from '../salary/salary.mongo'
import { contractService } from '../employees/contracts.mongo'
import { employeeService } from '../employees/employees.mongo'

// Self-check for the MongoDB payroll flow. Run (needs the reference data copy; creates a workspace, then deletes it):
//   node -r dotenv/config -r ts-node/register/transpile-only src/modules/payroll/payroll.mongo.check.ts
;(async () => {
  await m.connectMongo()
  await m.syncMongoIndexes()
  const slug = `paycheck-${Date.now()}`
  const { tenantId, userId } = await bootstrapCompany({ companyName: 'Paycheck Ltd', slug, email: `${slug}@example.com`, fullName: 'Owner One', passwordHash: 'x' })
  const status = async (p: Promise<any>) => p.then(() => 0, (e) => e.statusCode ?? e.status ?? -1)
  const [A, B, C] = ['admin-a', 'admin-b', 'admin-c']
  try {
    await m.Tenant.updateOne({ _id: tenantId }, { primaryCountry: 'ZM', baseCurrency: 'ZMW' })
    const zm: any = await createStarterStructure(tenantId, userId)
    const unit: any = await m.OrgUnit.findOne({ tenantId }).lean()
    const mk = async (first: string, wage: number) => {
      const e: any = (await employeeService.create(tenantId, { firstName: first, lastName: 'Test', workEmail: `${first}.${slug}@example.com`, orgUnitId: unit._id, hireDate: '2026-10-01', employmentType: 'full_time' } as any, userId)).employee
      const c: any = await contractService.create({ employeeId: e.id, ctcAnnual: wage * 12, wageMonthly: wage, currency: 'ZMW', effectiveFrom: '2026-10-01', salaryStructureId: zm.id } as any, tenantId, userId)
      for (const to of ['draft', 'confirmed', 'running'] as const) await contractService.transition(c.id, to, tenantId, userId)
      return e
    }
    const ruth = await mk('Ruth', 10000), joseph = await mk('Joseph', 20000)
    await employeeService.updateBank(ruth.id, tenantId, A, { bankName: 'FNB', bankAccountNo: '62012345678' })
    await employeeService.verifyBank(ruth.id, tenantId, B)

    console.assert((await status(payrollService.createCycle(tenantId, A, { payPeriodStart: '2026-11-30', payPeriodEnd: '2026-11-01' } as any))) === 400, 'start after end is refused')
    const cycle: any = await payrollService.createCycle(tenantId, A, { payPeriodStart: '2026-11-01', payPeriodEnd: '2026-11-30' } as any)
    console.assert(cycle.status === 'draft', 'cycle starts as draft')
    console.assert((await status(payrollService.createCycle(tenantId, A, { payPeriodStart: '2026-11-15', payPeriodEnd: '2026-12-15' } as any))) === 409, 'overlapping period is 409')
    console.assert((await status(payrollService.runCycle(cycle.id, tenantId, A))) === 400, 'cannot run before attendance is locked')
    await payrollService.lockAttendance(cycle.id, tenantId, A)
    const [r1, r2] = await Promise.all([status(payrollService.runCycle(cycle.id, tenantId, A)), status(payrollService.runCycle(cycle.id, tenantId, A))])
    console.assert([r1, r2].filter((x) => x === 0).length === 1, 'two runs started at once: exactly one wins')
    const run: any = await payrollService.runCycle(cycle.id, tenantId, A)
    console.assert(run.processed === 2 && run.skipped.length === 1 && /No running contract/.test(run.skipped[0].reason), 'two paid, the owner (no contract) is skipped')
    const slips: any[] = await payrollService.listCyclePayslips(cycle.id, tenantId)
    const sRuth = slips.find((s) => s.employeeId === ruth.id), sJoseph = slips.find((s) => s.employeeId === joseph.id)
    const line = (s: any, c: string) => s.lines?.find((l: any) => l.code === c)?.amount
    console.assert(sRuth.netPay === 8114 && sRuth.grossEarnings === 10000, `Ruth K10,000 -> net 8,114 (got ${sRuth.netPay})`)
    console.assert(sJoseph.grossEarnings === 20000 && sJoseph.netPay === 13854, `Joseph K20,000: PAYE 5,026 + NAPSA 1,000 + NHIMA 120 -> net 13,854 (got ${sJoseph.netPay})`)
    console.assert(!('bankAccountNo' in sRuth.employee) && sRuth.employee.hasBankAccount === true, 'the cycle list never returns the encrypted account number')
    const full: any = await payrollService.getPayslip(sRuth.id, { tenantId, employeeId: '', roleIds: ['payroll_admin'] })
    console.assert(line(full, 'NAPSA_EMPLOYER') > 0 && line(full, 'BASIC') === 6000 && full.workedDays.length === 4, 'staff see employer lines, basic is 60%, four worked-day rows')

    // inputs: maker-checker, then a re-run picks the approved bonus up
    const types: any[] = await m.PayrollInputType.find({ tenantId, active: true }).lean()
    const bonusType = types.find((t) => t.category !== 'deductions') ?? types[0]
    const inp: any = await payrollService.addInput(cycle.id, tenantId, A, { employeeId: ruth.id, inputTypeId: bonusType._id, amount: 500, description: 'Bonus' } as any)
    console.assert((await status(payrollService.approveInput(inp.id, tenantId, A))) === 403, 'cannot approve your own input')
    await payrollService.approveInput(inp.id, tenantId, B)
    await payrollService.runCycle(cycle.id, tenantId, A)
    const ruth2: any = (await payrollService.listCyclePayslips(cycle.id, tenantId)).find((s: any) => s.employeeId === ruth.id)
    console.assert(ruth2.grossEarnings === 10500 && ruth2.hasManualInputs, `the approved input reached the payslip (gross ${ruth2.grossEarnings})`)
    const variance: any = await payrollService.getVarianceReport(cycle.id, tenantId)
    console.assert(variance.rows.find((r: any) => r.employeeId === joseph.id).flags.includes('no_bank_details') && variance.rows.find((r: any) => r.employeeId === ruth.id).flags.includes('manual_input'), 'variance flags missing bank and manual inputs')

    // approvals
    console.assert((await status(payrollService.financeApprove(cycle.id, tenantId, B))) === 400, 'second approval needs the first')
    await payrollService.approve(cycle.id, tenantId, A)
    console.assert((await status(payrollService.financeApprove(cycle.id, tenantId, A))) === 403, 'the same admin cannot give both approvals')
    console.assert((await status(payrollService.runCycle(cycle.id, tenantId, A))) === 400, 'an approved run cannot be re-run')
    await payrollService.reopen(cycle.id, tenantId, A)
    await payrollService.approve(cycle.id, tenantId, A)
    await payrollService.financeApprove(cycle.id, tenantId, B)
    await m.Tenant.updateOne({ _id: tenantId }, { payrollSignoffAbove: '1' })
    console.assert((await status(payrollService.disburse(cycle.id, tenantId, A))) === 400, 'above the sign-off amount, disburse is refused')
    console.assert(((await payrollService.signoffList(tenantId)) as any).cycles.length === 1, 'the sign-off list shows the cycle with totals only')
    console.assert((await status(payrollService.signoff(cycle.id, tenantId, A))) === 403, 'an approver cannot sign off')
    await payrollService.signoff(cycle.id, tenantId, C)

    // exports, then disburse
    const preview: any = await payrollService.getBankFilePreview(cycle.id, tenantId)
    console.assert(preview.included.length === 1 && preview.excluded.length === 1 && !JSON.stringify(preview).includes('62012345678'), 'bank preview: Ruth in, Joseph out, no account number shown')
    console.assert((await status(payrollService.generateBankFile(cycle.id, tenantId, A, { allowPartial: false }))) === 409, 'bank file refuses a partial list unless allowed')
    const bank: any = await payrollService.generateBankFile(cycle.id, tenantId, A, { allowPartial: true })
    console.assert(bank.csv.includes('62012345678') && bank.csv.includes('EMP0002') && bank.filename === 'bank-file-2026-11.csv', 'bank file carries the account and the code')
    const gl: any = await payrollService.generateGlExport(cycle.id, tenantId, A)
    console.assert(gl.csv.length > 50, 'GL journal balances and exports')
    const done: any = await payrollService.disburse(cycle.id, tenantId, A)
    console.assert(done.status === 'disbursed' && done.payslipsReleasedAt, 'disbursed and payslips released')
    console.assert((await status(payrollService.disburse(cycle.id, tenantId, A))) === 400 && (await status(payrollService.reopen(cycle.id, tenantId, A))) === 400, 'a disbursed run is immutable')
    console.assert((await m.Payslip.countDocuments({ payrollCycleId: cycle.id, status: 'disbursed' })) === 2, 'payslips are disbursed')

    // payslip access
    const me = { tenantId, employeeId: ruth.id, roleIds: ['employee'] }
    const mine: any[] = await payrollService.listMyPayslips(ruth.id)
    console.assert(mine.length === 1 && mine[0].payrollCycle.status === 'disbursed', 'Ruth sees her released payslip')
    const own: any = await payrollService.getPayslip(mine[0].id, me)
    console.assert(!own.lines.some((l: any) => l.category === 'EMP_CONTRIB'), 'employees never see employer contribution lines')
    console.assert((await status(payrollService.getPayslip(mine[0].id, { ...me, employeeId: joseph.id }))) === 404, 'nobody else can open it')
    await payrollService.withholdPayslip(mine[0].id, tenantId, A, true, 'query')
    console.assert((await payrollService.listMyPayslips(ruth.id)).length === 0 && (await status(payrollService.getPayslip(mine[0].id, me))) === 404, 'a held payslip disappears for the employee')
    console.assert(renderPayslipHtml(full, 'Paycheck Ltd').includes('NET PAY'), 'the payslip PDF page renders from the Mongo shape')
    console.log('payroll self-check done')
  } finally {
    const col = (n: string) => mongoose.connection.collection(n)
    const emps: any[] = await m.Employee.find({ tenantId }).select('_id').lean()
    await col('leave_balances').deleteMany({ employeeId: { $in: emps.map((e) => e._id) } } as any)
    const users: any[] = await m.User.find({ tenantId }).select('_id').lean()
    await col('refresh_tokens').deleteMany({ userId: { $in: users.map((u) => u._id) } } as any)
    for (const n of ['roles', 'users', 'org_units', 'employees', 'audit_logs', 'domain_events', 'notifications', 'employee_position_history', 'leave_types', 'activity_types', 'expense_categories', 'payroll_input_types', 'shift_templates', 'resource_calendars', 'salary_structure_types', 'salary_structures', 'grade_bands', 'employee_contracts', 'payroll_cycles', 'payslips', 'payroll_inputs']) await col(n).deleteMany({ tenantId } as any)
    await m.Tenant.deleteOne({ _id: tenantId })
    await mongoose.disconnect()
  }
})().catch((e) => { console.error(e); process.exit(1) })
