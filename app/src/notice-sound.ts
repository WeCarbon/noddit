import type { SoundSettings } from './backend.ts'
import { createPlayer, type Player, type SoundSource } from './sound-player.ts'
import { INITIAL_COALESCE_STATE, RECIPES, shouldPlaySound, soundForNotice, type SoundKind, type Variant } from './sounds.ts'

/**
 * Which source plays for each (sound, variant) slot — a recipe for every one of them today.
 * N291: once the owner picks a CC0 candidate attached to the node for a given sound, that one
 * entry becomes `{ kind: 'file', url: '/sounds/<name>.ogg' }` (the file landing under
 * `app/public/sounds/`, with its LICENSE/attribution note) — the settings UI's A/B picker and
 * the rest of this module stay exactly as they are; only this map changes.
 */
const SOURCES: Record<SoundKind, Record<Variant, SoundSource>> = {
  update: { A: { kind: 'recipe', recipe: RECIPES.update.A }, B: { kind: 'recipe', recipe: RECIPES.update.B } },
  decide: { A: { kind: 'recipe', recipe: RECIPES.decide.A }, B: { kind: 'recipe', recipe: RECIPES.decide.B } },
}

/**
 * The Web Audio side of the two notice sounds, for this window only — each window (the main one,
 * the banner) has its own `AudioContext` and its own 5-second coalescing window; see N291's app
 * wiring notes for why that never double-plays. Built lazily (and resumed on every call) since a
 * browser/WebView may suspend an `AudioContext` created before any user gesture.
 */
let player: Player | null = null
let coalesce = INITIAL_COALESCE_STATE

function thePlayer(): Player | null {
  if (player) return player
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctx) return null
  try {
    player = createPlayer(new Ctx())
  } catch {
    return null
  }
  return player
}

/** This window is in front: the owner is looking at it right now. Same check `notify()` in
 *  `bench.tsx` uses for where a visual notice goes, plus the same e2e escape hatch. */
function windowInFront(): boolean {
  return (document.hasFocus() && document.visibilityState === 'visible') || document.documentElement.dataset.e2eFront === '1'
}

/**
 * Plays `sound`, if any of these hold it back: its own on/off is off, "update" while this window
 * is in front (the owner is already looking at it), or the 5-second coalescing window swallowed
 * it. The low-level entry point — for a `kind` already resolved to "update"/"decide", the way
 * the app side's own `play-sound` event (sent for a system-style or hidden-banner notice, which
 * never otherwise reaches this window) names it directly.
 */
export function playSound(sound: SoundKind, settings: SoundSettings): void {
  if (sound === 'update' && !settings.updateOn) return
  if (sound === 'decide' && !settings.decideOn) return
  if (sound === 'update' && windowInFront()) return
  const { play, next } = shouldPlaySound(Date.now(), sound, coalesce)
  coalesce = next
  if (!play) return
  const p = thePlayer()
  if (!p) return
  p.setVolume(settings.volume)
  const variant = sound === 'update' ? settings.updateVariant : settings.decideVariant
  p.play(SOURCES[sound][variant])
}

/** Same, from a `Notice`'s own `kind` (`replied`, `decision`, …) — maps it to "update"/"decide"
 *  first (silent if neither, e.g. a check-back or milestone reminder). */
export function playNoticeSound(kind: string, settings: SoundSettings): void {
  const sound = soundForNotice(kind)
  if (sound) playSound(sound, settings)
}

/** The settings dialog's "试听" button: always plays, ignoring on/off, focus and coalescing —
 *  it is the owner explicitly asking to hear it right now. */
export function previewSound(kind: SoundKind, variant: Variant, volume: number): void {
  const p = thePlayer()
  if (!p) return
  p.setVolume(volume)
  p.play(SOURCES[kind][variant])
}
