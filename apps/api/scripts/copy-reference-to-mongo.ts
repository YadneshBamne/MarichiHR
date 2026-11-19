import { prisma } from '../src/infrastructure/database/prisma'
import { connectMongo, syncMongoIndexes, SalaryRuleCategory, StatutoryTable } from '../src/infrastructure/mongo/mongo'
import mongoose from 'mongoose'

// One-off, repeatable copy of the shared reference data (salary rule categories and the shared statutory tables) from Postgres to
// MongoDB. Company-specific tax versions are not copied: Mongo workspaces start with none. Run: npx ts-node --files scripts/copy-reference-to-mongo.ts
;(async () => {
  await connectMongo()
  await syncMongoIndexes()
  const cats = await prisma.salaryRuleCategory.findMany()
  for (const c of cats) await SalaryRuleCategory.updateOne({ code: c.code }, { $setOnInsert: { _id: c.id }, $set: { name: c.name, sequence: c.sequence } }, { upsert: true })
  const tables = await prisma.statutoryTable.findMany({ where: { tenantId: null } })
  for (const t of tables) {
    await StatutoryTable.updateOne({ code: t.code, effectiveFrom: t.effectiveFrom, tenantId: null }, {
      $setOnInsert: { _id: t.id },
      $set: { country: t.country, name: t.name, params: t.params, sourceUrl: t.sourceUrl, sourceNote: t.sourceNote, verified: t.verified },
    }, { upsert: true })
  }
  console.log(`copied ${cats.length} categories and ${tables.length} statutory tables`)
  await mongoose.disconnect()
  await prisma.$disconnect()
})().catch((e) => { console.error(e.message); process.exit(1) })
