/**
 * Two notice sounds ("update": an AI left something new; "decide": something needs the owner's
 * decision), each with an A and a B variant, as plain recipes — a list of partials, where a
 * partial is one oscillator with its own glide and envelope. Deliberately DOM-free (no
 * `AudioContext`): `renderToSamples` here renders a recipe to plain PCM with nothing but math, so
 * it runs in Node (previews, tests) exactly as it does in the browser. `sound-player.ts` renders
 * the same recipes in real time through Web Audio — kept separate so this module, and the tests
 * that import it directly, never need the DOM lib.
 */

export type Wave = 'sine' | 'triangle'

export interface Partial {
  wave: Wave
  /** Hz at the partial's own start. */
  f0: number
  /** Hz at the partial's own end; equal to `f0` for no glide. */
  f1: number
  /** Seconds from the sound's own start. */
  start: number
  /** Seconds this partial lasts (attack + decay + the final taper), from `start`. */
  dur: number
  /** Peak gain, 0..1 — roughly −18 dBFS is 0.126. */
  peak: number
  /** Seconds to ramp up to `peak`, linearly; kept ≥ 0.004 so the onset never clicks. */
  attack: number
  /** Exponential decay time constant (seconds) after the attack. */
  decay: number
}

export type SoundRecipe = Partial[]
export type SoundKind = 'update' | 'decide'
export type Variant = 'A' | 'B'

/** The last stretch of every partial always tapers linearly to exactly 0, so a hard
 *  stop never clicks even when the exponential decay hasn't reached silence yet. */
const RELEASE = 0.003

/** A soft droplet: one sine sliding down, like a single drop landing — the quietest of the four. */
const UPDATE_A: SoundRecipe = [{ wave: 'sine', f0: 880, f1: 660, start: 0, dur: 0.25, peak: 0.07, attack: 0.006, decay: 0.09 }]

/** A muted wooden "tock": a short triangle thud plus a brief higher click for the knock's attack. */
const UPDATE_B: SoundRecipe = [
  { wave: 'triangle', f0: 210, f1: 185, start: 0, dur: 0.12, peak: 0.065, attack: 0.004, decay: 0.02 },
  { wave: 'triangle', f0: 900, f1: 820, start: 0, dur: 0.035, peak: 0.02, attack: 0.004, decay: 0.006 },
]

/** Two rising notes like a spoken question: E5 then A5. */
const DECIDE_A: SoundRecipe = [
  { wave: 'sine', f0: 659.25, f1: 659.25, start: 0, dur: 0.18, peak: 0.11, attack: 0.005, decay: 0.05 },
  { wave: 'sine', f0: 880, f1: 880, start: 0.2, dur: 0.2, peak: 0.13, attack: 0.005, decay: 0.06 },
]

/** A gentle rising third (one continuous glide, not two notes) with a soft, quieter second harmonic. */
const DECIDE_B: SoundRecipe = [
  { wave: 'sine', f0: 659.25, f1: 783.99, start: 0, dur: 0.4, peak: 0.12, attack: 0.006, decay: 0.12 },
  { wave: 'sine', f0: 1318.5, f1: 1567.98, start: 0, dur: 0.4, peak: 0.04, attack: 0.006, decay: 0.1 },
]

export const RECIPES: Record<SoundKind, Record<Variant, SoundRecipe>> = {
  update: { A: UPDATE_A, B: UPDATE_B },
  decide: { A: DECIDE_A, B: DECIDE_B },
}

/** How long a recipe runs, start to silence. */
export function recipeLength(recipe: SoundRecipe): number {
  return recipe.reduce((max, p) => Math.max(max, p.start + p.dur), 0)
}

/** The envelope's gain at `t` seconds into one partial (0 before start and after `dur`). */
function envelopeAt(p: Partial, t: number): number {
  if (t < 0 || t > p.dur) return 0
  const v = t < p.attack ? p.peak * (t / p.attack) : p.peak * Math.exp(-(t - p.attack) / p.decay)
  const release = Math.min(RELEASE, p.dur)
  return t > p.dur - release ? v * ((p.dur - t) / release) : v
}

/** The phase (radians) swept from 0 to `t` seconds into a partial gliding exponentially from
 *  `f0` to `f1` over `dur` — the integral of `2π·f(t)`, so the pitch sweeps smoothly with no
 *  phase discontinuity at either end. */
function phaseAt(p: Partial, t: number): number {
  if (p.f0 === p.f1) return 2 * Math.PI * p.f0 * t
  const k = Math.log(p.f1 / p.f0) / p.dur
  return ((2 * Math.PI * p.f0) / k) * (Math.exp(k * t) - 1)
}

/** `asin(sin(x))` is exactly a triangle wave of amplitude π/2 — cheaper and alias-free enough
 *  for these short, low partials, with nothing sharp enough to need band-limiting. */
function waveAt(wave: Wave, phase: number): number {
  return wave === 'sine' ? Math.sin(phase) : (2 / Math.PI) * Math.asin(Math.sin(phase))
}

/**
 * Renders a recipe to mono PCM samples in -1..1, at `sampleRate` (44.1kHz for previews and
 * tests). Pure — no Web Audio, so it runs in Node as much as in the browser.
 */
export function renderToSamples(recipe: SoundRecipe, sampleRate = 44100): Float32Array {
  const n = Math.ceil(recipeLength(recipe) * sampleRate)
  const out = new Float32Array(n)
  for (const p of recipe) {
    const i0 = Math.max(0, Math.floor(p.start * sampleRate))
    const i1 = Math.min(n, Math.ceil((p.start + p.dur) * sampleRate))
    for (let i = i0; i < i1; i++) {
      const t = i / sampleRate - p.start
      out[i] += envelopeAt(p, t) * waveAt(p.wave, phaseAt(p, t))
    }
  }
  return out
}

/** Which sound a notice kind calls for, if any — only the two the owner asked to hear something
 *  for: an AI leaving a reply or picking up a brief ("update"), or a decision needing the owner
 *  ("decide"). Clock-driven notices (a check-back day, a milestone, an uncollected answer) stay
 *  silent; they aren't an AI doing something. */
export function soundForNotice(kind: string): SoundKind | null {
  if (kind === 'replied' || kind === 'claimed') return 'update'
  if (kind === 'decision') return 'decide'
  return null
}

export interface CoalesceState {
  /** `0` means "nothing played yet". */
  lastAt: number
  lastKind: SoundKind | null
}

export const INITIAL_COALESCE_STATE: CoalesceState = { lastAt: 0, lastKind: null }

const COALESCE_WINDOW_MS = 5000

/**
 * At most one sound plays in any 5-second window. A `kind` arriving inside the window after an
 * "update" already played is still let through if it is "decide" — the more important of the two
 * — on the idea that the owner should hear about a decision even right after an update chimed;
 * anything else inside the window is dropped. Pure, so the policy is tested with no audio, no
 * timers and no DOM.
 */
export function shouldPlaySound(now: number, kind: SoundKind, state: CoalesceState): { play: boolean; next: CoalesceState } {
  const withinWindow = state.lastAt !== 0 && now - state.lastAt < COALESCE_WINDOW_MS
  if (!withinWindow) return { play: true, next: { lastAt: now, lastKind: kind } }
  if (kind === 'decide' && state.lastKind === 'update') return { play: true, next: { lastAt: now, lastKind: 'decide' } }
  return { play: false, next: state }
}
