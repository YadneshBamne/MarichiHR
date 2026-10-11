// Live check of the configured document storage: upload, signed download, privacy (no anonymous access), delete.
// Run from apps/api with the .env loaded:  npx ts-node --transpile-only scripts/storage-check.ts
// Prints no keys or URLs with signatures.
import 'dotenv/config'
import { storage } from '../src/infrastructure/storage/storage'

;(async () => {
  const s = storage()
  const key = `healthcheck/${Date.now()}.txt`
  const body = Buffer.from(`MarichiHR storage check ${new Date().toISOString()}`)
  const step = (name: string, ok: boolean, extra = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` (${extra})` : ''}`)
  try {
    await s.put(key, body, 'text/plain')
    step(`upload to ${s.provider}`, true)
    step('the file exists', await s.exists(key))
    const url = await s.signedUrl(key, 60, 'check.txt')
    const got = await fetch(url)
    step('signed URL downloads the same bytes', got.ok && (await got.text()) === body.toString(), `HTTP ${got.status}`)
    const bare = url.split('?')[0]
    const anon = await fetch(bare)
    step('the same file without a signature is refused (bucket is private)', anon.status === 403 || anon.status === 401 || anon.status === 404, `HTTP ${anon.status}`)
    const expired = await s.signedUrl(key, 5, 'check.txt')
    await new Promise((r) => setTimeout(r, 12000)) // allows a few seconds of clock difference with the provider
    const late = await fetch(expired)
    step('a signed URL stops working after it expires', !late.ok, `HTTP ${late.status}`)
  } finally {
    await s.remove(key).catch((e) => console.log('FAIL  delete:', e?.name ?? e))
    step('delete removes it', !(await s.exists(key)))
  }
})().catch((e) => { console.log('FAIL ', e?.name || '', e?.message?.slice(0, 200)); process.exit(1) })
