import mongoose from 'mongoose'

// The company's "attendance starts on" day (YYYY-MM-DD), or null. MongoDB API only; the nightly absent marking skips earlier days.
export async function attendanceStartsOn(tenantId: string): Promise<string | null> {
  if (process.env.DB_PROVIDER !== 'mongo') return null
  try {
    const t: any = await mongoose.connection.collection('tenants').findOne({ _id: tenantId } as any, { projection: { attendanceStartsOn: 1 } })
    return /^\d{4}-\d{2}-\d{2}$/.test(t?.attendanceStartsOn ?? '') ? t.attendanceStartsOn : null
  } catch {
    return null
  }
}
