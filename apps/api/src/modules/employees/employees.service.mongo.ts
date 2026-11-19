import { employeeService as core } from './employees.mongo'
import { employeeExtras } from './employees.org.mongo'

// What the Postgres employees.service exports, served from MongoDB: the core employee service with the not-yet-ported
// skills and resume lines on top, plus access, org chart, org units, positions, locations and the Masters hub.
export * from './employees.mongo'
export * from './employees.org.mongo'
export const employeeService = { ...core, ...employeeExtras }
