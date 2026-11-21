import { encryptField, decryptField } from '../../shared/utils/crypto'

// Face matching on the server. The browser reads a face and turns it into a list of numbers (an "embedding", made by the free
// @vladmandic/human library); the server only compares those lists. A face is never rebuilt from them, and they are stored encrypted.
// Advisory by design: the numbers come from the browser, so a low score only flags the punch for a person to look at.
export type Strictness = 'relaxed' | 'normal' | 'strict'
// Starting points taken from the library's own guidance (similarity above 0.5 is a likely match). Tune with real scores from the review screen.
export const THRESHOLD: Record<Strictness, number> = { relaxed: 0.5, normal: 0.6, strict: 0.7 }
export const MAX_SAMPLES = 8

// The same formula as human.match.similarity (euclidean, multiplier 25, range 0.2 to 0.8), so scores mean what the library says.
export function similarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length < 64) return 0
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2
  const dist = Math.round(100 * 25 * sum) / 100
  if (dist === 0) return 1
  const norm = (1 - Math.sqrt(dist) / 100 - 0.2) / 0.6
  return Math.round(100 * Math.max(Math.min(norm, 1), 0)) / 100
}

// Accepts a JSON string or an array; returns null unless it is a plausible embedding (64 to 2048 finite numbers)
export function parseEmbedding(raw: unknown): number[] | null {
  let v: unknown = raw
  if (typeof raw === 'string') { try { v = JSON.parse(raw) } catch { return null } }
  if (!Array.isArray(v) || v.length < 64 || v.length > 2048 || !v.every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  return v as number[]
}
export const parseEmbeddings = (raw: unknown, max: number): number[][] => {
  let v: unknown = raw
  if (typeof raw === 'string') { try { v = JSON.parse(raw) } catch { return [] } }
  return Array.isArray(v) ? v.slice(0, max).map(parseEmbedding).filter((e): e is number[] => !!e) : []
}

export const seal = (e: number[]) => encryptField(JSON.stringify(e.map((n) => Math.round(n * 1e5) / 1e5)))
export function open(sealed: string[] | undefined): number[][] {
  try { return (sealed ?? []).map((s) => JSON.parse(decryptField(s)) as number[]) } catch { return [] }
}
export const bestScore = (samples: number[][], probe: number[]) => samples.reduce((m, s) => Math.max(m, similarity(s, probe)), 0)

if (require.main === module) {
  process.env.BANK_ENCRYPTION_KEY ||= 'a'.repeat(64)
  const a = Array.from({ length: 128 }, (_, i) => Math.sin(i)), far = a.map((x) => -x * 3), near = a.map((x) => x + 0.001)
  console.assert(similarity(a, a) === 1, 'identical lists score 1')
  console.assert(similarity(a, near) > 0.9, 'a tiny change still matches')
  console.assert(similarity(a, far) < 0.3, 'a very different list scores low')
  console.assert(similarity(a, a.slice(1)) === 0, 'lists of different length never match')
  console.assert(parseEmbedding(JSON.stringify(a))?.length === 128 && parseEmbedding('[1,2]') === null && parseEmbedding('nope') === null, 'bad input is refused')
  const back = open([seal(a)])
  console.assert(back.length === 1 && similarity(back[0], a) > 0.99, 'sealed values open again')
  console.assert(open(['v1:junk']).length === 0, 'a bad sealed value gives no samples instead of throwing')
  console.log('face.match self-check done')
}
