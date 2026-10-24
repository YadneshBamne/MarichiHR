import { useSyncExternalStore } from 'react'
import { hi } from './i18n/hi'
import { bem } from './i18n/bem'

// Interface language. Phrase-based: the English text is the key, so anything without a translation simply stays
// English. Two layers use it:
//  - tr() in code that builds labels (navigation, page titles, the command palette, greetings)
//  - a DOM translator that swaps exact-match UI strings (buttons, labels, headings, placeholders) as React renders
// ponytail: exact-match DOM translation covers fixed UI text only; sentences with names or numbers in them need tr()
// at the call site. Adding a language = one dictionary file + an entry in LANGS.
export const LANGS = { en: 'English', hi: 'हिन्दी (Hindi)', bem: 'Icibemba (draft)' } as const
export type Lang = keyof typeof LANGS
const DICTS: Record<Lang, Record<string, string>> = { en: {}, hi, bem }

const read = (): Lang => { try { const l = localStorage.getItem('lang') as Lang | null; if (l && l in LANGS) return l } catch { /* private mode */ } return navigator.language?.startsWith('hi') ? 'hi' : 'en' }
let current: Lang = typeof window === 'undefined' ? 'en' : read()
const listeners = new Set<() => void>()

export const tr = (s: string) => DICTS[current][s] ?? s
export const getLang = () => current
export function setLang(l: Lang) {
  if (l === current) return
  current = l
  try { localStorage.setItem('lang', l) } catch { /* private mode */ }
  document.documentElement.lang = l === 'bem' ? 'bem' : l
  retranslate()
  listeners.forEach((f) => f())
}
export const useLang = () => useSyncExternalStore((f) => { listeners.add(f); return () => listeners.delete(f) }, () => current)

// ─── DOM layer ───────────────────────────────────────────────────────────────────────────────────────────────
// Keeps the original English on the node so a language change (or React re-render) can always translate afresh
const ORIG = new WeakMap<Node, string>()
const ATTRS = ['placeholder', 'title', 'aria-label']
const SKIP = '[data-no-i18n], script, style, code, textarea'
function translateText(n: Text) {
  if (n.parentElement?.closest(SKIP)) return
  const raw = n.nodeValue ?? ''
  const key = raw.trim()
  if (!key || key.length > 120) return
  const known = ORIG.get(n)
  // React wrote new text since we last translated: that is the new English original
  const original = known !== undefined && (raw === known || Object.values(DICTS).some((d) => d[known.trim()] === key)) ? known : raw
  ORIG.set(n, original)
  const t = DICTS[current][original.trim()]
  const next = t ? original.replace(original.trim(), t) : original
  if (next !== raw) n.nodeValue = next
}
function translateEl(el: Element) {
  if (el.closest(SKIP)) return
  for (const a of ATTRS) {
    const v = el.getAttribute(a)
    if (!v) continue
    const k = `data-i18n-${a}`
    const original = el.getAttribute(k) ?? v
    if (!el.hasAttribute(k)) el.setAttribute(k, v)
    const next = DICTS[current][original] ?? original
    if (next !== v) el.setAttribute(a, next)
  }
}
function walk(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) return translateText(root as Text)
  if (root.nodeType !== Node.ELEMENT_NODE) return
  const el = root as Element
  if (el.closest(SKIP)) return
  translateEl(el)
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
  for (let n = w.nextNode(); n; n = w.nextNode()) n.nodeType === Node.TEXT_NODE ? translateText(n as Text) : translateEl(n as Element)
}
function retranslate() { if (typeof document !== 'undefined') walk(document.body) }
let observer: MutationObserver | null = null
export function startDomTranslation() {
  if (observer || typeof MutationObserver === 'undefined') return
  document.documentElement.lang = current
  observer = new MutationObserver((records) => {
    if (current === 'en' && !records.length) return
    for (const r of records) {
      if (r.type === 'characterData') translateText(r.target as Text)
      else if (r.type === 'attributes') translateEl(r.target as Element)
      else r.addedNodes.forEach(walk)
    }
  })
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS })
  retranslate()
}

// Time-of-day greeting, translated
export const greeting = (h: number) => tr(h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening')
