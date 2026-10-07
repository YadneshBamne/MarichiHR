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
