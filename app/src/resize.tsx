import { inDesktop, invoke } from './backend.ts'

const EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const

/**
 * Thin handles along the window's edges and corners. The system resizes from the very
 * edge too; these give the edges a hit area and the right cursor whatever the page
 * underneath does with the mouse.
 */
export function ResizeEdges() {
  if (!inDesktop) return null
  return (
    <div class="rz" aria-hidden="true">
      {EDGES.map((edge) => (
        <div key={edge} class={`rz-${edge}`} onPointerDown={(e) => drag(e, edge)} />
      ))}
    </div>
  )
}

function drag(e: PointerEvent, edge: string) {
  if (e.button !== 0) return
  e.preventDefault()
  e.stopPropagation()
  const el = e.currentTarget as HTMLElement
  el.setPointerCapture(e.pointerId)
  const sx = e.screenX
  const sy = e.screenY
  const ready = invoke('resize_begin')
  let pending: { dx: number; dy: number } | null = null
  let sending = false
  // One resize in flight at a time; the latest position wins.
  const flush = async () => {
    if (sending || !pending) return
    sending = true
    const next = pending
    pending = null
    try {
      await ready
      await invoke('resize_to', { edge, dx: next.dx, dy: next.dy })
    } catch {
      /* the window is gone or busy; the next move tries again */
    }
    sending = false
    void flush()
  }
  const move = (m: PointerEvent) => {
    pending = { dx: m.screenX - sx, dy: m.screenY - sy }
    void flush()
  }
  const up = () => {
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', up)
    el.removeEventListener('pointercancel', up)
  }
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', up)
  el.addEventListener('pointercancel', up)
}
