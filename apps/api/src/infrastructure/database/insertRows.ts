import { prisma } from './prisma'

// Insert rows into several tables in ONE SQL statement (data-modifying CTEs fed by one JSON parameter).
// Use it on hot write paths where several inserts would otherwise each pay a database round trip.
// Rows must be complete: jsonb_populate_recordset fills absent keys with NULL, not column defaults, so pass every
// NOT NULL column (ids, createdAt/updatedAt, flags with defaults). Table order is irrelevant; FKs are checked at the end.
// `extra` lets a caller add more CTEs (UPDATE/DELETE) to the same statement; its $-parameters start at $2.
export async function insertRows(rows: Record<string, Record<string, unknown>[]>, extra: { sql: string; params: unknown[] }[] = []) {
  const tables = Object.entries(rows).filter(([, r]) => r.length)
  if (!tables.length && !extra.length) return
  for (const [t] of tables) if (!/^[a-z_]+$/.test(t)) throw new Error(`Bad table name ${t}`)
  const params: unknown[] = [JSON.stringify(Object.fromEntries(tables))]
  const ctes = tables.map(([t], i) => `w${i} AS (INSERT INTO "${t}" SELECT * FROM jsonb_populate_recordset(NULL::"${t}", $1::jsonb->'${t}') RETURNING 1)`)
  extra.forEach((e, i) => {
    // Renumber the caller's $1..$n to follow the parameters already used
    const offset = params.length
    ctes.push(`x${i} AS (${e.sql.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + offset}`)})`)
    params.push(...e.params)
  })
  await prisma.$queryRawUnsafe(`WITH ${ctes.join(',\n')} SELECT 1`, ...params)
}

export const nowIso = () => new Date().toISOString()
