# MarichiHR

Multi-company HRMS: employees, attendance, leave, payroll, expenses and offboarding, with self-serve company signup, per-company apps, role-based portals (owner/HR, payroll/finance, manager, employee) and maker-checker payroll.

## Stack

- **apps/api**: Node.js, Express, TypeScript, Prisma, PostgreSQL (Neon), Redis (Upstash) with BullMQ for events and scheduled jobs
- **apps/web**: React 19, Vite, TypeScript, TanStack Query, GSAP
- **packages/database**: Prisma schema, migrations and seed scripts
- npm workspaces (use npm, not pnpm or yarn)

## Setup

Requirements: Node.js 20+, a PostgreSQL database (Neon works out of the box) and a Redis instance (Upstash works out of the box).

```bash
npm install
```

Create the environment files from the examples and fill them in:

```bash
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
```

`apps/api/.env` needs at least `DATABASE_URL`, `DIRECT_URL`, `REDIS_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` and `BANK_ENCRYPTION_KEY` (the example file shows how to generate the secrets). Google sign-in, Resend email and WhatsApp are optional.

Apply the migrations and generate the Prisma client (the API keeps its own copy of the schema):

```bash
cd packages/database
npx prisma migrate deploy        # with apps/api/.env loaded into the environment
npx prisma generate
cp prisma/schema.prisma ../../apps/api/prisma/schema.prisma
cd ../../apps/api && npx prisma generate
```

Optional demo data: `npm run seed --workspace=packages/database` (see the seed scripts for the demo logins).

## Run

```bash
npm run dev:api    # API on http://localhost:4000 (health: /health)
npm run dev:web    # web app on http://localhost:5173
```

Open http://localhost:5173 and choose **Get started** to create a company, or sign in with a seeded account.

## Tests

HTTP suites run against a running API and the configured database:

```bash
cd apps/api
node -r dotenv/config tests/http/roles.test.js
node -r dotenv/config tests/http/onboarding.test.js
node -r dotenv/config tests/http/hardening.test.js
node -r dotenv/config tests/http/salary-admin.test.js
FNF_MONTH=2030-01 node -r dotenv/config tests/http/exits.test.js
CYCLE_MONTH=2030-02 node -r dotenv/config tests/http/expenses.test.js
```

`exits` and `expenses` create a payroll cycle for the given month; pick a month that has no cycle yet.

## Security notes

- Never commit `.env` files; only the `.env.example` templates belong in git.
- Bank account numbers and MFA secrets are encrypted with `BANK_ENCRYPTION_KEY`. Back that key up; data encrypted with it cannot be recovered without it.
