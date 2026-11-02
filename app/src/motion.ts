import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'

const GLIDE_MS = 260
/** Rows that rose in one refresh move one after another, this far apart. */
const STAGGER_MS = 70
const MAX_STAGGER = 6

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * 实时: when rows change places, each glides from where it was (FLIP) and a row that rose
 * lights up, then fades back. Scrolled down, the rows on screen stay put and the count of
 * the ones that arrived above comes back instead (`above`, cleared by `toTop`).
 * `keys` is the list's node keys in order; `on` turns the whole thing off for other lists.
 */
export function useLiveMotion(list: { current: HTMLElement | null }, keys: string[], on: boolean, reset: unknown): { above: number; toTop: () => void; arrived: Map<string, number> } {
  const tops = useRef<Map<string, number>>(new Map())
  const anchor = useRef<{ key: string; offset: number } | null>(null)
  const [above, setAbove] = useState(0)
  // Rows lit up as they land, with how long each waits for its turn; drawn by the list itself.
  const [arrived, setArrived] = useState<Map<string, number>>(new Map())
  const clearLit = useRef<number | undefined>(undefined)
  const order = keys.join('\n')

  // Another list (or this one switched off): nothing to glide from.
  const shownFor = useRef<unknown>(undefined)
  if (shownFor.current !== reset || !on) {
    shownFor.current = on ? reset : undefined
    tops.current = new Map()
    anchor.current = null
  }
  useEffect(() => setAbove(0), [reset, on])

  // Which row sits at the top of the visible part, and how far into it: kept on scroll so a refresh can hold it there.
  useEffect(() => {
    const el = list.current
    if (!el || !on) return
    const remember = () => {
      if (el.scrollTop <= 4) {
        anchor.current = null
        setAbove(0)
        return
      }
      const row = [...el.querySelectorAll<HTMLElement>('.row.node[data-key]')].find((r) => r.offsetTop + r.offsetHeight > el.scrollTop)
      anchor.current = row ? { key: row.dataset.key!, offset: row.offsetTop - el.scrollTop } : null
    }
    el.addEventListener('scroll', remember, { passive: true })
    return () => el.removeEventListener('scroll', remember)
  }, [on, list.current])

  useLayoutEffect(() => {
    const el = list.current
    if (!el || !on) return
    const rows = [...el.querySelectorAll<HTMLElement>('.row.node[data-key]')]
    const before = tops.current
    const now = new Map(rows.map((r) => [r.dataset.key!, r.offsetTop]))
    tops.current = now
    if (!before.size) return

    // Scrolled down: keep the row the reader was on where it was, and say how many arrived above it.
    const held = anchor.current
    if (held && now.has(held.key)) {
      const wasAt = before.get(held.key)
      const isAt = now.get(held.key)!
      if (wasAt !== undefined && isAt !== wasAt) el.scrollTop = isAt - held.offset
      const risen = rows.filter((r) => {
        const k = r.dataset.key!
        const was = before.get(k)
        return now.get(k)! < isAt && (was === undefined || was > (wasAt ?? isAt))
      }).length
      if (risen) setAbove((n) => n + risen)
    }

    if (reducedMotion()) return
    const lit = new Map<string, number>()
    let rank = 0
    for (const r of rows) {
      const k = r.dataset.key!
      const was = before.get(k)
      const is = now.get(k)!
      if (was === undefined || was > is + 1) {
        // Came in, or rose: in turn, top first, and lit up as it lands.
        const delay = Math.min(rank++, MAX_STAGGER) * STAGGER_MS
        r.style.transition = 'none'
        r.style.transform = was === undefined ? 'translateY(-12px)' : `translateY(${was - is}px)`
        r.style.opacity = was === undefined ? '0' : ''
        r.getBoundingClientRect()
        r.style.transition = `transform ${GLIDE_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1) ${delay}ms, opacity ${GLIDE_MS}ms ease ${delay}ms`
        r.style.transform = ''
        r.style.opacity = ''
        lit.set(k, delay)
      } else if (was !== is) {
        // Pushed down by the ones above: just glides.
        r.style.transition = 'none'
        r.style.transform = `translateY(${was - is}px)`
        r.getBoundingClientRect()
        r.style.transition = `transform ${GLIDE_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)`
        r.style.transform = ''
      }
    }
    if (lit.size) {
      setArrived(lit)
      clearTimeout(clearLit.current)
      clearLit.current = window.setTimeout(() => setArrived(new Map()), 1700 + Math.max(...lit.values()))
    }
  }, [order, on])

  const toTop = () => {
    list.current?.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' })
    anchor.current = null
    setAbove(0)
  }
  return { above, toTop, arrived }
}
