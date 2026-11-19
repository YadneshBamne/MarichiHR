import path from 'path'
import { createStarterStructure } from './salary.mongo'

// The starter templates stay as they are; creating the starter structure writes to MongoDB.
// The original is loaded by absolute path: Node caches './starter.service' per directory, which would hand this file back to itself.
const original = require(path.join(__dirname, 'starter.service'))
export const starterFor: typeof import('./starter.service').starterFor = original.starterFor
export const TEMPLATES = original.TEMPLATES
export const CONTRACTOR = original.CONTRACTOR
export { createStarterStructure }
