import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import morgan from 'morgan'
import { errorMiddleware } from './middleware/error.middleware'
import { redactSensitiveResponse } from './middleware/redact.middleware'
import { authRouter } from './modules/auth/auth.router'
import { employeeRouter } from './modules/employees/employees.router'
import { leaveRouter } from './modules/leave/leave.router'
import { attendanceRouter } from './modules/attendance/attendance.router'
import { activitiesRouter } from './modules/activities/activities.router'
import { salaryRouter } from './modules/salary/salary.router'
import { payrollRouter } from './modules/payroll/payroll.router'
import { expensesRouter } from './modules/expenses/expenses.router'
import { exitsRouter } from './modules/exits/exits.router'
import { notificationsRouter, systemRouter } from './modules/notifications/notifications.router'
import { companyRouter } from './modules/company/company.router'
import { holidaysRouter } from './modules/holidays/holidays.router'
import { announcementsRouter } from './modules/announcements/announcements.router'
import { policiesRouter } from './modules/policies/policies.router'
import { grievancesRouter } from './modules/grievances/grievances.router'
import { dashboardRouter } from './modules/dashboard/dashboard.router'
import { authenticate } from './middleware/auth.middleware'
import { requireModule } from './middleware/module.middleware'

export function createApp() {
  const app = express()
  // Behind Render's proxy: trust the configured number of hops so req.ip is the visitor, not the proxy (see clientIp)
  const hops = Number(process.env.TRUST_PROXY ?? (process.env.NODE_ENV === 'production' ? 1 : 0))
  if (hops > 0) app.set('trust proxy', hops)

  app.use(helmet())
  app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:5173', credentials: true, exposedHeaders: ['Content-Disposition'] }))
  app.use(redactSensitiveResponse)
  app.use(express.json({ limit: '10mb' }))
  app.use(express.urlencoded({ extended: true }))

  if (process.env.NODE_ENV === 'development') {
    app.use(morgan('dev'))
  }

  app.get('/health', (_, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV,
      version: '1.0.0',
      modules: ['auth', 'employees', 'leave', 'attendance', 'activities', 'salary', 'payroll', 'expenses', 'exits', 'notifications'],
    })
  })

  app.use('/api/v1/auth', authRouter)
  app.use('/api/v1/employees', employeeRouter)
  // Installable apps are gated per company; contracts (under /leave) belong to core employment records
  app.use('/api/v1/leave', authenticate, requireModule('leave', ['/contracts']), leaveRouter)
  app.use('/api/v1/attendance', authenticate, requireModule('attendance'), attendanceRouter)
  app.use('/api/v1/activities', activitiesRouter)
  app.use('/api/v1/salary', authenticate, requireModule('payroll'), salaryRouter)
  app.use('/api/v1/payroll', authenticate, requireModule('payroll'), payrollRouter)
  app.use('/api/v1/expenses', authenticate, requireModule('expenses'), expensesRouter)
  app.use('/api/v1/exits', authenticate, requireModule('exits'), exitsRouter)
  app.use('/api/v1/company', companyRouter)
  app.use('/api/v1/holidays', holidaysRouter)
  app.use('/api/v1/announcements', announcementsRouter)
  app.use('/api/v1/policies', policiesRouter)
  app.use('/api/v1/grievances', grievancesRouter)
  app.use('/api/v1/dashboard', dashboardRouter)
  app.use('/api/v1/notifications', notificationsRouter)
  app.use('/api/v1/system', systemRouter)

  app.use(errorMiddleware)
  return app
}
