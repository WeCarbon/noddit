/** Widths of the sidebar and the list; the detail pane takes the rest. */
export interface PaneWidths {
  sidebar: number
  list: number
}

export const SIDEBAR_MIN = 160
export const SIDEBAR_MAX = 400
export const LIST_MIN = 280
export const DETAIL_MIN = 380

/** Clamped so every pane keeps a usable width in a window `total` wide. */
export function clampPanes(p: PaneWidths, total: number): PaneWidths {
  const sidebar = Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, p.sidebar)))
  const listMax = Math.max(LIST_MIN, total - sidebar - DETAIL_MIN)
  const list = Math.round(Math.min(listMax, Math.max(LIST_MIN, p.list)))
  return { sidebar, list }
}

export const paneColumns = (p: PaneWidths) => `${p.sidebar}px ${p.list}px minmax(${DETAIL_MIN}px, 1fr)`

/**
 * The line between two panes: drag to move it, double-click to go back to the default
 * layout. `which` is the pane on its start side.
 */
export function Divider(p: {
  which: 'sidebar' | 'list'
  measure: () => PaneWidths
  onMove: (w: PaneWidths) => void
  onDone: (w: PaneWidths) => void
  onReset: () => void
}) {
  const down = (e: PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const start = p.measure()
    const x0 = e.clientX
    const sign = document.documentElement.dir === 'rtl' ? -1 : 1
    let last = start
    const at = (m: PointerEvent): PaneWidths => {
      const dx = (m.clientX - x0) * sign
      const raw = p.which === 'sidebar' ? { sidebar: start.sidebar + dx, list: start.list } : { sidebar: start.sidebar, list: start.list + dx }
      return clampPanes(raw, window.innerWidth)
    }
    const move = (m: PointerEvent) => {
      last = at(m)
      p.onMove(last)
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      document.documentElement.classList.remove('dragging-divider')
      p.onDone(last)
    }
    document.documentElement.classList.add('dragging-divider')
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }
  return <div class={`divider divider-${p.which}`} role="separator" aria-orientation="vertical" onPointerDown={down} onDblClick={p.onReset} />
}
