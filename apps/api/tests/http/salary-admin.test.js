// Prompt 21 verification: admin endpoints behind the salary structure / rules / grade bands / contracts screens.
const { api, tokenFor, check, done, prisma } = require('./lib')

const TAG = `P21${Date.now() % 1_000_000}`

;(async () => {
  const admin = await tokenFor('admin@marichihr.com')
  const finance = await tokenFor('finance@marichihr.com')
  const john = await tokenFor('john.banda@marichihr.com')
  const jane = await tokenFor('jane.mutale@marichihr.com')
  const cats = Object.fromEntries((await api(admin, 'GET', '/salary/rule-categories')).body.map((c) => [c.code, c.id]))

  // ─── STRUCTURE TYPES + STRUCTURES ───────────────────────────
  let r = await api(admin, 'POST', '/salary/structure-types', { name: `Type ${TAG}`, wageType: 'monthly' })
  const type = r.body
  check('create structure type', r.status === 201, r.data)
  r = await api(admin, 'POST', '/salary/structure-types', { name: `Type ${TAG}` })
  check('duplicate structure type name is 409', r.status === 409, r.data)
  r = await api(admin, 'POST', '/salary/structure-types', { name: 'x', tenantId: 'other' })
  check('strict body: tenantId rejected 400', r.status === 400, r.data)
  r = await api(finance, 'POST', '/salary/structure-types', { name: `Fin ${TAG}` })
  check('payroll_admin (no salary:write) cannot create (403)', r.status === 403, r.data)

  r = await api(admin, 'POST', '/salary/structures', { structureTypeId: type.id, name: `Structure ${TAG}`, code: TAG, countryCode: 'ZM' })
  const st = r.body
  check('create structure', r.status === 201 && st.code === TAG, r.data)
  r = await api(admin, 'POST', '/salary/structures', { structureTypeId: type.id, name: 'dup', code: TAG })
  check('duplicate structure code is 409', r.status === 409, r.data)
  r = await api(admin, 'PATCH', `/salary/structures/${st.id}`, { description: 'Edited' })
  check('update structure', r.status === 200 && r.body.description === 'Edited', r.data)

  // ─── RULES + FORMULA VALIDATION ─────────────────────────────
  const rule = (b) => api(admin, 'POST', '/salary/rules', { salaryStructureId: st.id, ...b })
  r = await rule({ categoryId: cats.BASIC, name: 'Basic', code: 'BASIC', sequence: 10, amountType: 'python_code', pythonCode: 'result = contract.wageMonthly * 0.5' })
  check('formula rule BASIC created', r.status === 201, r.data)
  r = await rule({ categoryId: cats.ALW, name: 'Bad', code: 'BAD', sequence: 20, amountType: 'python_code', pythonCode: 'result = contract.wageMonthly *' })
  check('syntax error in formula rejected 400', r.status === 400 && /BAD/.test(r.data.message), r.data)
  r = await rule({ categoryId: cats.ALW, name: 'Hack', code: 'HACK', sequence: 20, amountType: 'python_code', pythonCode: 'import({x: 1})' })
  check('sandbox: import() in formula rejected 400', r.status === 400, r.data)
  r = await rule({ categoryId: cats.ALW, name: 'Unknown', code: 'UNK', sequence: 20, amountType: 'python_code', pythonCode: 'result = salary * 2' })
  check('unknown symbol rejected 400', r.status === 400 && /salary/i.test(r.data.message), r.data)
  r = await rule({ categoryId: cats.ALW, name: 'Early', code: 'EARLY', sequence: 5, amountType: 'python_code', pythonCode: 'result = rules.BASIC * 0.1' })
  check('reference to a later rule rejected 400', r.status === 400, r.data)
  r = await rule({ categoryId: cats.ALW, name: 'Pct', code: 'PCT', sequence: 20, amountType: 'percentage', amountPercentage: 0.2, amountPercentageBase: 'NOPE' })
  check('unknown percentage base rejected 400', r.status === 400, r.data)
  r = await rule({ categoryId: cats.ALW, name: 'Basic again', code: 'BASIC', sequence: 30, amountType: 'fixed', amountFixed: 1 })
  check('duplicate rule code in structure is 409', r.status === 409, r.data)
  r = await rule({ categoryId: cats.ALW, name: 'lower', code: 'hra', sequence: 20, amountType: 'fixed', amountFixed: 1 })
  check('rule code must be UPPER_CASE (400)', r.status === 400, r.data)
  r = await rule({ categoryId: cats.ALW, name: 'HRA', code: 'HRA', sequence: 20, amountType: 'percentage', amountPercentage: 0.2, amountPercentageBase: 'BASIC' })
  const hra = r.body
  check('percentage rule on BASIC created', r.status === 201, r.data)
  r = await rule({ categoryId: cats.GROSS, name: 'Gross', code: 'GROSS', sequence: 50, amountType: 'python_code', pythonCode: 'result = categories.BASIC + categories.ALW' })
  r = await rule({ categoryId: cats.TAX, name: 'PAYE', code: 'PAYE', sequence: 60, amountType: 'python_code', pythonCode: 'result = compute_zra_paye(categories.GROSS)', conditionSelect: 'python_expression', conditionExpr: 'categories.GROSS > 1000' })
  check('conditional tax rule with compute_zra_paye created', r.status === 201, r.data)

  r = await api(admin, 'POST', '/salary/rules/check', { salaryStructureId: st.id, sampleWage: 20000, rule: { categoryId: cats.ALW, name: 'Transport', code: 'TA', sequence: 30, amountType: 'python_code', pythonCode: 'result = rules.BASIC * 0.1' } })
  check('check endpoint: TA = 10% of BASIC (10000) = 1000 on a 20000 sample', r.status === 200 && r.body.amount === 1000 && r.body.lines.some((l) => l.code === 'HRA' && l.amount === 2000), r.data)
  r = await api(admin, 'POST', '/salary/rules/check', { salaryStructureId: st.id, rule: { categoryId: cats.ALW, name: 'x', code: 'X', sequence: 30, amountType: 'python_code', pythonCode: 'result = 1 / ' } })
  check('check endpoint reports a bad formula as 400 with the reason', r.status === 400 && r.data.message.length > 0, r.data)
  r = await api(john, 'POST', '/salary/rules/check', { salaryStructureId: st.id, rule: { categoryId: cats.ALW, name: 'x', code: 'X', sequence: 30, amountType: 'fixed', amountFixed: 1 } })
  check('manager cannot use the formula check (403)', r.status === 403, r.data)

  r = await api(admin, 'PATCH', `/salary/rules/${hra.id}`, { amountType: 'python_code', pythonCode: 'result = rules.GROSS * 2' })
  check('editing HRA to reference later GROSS rejected 400', r.status === 400, r.data)
  r = await api(admin, 'PATCH', `/salary/rules/${hra.id}`, { amountPercentage: 0.25 })
  check('valid edit accepted', r.status === 200 && r.body.amountPercentage === 0.25, r.data)

  // ─── GRADE BANDS ────────────────────────────────────────────
  r = await api(admin, 'POST', '/salary/grade-bands', { code: TAG, name: 'Band', salaryMin: 100, salaryMid: 50, salaryMax: 200, currency: 'ZMW' })
  check('band with mid < min rejected 400', r.status === 400, r.data)
  r = await api(admin, 'POST', '/salary/grade-bands', { code: TAG, name: 'Band', salaryMin: 100000, salaryMid: 200000, salaryMax: 300000, currency: 'ZMW' })
  const band = r.body
  check('create band', r.status === 201, r.data)
  r = await api(admin, 'PATCH', `/salary/grade-bands/${band.id}`, { salaryMax: 150000 })
  check('update that breaks mid ≤ max rejected 400', r.status === 400, r.data)

  // ─── CONTRACTS ──────────────────────────────────────────────
  r = await api(admin, 'POST', '/leave/contracts', { ctcAnnual: 1, wageMonthly: 1, currency: 'ZMW', effectiveFrom: '2027-01-01' })
  check('contract without employeeId is 400 (was 500)', r.status === 400, r.data)
  r = await api(admin, 'POST', '/leave/contracts', { employeeId: jane.employeeId, ctcAnnual: 240000, wageMonthly: 20000, currency: 'ZMW', effectiveFrom: '2099-01-01', effectiveUntil: '2098-01-01' })
  check('contract with until < from is 400', r.status === 400, r.data)
  r = await api(admin, 'POST', '/leave/contracts', { employeeId: jane.employeeId, ctcAnnual: 240000, wageMonthly: 20000, currency: 'ZMW', effectiveFrom: '2099-01-01', salaryStructureId: st.id, gradeBandId: band.id, noticePeriodDays: 60 })
  const contract = r.body
  check('create contract with structure + band (future date, Jane untouched today)', r.status === 201 && contract.salaryStructureId === st.id && contract.gradeBandId === band.id && contract.noticePeriodDays === 60, r.data)

  const list = (await api(finance, 'GET', '/salary/contracts')).body
  const listed = list.find((c) => c.id === contract.id)
  check('contracts list (payroll_admin): includes employee, structure and band', listed && listed.employee.employeeCode === 'EMP0003' && listed.salaryStructure.code === TAG && listed.gradeBand.code === TAG, listed)
  check('contracts list is 403 for a manager', (await api(john, 'GET', '/salary/contracts')).status === 403)

  r = await api(admin, 'POST', `/leave/contracts/${contract.id}/activate`, {})
  check('state machine: new → running is refused (400)', r.status === 400, r.data)
  for (const [step, status] of [['draft', 'draft'], ['confirm', 'confirmed']]) {
    r = await api(admin, 'POST', `/leave/contracts/${contract.id}/${step}`, { reason: TAG })
    check(`contract ${step} → ${status}`, r.status === 200 && r.body.status === status, r.data)
  }
  r = await api(admin, 'POST', `/leave/contracts/${contract.id}/confirm`, { reason: TAG, extra: 1 })
  check('transition body is strict (400)', r.status === 400, r.data)

  r = await api(admin, 'PATCH', `/salary/structures/${st.id}`, { active: false })
  check('archiving a structure used by a live contract is 409', r.status === 409, r.data)

  r = await api(admin, 'POST', `/salary/contracts/${contract.id}/link-structure`, { salaryStructureId: st.id })
  check('link structure to contract', r.status === 200 && r.body.salaryStructureId === st.id, r.data)

  r = await api(admin, 'POST', `/leave/contracts/${contract.id}/cancel`, { reason: TAG })
  check('cancel the test contract', r.status === 200 && r.body.status === 'cancelled', r.data)
  const transitions = await prisma.contractStateTransition.count({ where: { contractId: contract.id } })
  check('state transitions recorded (draft, confirm, cancel)', transitions === 3, transitions)

  r = await api(admin, 'PATCH', `/salary/structures/${st.id}`, { active: false })
  check('archive structure once no live contract uses it', r.status === 200 && r.body.active === false, r.data)
  await api(admin, 'PATCH', `/salary/grade-bands/${band.id}`, { active: false })
  await api(admin, 'PATCH', `/salary/structure-types/${type.id}`, { active: false })

  await done()
})().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
