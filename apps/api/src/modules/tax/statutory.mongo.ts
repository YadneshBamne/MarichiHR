import { useStatutoryRows } from './statutory'
import { StatutoryTable } from '../../infrastructure/mongo/mongo'

// Point the statutory-table loader at MongoDB (the calculators themselves are unchanged). Safe to call more than once.
export const enableMongoStatutory = () =>
  useStatutoryRows(async () => (await StatutoryTable.find({}).lean()).map((r: any) => ({ code: r.code, effectiveFrom: r.effectiveFrom, params: r.params, tenantId: r.tenantId ?? null })))
