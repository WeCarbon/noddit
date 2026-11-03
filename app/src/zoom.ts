/**
 * Pan/zoom state for the image viewer. `scale` 1 is "fit window"; `x`/`y` are a screen-pixel
 * offset applied after the scale (so panning isn't itself scaled) — see viewer.tsx, where the
 * image's `transform-origin` is pinned to its own top-left corner to match this math.
 */
export interface ZoomState {
  scale: number
  x: number
  y: number
}

export const ZOOM_MIN = 1
export const ZOOM_MAX = 8
export const FIT: ZoomState = { scale: ZOOM_MIN, x: 0, y: 0 }

/**
 * `z` rescaled to `scale`, keeping the point `relX, relY` away from the image's current
 * on-screen top-left corner fixed on screen. Clamped to [`ZOOM_MIN`, `ZOOM_MAX`]; snaps back
 * to `FIT` (no pan) at the bottom of that range.
 */
export function zoomTo(z: ZoomState, scale: number, relX: number, relY: number): ZoomState {
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale))
  if (next <= ZOOM_MIN) return FIT
  const k = next / z.scale
  return { scale: next, x: z.x + relX * (1 - k), y: z.y + relY * (1 - k) }
}

/**
 * `z` pulled back so the image — `fitW`×`fitH` at scale 1 — never drifts past a `viewW`×`viewH`
 * viewport by more than half its own overflow. No pan at `ZOOM_MIN`.
 */
export function clampPan(z: ZoomState, fitW: number, fitH: number, viewW: number, viewH: number): ZoomState {
  if (z.scale <= ZOOM_MIN) return FIT
  const maxX = Math.max(0, (fitW * z.scale - viewW) / 2)
  const maxY = Math.max(0, (fitH * z.scale - viewH) / 2)
  return { ...z, x: Math.min(maxX, Math.max(-maxX, z.x)), y: Math.min(maxY, Math.max(-maxY, z.y)) }
}
