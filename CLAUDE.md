# MarichiHR — project handoff

Enterprise HRMS for Marichi Labs. Built prompt-by-prompt. npm workspaces monorepo, Windows, npm only (no pnpm).

## Stack
- apps/api: Express + TypeScript + Prisma, port 4000. Modules: auth, employees, leave, attendance, activities, salary, payroll, expenses
- apps/web: React 18 + Vite + TypeScript + TanStack Query, inline style objects, purple #534AB7
- packages/database: Prisma schema, migrations, seed scripts
- DB: Neon Postgres. Redis: Upstash (BullMQ event bus). Secrets are in apps/api/.env, never commit.

## Machine quirks
- The `dotenv` CLI resolves to a Python tool. Run Prisma and ts-node scripts with apps/api/.env variables set inline.
- apps/api keeps its own copy of the Prisma schema. After migrating in packages/database, copy the schema to apps/api and run `prisma generate` in BOTH.
- Machine timezone is IST; tenant timezone is Africa/Lusaka.

## Rules that must hold in all new code
- Every query is scoped by tenantId. Load records tenant-scoped first and return 404 on denied reads (never update({ where: { id } }) directly).
- Access helpers in apps/api/src/shared/utils/access.ts: assertProfileAccess, assertCompensationAccess, assertCanApprove (direct manager or hr_admin, never self, except an hr_admin with no manager, which is logged as SELF_APPROVAL).
- Request bodies use zod `.strict()` or an explicit whitelist. Never spread req.body into Prisma.
- Date-only values: store/query as UTC-midnight from YYYY-MM-DD; use businessDate.ts helpers; never local setHours/getDay on date-only values.
- roleIds in the JWT are role NAMES; frontend user.roles is [{id, name}], use hasRole().
- Bank account numbers are AES-256-GCM encrypted (BANK_ENCRYPTION_KEY). API never returns them, only bankAccountLast4. Never put them in audit logs.
- Payroll is immutable after disburse. Maker-checker: HR approver != finance approver; payroll inputs approved by a different user than the adder.
- Rule formulas run in a sandboxed mathjs evaluator, never eval.
- Archive pattern: `active` boolean, never is_deleted. Cross-module flows go through the domain_events table + BullMQ.

## Status
Phase 1 (auth, employees, contracts, leave, attendance, activities): done.
Phase 2 done: salary structures, payroll engine, payroll frontend, payslip PDF (Puppeteer), bank details (encrypted, maker-checker), bank file CSV, GL export, access-scope hardening (18b), Prompt 19 reimbursements + per-diem (migration add_expenses; verification pending).

## Roadmap
- Phase 2 remaining: 20 F&F settlement; 21 admin screens (salary structures/rules/grade bands/contracts UI); 22 hardening (cron + notification workers, nightly absent marking, Float to Decimal, chatter tenantId, Google SSO + MFA, leave-type config UI)
- Phase 3: versioned tax tables (real Zambia PAYE/NAPSA/NHIMA), India TDS cumulative method, Kenya/Nigeria, tax declarations + certificates, statutory filing adapter, gratuity per country
- Phase 4: incentives, policies, grievances (needs chatter tenantId first), forums
- Phase 5: dashboards, reports, audit UI, PWA, scale test

## Known open items
- No job marks absent days: days with no attendance record count as paid
- ZRA PAYE bands and NAPSA caps are PLACEHOLDERS; India TDS returns 0 until Phase 3
- Money columns are Float; move to Decimal before real payroll
- Chatter has no tenantId; unresolvable entity types are hr_admin-only
- Bank file is a generic CSV; real bank format needed. GL account codes are placeholders (config map)
- Cron jobs only run when triggered by hand; event bus has no consumer worker
- Rotate the Neon password and Upstash token, back up BANK_ENCRYPTION_KEY

## Dev logins (tenant slug: marichi-labs; passwords are in the seed scripts)
admin@marichihr.com (hr_admin + system_admin, EMP0001), finance@marichihr.com (payroll_admin, no employee record), John Banda EMP0002 (manager, reports to admin), Jane Mutale EMP0003 (reports to John, no contract)

## Test data in the DB
October 2026 payroll cycle (disbursed), December leave requests and allocations, SELF_APPROVAL audit rows, grade band ZM-E1, "Part-time Employee" structure type. Safe to leave.
