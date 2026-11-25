import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createSwapy } from 'swapy'
import api from '../../lib/api'

// A grid of cards the person can rearrange: drag any card onto any other and the two trade places, the way Swapy works out of the box.
// The slots keep their places and sizes; the card that lands in a slot takes that slot's size (the cards are built to fit any width).
// The arrangement is saved for the person (PUT /dashboard/layout) and reloaded on any device. A card the saved layout does not know (a new one)
// takes the first free slot, and a card that is gone leaves its slot to the next card.
export type CardSize = 'kpi' | 'half' | 'full'
// render(compact): a card in a small (kpi) slot is drawn as a compact tile (its key number), so one tall card never stretches a row of tiles
export type CardDef = { id: string; size: CardSize; title: string; render: (compact: boolean) => ReactNode }
const SPAN: Record<CardSize, string> = { kpi: 'span-3', half: 'span-6', full: 'span-12' }

// Slots are places in the grid, numbered and sized in the default order of the cards
export function resolveSlots(cards: CardDef[], saved: Record<string, string> | null | undefined) {
  const slots = cards.map((c, i) => ({ id: `slot-${i}`, size: c.size }))
  const byId = new Map(cards.map((c) => [c.id, c]))
  const used = new Set<string>(), out: Record<string, string> = {}
  for (const s of slots) { const id = saved?.[s.id]; if (id && byId.has(id) && !used.has(id)) { out[s.id] = id; used.add(id) } }
  const free = cards.filter((c) => !used.has(c.id))
  for (const s of slots) if (!out[s.id]) { const c = free.shift(); if (c) out[s.id] = c.id }
  return { slots, map: out }
}

export default function SwapGrid({ cards, saved, onSaved }: { cards: CardDef[]; saved: Record<string, string> | null | undefined; onSaved: (slots: Record<string, string> | null) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const sig = cards.map((c) => c.id).join('|')
  const [reset, setReset] = useState(0)
  const [moved, setMoved] = useState(false)
  // Where each card starts. After that Swapy owns the positions (it moves the DOM), so this is only recomputed when the card set or a reset changes.
  const { slots, map } = useMemo(() => resolveSlots(cards, reset ? null : saved), [sig, reset]) // eslint-disable-line react-hooks/exhaustive-deps
  const byId = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards])
  // which cards currently sit in a small slot (they draw their compact tile)
  const sizeOfSlot = useMemo(() => new Map(slots.map((s) => [s.id, s.size])), [slots])
  const compactFor = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([slot, id]) => [id, sizeOfSlot.get(slot) === 'kpi']))
  const [compact, setCompact] = useState<Record<string, boolean>>(() => compactFor(map))
  useEffect(() => setCompact(compactFor(map)), [map]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = box.current
    if (!el) return
    const swapy = createSwapy(el, { animation: 'dynamic', swapMode: 'hover', autoScrollOnDrag: true })
    // while a card is dragged nothing on the page may get selected (the blue highlight)
    const off = () => document.body.classList.remove('swapping')
    swapy.onSwapStart(() => document.body.classList.add('swapping'))
    swapy.onSwapEnd(({ hasChanged, slotItemMap }) => {
      off()
      if (!hasChanged) return
      const next = slotItemMap.asObject as Record<string, string>
      setCompact(compactFor(next))
      setMoved(true)
      try { localStorage.setItem('dash-tip-seen', '1') } catch { /* private window */ }
      api.put('/dashboard/layout', { slots: next }).then(() => onSaved(next)).catch(() => undefined)
    })
    window.addEventListener('pointerup', off)
    window.addEventListener('pointercancel', off)
    return () => { swapy.destroy(); window.removeEventListener('pointerup', off); window.removeEventListener('pointercancel', off); off() }
  }, [sig, reset]) // eslint-disable-line react-hooks/exhaustive-deps

  const resetLayout = () => { api.put('/dashboard/layout', { slots: null }).finally(() => { onSaved(null); setMoved(false); setReset((n) => n + 1) }) }
  const customised = moved || (!!saved && Object.keys(saved).length > 0)
  const tip = (() => { try { return !localStorage.getItem('dash-tip-seen') } catch { return false } })()
  return (
    <>
      {tip && !customised && <p className="dim" style={{ margin: '-4px 0 12px', fontSize: 12.5 }}>Tip: drag any card onto another to rearrange your dashboard.</p>}
      <div ref={box} key={`${sig}:${reset}`} className="dgrid" style={{ marginBottom: 'var(--gap)' }}>
        {slots.map((s) => {
          const card = byId.get(map[s.id])
          return (
            <div key={s.id} data-swapy-slot={s.id} className={`swapy-slot ${SPAN[s.size]}`}>
              {card && <div data-swapy-item={card.id} className="swapy-item">{card.render(!!compact[card.id])}</div>}
            </div>
          )
        })}
      </div>
      {customised && <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: -6, marginBottom: 12 }}><button type="button" className="btn btn-ghost btn-sm" onClick={resetLayout}>Reset layout</button></div>}
    </>
  )
}
