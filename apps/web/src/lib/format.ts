export function money(amount: number | null | undefined, currency = 'ZMW'): string {
  const n = Number(amount ?? 0)
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 2 }).format(n)
  } catch {
    return `${currency} ${n.toFixed(2)}`
  }
}

// Date-only strings (YYYY-MM-DD or ISO at UTC midnight) must be formatted in UTC
export function fmtDate(iso?: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

export function fmtPeriod(start: string, end: string): string {
  return `${fmtDate(start)} – ${fmtDate(end)}`
}

// Worked time as HH:MM:SS (hours keep counting past 24, e.g. a month's 168:30:00). Stored values are decimal hours.
export function fmtDuration(seconds: number): string {
  const t = Math.max(0, Math.round(seconds || 0))
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(Math.floor(t / 3600))}:${p(Math.floor((t % 3600) / 60))}:${p(t % 60)}`
}
export const fmtHours = (hours: number | null | undefined) => fmtDuration((hours || 0) * 3600)
