import { useLayoutEffect, useRef, useState } from 'react'
import { APPS, type AppKey } from '../../lib/apps'
import { gsap, reduced, pop } from '../../lib/motion'
import Icon from '../ui/Icon'

// ─── Logo: picked file is cropped to a square and resized to 256px in the browser, then sent as a small data URL ──
export function CompanyLogo({ name, src, size = 40 }: { name: string; src?: string | null; size?: number }) {
  if (src) return <img src={src} alt="" style={{ width: size, height: size, borderRadius: size * 0.3, objectFit: 'cover', flexShrink: 0, background: 'var(--card-2)' }} />
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?'
  return <span aria-hidden="true" style={{ width: size, height: size, borderRadius: size * 0.3, background: 'var(--night)', color: 'var(--honey)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: size * 0.4, flexShrink: 0 }}>{initials}</span>
}

async function toLogoDataUrl(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|webp|gif|bmp|svg\+xml)$/.test(file.type)) throw new Error('Choose a PNG, JPEG or WebP image')
  if (file.size > 8 * 1024 * 1024) throw new Error('That image is over 8 MB')
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Could not read that image')); i.src = url })
    const side = Math.min(img.naturalWidth, img.naturalHeight)
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 256
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 256, 256)
    const webp = canvas.toDataURL('image/webp', 0.88)
    return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png')
  } finally { URL.revokeObjectURL(url) }
}

export function LogoPicker({ name, value, onChange }: { name: string; value: string | null; onChange: (v: string | null) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const preview = useRef<HTMLDivElement>(null)
  const [error, setError] = useState('')
  const [drag, setDrag] = useState(false)
  const take = async (file?: File) => {
    if (!file) return
    setError('')
    try { onChange(await toLogoDataUrl(file)); pop(preview.current, 0.7) } catch (e: any) { setError(e.message) }
  }
  return (
    <div>
      <div onDragOver={(e) => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); take(e.dataTransfer.files[0]) }}
        style={{ display: 'flex', alignItems: 'center', gap: 16, padding: 16, borderRadius: 20, border: `1.5px dashed ${drag ? 'var(--honey)' : 'var(--line-2)'}`, background: drag ? 'var(--honey-soft)' : 'var(--card-2)', transition: 'all .3s var(--ease)' }}>
        <div ref={preview}><CompanyLogo name={name || 'Company'} src={value} size={72} /></div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 500, fontSize: 14 }}>Company logo</div>
          <div className="dim" style={{ fontSize: 12, marginTop: 2 }}>Drop an image here or choose one. It's cropped to a square.</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => input.current?.click()}><Icon name="download" size={13} style={{ transform: 'rotate(180deg)' }} /> {value ? 'Replace' : 'Upload'}</button>
            {value && <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange(null)}>Remove</button>}
          </div>
        </div>
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { take(e.target.files?.[0]); e.target.value = '' }} />
      </div>
      {error && <div role="alert" style={{ color: 'var(--danger)', fontSize: 12, marginTop: 6 }}>{error}</div>}
    </div>
  )
}

// ─── Company profile fields ──────────────────────────────────────────────────
export interface CompanyDraft { name: string; legalName: string; industry: string; companySize: string; primaryCountry: string; baseCurrency: string; timezone: string; fiscalYearStartMonth: number; logoUrl: string | null }

export const COUNTRIES: [string, string, string][] = [
  ['ZM', 'Zambia', 'ZMW'], ['IN', 'India', 'INR'], ['KE', 'Kenya', 'KES'], ['NG', 'Nigeria', 'NGN'], ['ZA', 'South Africa', 'ZAR'], ['TZ', 'Tanzania', 'TZS'],
  ['UG', 'Uganda', 'UGX'], ['GH', 'Ghana', 'GHS'], ['AE', 'United Arab Emirates', 'AED'], ['GB', 'United Kingdom', 'GBP'], ['US', 'United States', 'USD'], ['SG', 'Singapore', 'SGD'],
  ['DE', 'Germany', 'EUR'], ['FR', 'France', 'EUR'], ['NL', 'Netherlands', 'EUR'], ['AU', 'Australia', 'AUD'], ['CA', 'Canada', 'CAD'],
]
const TZ_BY_COUNTRY: Record<string, string> = { ZM: 'Africa/Lusaka', IN: 'Asia/Kolkata', KE: 'Africa/Nairobi', NG: 'Africa/Lagos', ZA: 'Africa/Johannesburg', TZ: 'Africa/Dar_es_Salaam', UG: 'Africa/Kampala', GH: 'Africa/Accra', AE: 'Asia/Dubai', GB: 'Europe/London', US: 'America/New_York', SG: 'Asia/Singapore', DE: 'Europe/Berlin', FR: 'Europe/Paris', NL: 'Europe/Amsterdam', AU: 'Australia/Sydney', CA: 'America/Toronto' }
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const timeZones: string[] = (() => { try { return (Intl as any).supportedValuesOf('timeZone') } catch { return Object.values(TZ_BY_COUNTRY) } })()

export function CompanyFields({ draft, set }: { draft: CompanyDraft; set: (patch: Partial<CompanyDraft>) => void }) {
  const pickCountry = (code: string) => {
    const c = COUNTRIES.find((x) => x[0] === code)
    set({ primaryCountry: code, ...(c && { baseCurrency: c[2], timezone: TZ_BY_COUNTRY[code] ?? draft.timezone }) })
  }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
      <div className="field" style={{ gridColumn: '1 / -1' }}><label htmlFor="c-name">Company name</label><input id="c-name" className="input" value={draft.name} onChange={(e) => set({ name: e.target.value })} required maxLength={80} /></div>
      <div className="field"><label htmlFor="c-legal">Legal name <span className="muted">(optional)</span></label><input id="c-legal" className="input" value={draft.legalName} onChange={(e) => set({ legalName: e.target.value })} placeholder="e.g. Acme Works Ltd" /></div>
      <div className="field"><label htmlFor="c-ind">Industry <span className="muted">(optional)</span></label><input id="c-ind" className="input" value={draft.industry} onChange={(e) => set({ industry: e.target.value })} placeholder="e.g. Software, Retail" /></div>
      <div className="field"><label htmlFor="c-size">Company size</label>
        <select id="c-size" className="select input" value={draft.companySize} onChange={(e) => set({ companySize: e.target.value })}>
          <option value="">Choose…</option>{['1-10', '11-50', '51-200', '201-1000', '1000+'].map((s) => <option key={s} value={s}>{s} people</option>)}
        </select></div>
      <div className="field"><label htmlFor="c-country">Main country</label>
        <select id="c-country" className="select input" value={draft.primaryCountry} onChange={(e) => pickCountry(e.target.value)}>
          <option value="">Choose…</option>{COUNTRIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
        </select></div>
      <div className="field"><label htmlFor="c-cur">Currency</label><input id="c-cur" className="input" value={draft.baseCurrency} maxLength={3} onChange={(e) => set({ baseCurrency: e.target.value.toUpperCase() })} /></div>
      <div className="field"><label htmlFor="c-tz">Time zone</label>
        <select id="c-tz" className="select input" value={draft.timezone} onChange={(e) => set({ timezone: e.target.value })}>
          {[...new Set([draft.timezone, ...timeZones])].map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
        </select></div>
      <div className="field"><label htmlFor="c-fy">Financial year starts</label>
        <select id="c-fy" className="select input" value={draft.fiscalYearStartMonth} onChange={(e) => set({ fiscalYearStartMonth: Number(e.target.value) })}>
          {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
        </select></div>
    </div>
  )
}

export const draftFrom = (t: any): CompanyDraft => ({
  name: t?.name ?? '', legalName: t?.legalName ?? '', industry: t?.industry ?? '', companySize: t?.companySize ?? '', primaryCountry: t?.primaryCountry ?? '',
  baseCurrency: t?.baseCurrency ?? 'USD', timezone: t?.timezone && t.timezone !== 'UTC' ? t.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  fiscalYearStartMonth: t?.fiscalYearStartMonth ?? 1, logoUrl: t?.logoUrl ?? null,
})

export const draftToBody = (d: CompanyDraft) => ({
  name: d.name.trim(), legalName: d.legalName.trim() || null, industry: d.industry.trim() || null, companySize: d.companySize || null,
  ...(d.primaryCountry && { primaryCountry: d.primaryCountry }), baseCurrency: d.baseCurrency, timezone: d.timezone, fiscalYearStartMonth: d.fiscalYearStartMonth, logoUrl: d.logoUrl,
})

// ─── App picker (Odoo-style install cards) ───────────────────────────────────
export function AppPicker({ value, onChange }: { value: AppKey[]; onChange: (v: AppKey[]) => void }) {
  const grid = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (grid.current && !reduced()) gsap.fromTo(grid.current.children, { opacity: 0, y: 20, scale: 0.97 }, { opacity: 1, y: 0, scale: 1, duration: 0.6, ease: 'power3.out', stagger: 0.06, clearProps: 'opacity,transform' })
  }, [])
  const toggle = (k: AppKey, el: HTMLElement) => { onChange(value.includes(k) ? value.filter((x) => x !== k) : [...value, k]); pop(el.querySelector('[data-tick]'), 0.5) }
  return (
    <div ref={grid} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: 'var(--gap)' }}>
      {APPS.map((a) => {
        const on = value.includes(a.key)
        return (
          <button key={a.key} type="button" role="checkbox" aria-checked={on} onClick={(e) => toggle(a.key, e.currentTarget)} className="card lift"
            style={{ textAlign: 'left', padding: 20, border: on ? '1.5px solid var(--night)' : '1px solid var(--hair)', background: on ? 'var(--solid)' : 'var(--card)', position: 'relative' }}>
            <span data-tick style={{ position: 'absolute', top: 16, right: 16, width: 26, height: 26, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: on ? 'var(--night)' : 'transparent', border: on ? 'none' : '1.5px solid var(--line-2)', color: 'var(--honey)' }}>
              {on && <Icon name="check" size={14} stroke={2.4} />}
            </span>
            <span style={{ width: 48, height: 48, borderRadius: 16, background: a.tint, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><Icon name={a.icon} size={22} /></span>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 21, marginTop: 14 }}>{a.name}</div>
            <div className="dim" style={{ fontSize: 13, marginTop: 4, lineHeight: 1.45 }}>{a.tagline}</div>
            <ul style={{ listStyle: 'none', marginTop: 12, display: 'flex', flexDirection: 'column', gap: 5 }}>
              {a.features.map((f) => <li key={f} style={{ display: 'flex', gap: 7, fontSize: 12, alignItems: 'center' }} className="dim"><Icon name="check" size={12} style={{ color: 'var(--ok)' }} /> {f}</li>)}
            </ul>
          </button>
        )
      })}
    </div>
  )
}
