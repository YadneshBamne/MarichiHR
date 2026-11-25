import { useEffect } from 'react'

// Talks to the public careers API (no sign-in). Plain fetch with credentials omitted: nothing is sent or stored in cookies.
const API = (import.meta.env.MARICHI_API_URL as string | undefined) || 'http://localhost:4000/api/v1'

export type CareersCompany = { name: string; logoUrl: string | null; headline: string; intro: string; applyNote: string; contactEmail: string | null }
export type CareersOpening = {
  id: string; title: string; department: string | null; location: string | null; employmentType: string; employmentTypeLabel: string
  postedAt: string; excerpt: string; description?: string; salary: { min: number; max: number; currency: string } | null
}

export class CareersError extends Error {
  status: number
  code?: string
  fields?: Record<string, string>
  constructor(message: string, status: number, code?: string, fields?: Record<string, string>) { super(message); this.status = status; this.code = code; this.fields = fields }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try { res = await fetch(`${API}/public/careers${path}`, { credentials: 'omit', ...init }) } catch { throw new CareersError('We could not reach the server. Check your connection and try again.', 0, 'NETWORK') }
  const body: any = await res.json().catch(() => null)
  if (!res.ok) throw new CareersError(body?.message || 'Something went wrong. Please try again.', res.status, body?.code, body?.details?.fields)
  return body.data as T
}

export const getCompany = (slug: string) => call<{ company: CareersCompany; openings: CareersOpening[] }>(`/${encodeURIComponent(slug)}`)
export const getOpening = (slug: string, id: string) => call<{ company: CareersCompany; opening: CareersOpening }>(`/${encodeURIComponent(slug)}/openings/${encodeURIComponent(id)}`)
export const applyTo = (slug: string, id: string, form: FormData) => call<{ received: boolean; company: string; role: string }>(`/${encodeURIComponent(slug)}/openings/${encodeURIComponent(id)}/apply`, { method: 'POST', body: form })

// Page title and description for the tab and for link previews (the page is a single-page app, so they are set when it loads)
export function useDocMeta(title: string, description?: string) {
  useEffect(() => {
    const before = document.title
    document.title = title
    let tag = document.querySelector<HTMLMetaElement>('meta[name="description"]')
    const had = !!tag, old = tag?.content ?? ''
    if (!tag) { tag = document.createElement('meta'); tag.name = 'description'; document.head.appendChild(tag) }
    if (description) tag.content = description
    return () => { document.title = before; if (!had) tag!.remove(); else tag!.content = old }
  }, [title, description])
}

export const postedText = (iso: string) => {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (days <= 0) return 'Posted today'
  if (days === 1) return 'Posted yesterday'
  if (days < 30) return `Posted ${days} days ago`
  return `Posted ${new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`
}
export const salaryText = (s: NonNullable<CareersOpening['salary']>) => `${s.currency} ${s.min.toLocaleString()} to ${s.max.toLocaleString()} a year`
