import type { SoundRecipe } from './sounds.ts'

/**
 * A notice sound's variant is either a synthesized recipe, or (N291: once the owner picks one of
 * the CC0 candidates attached to the node) a small bundled audio file under `app/public/` — the
 * two play through the same `Player`, from the same (sound, variant) slot, so picking a file for
 * a variant is a one-line change in `notice-sound.ts`'s `SOURCES`, not a new settings concept.
 */
export type SoundSource = { kind: 'recipe'; recipe: SoundRecipe } | { kind: 'file'; url: string }

/**
 * The Web Audio side of `sounds.ts`'s recipes — kept out of that module so it (and the tests
 * that import it directly, outside the DOM lib) never needs `AudioContext`. A small, reusable
 * chain: a shared gentle lowpass (nothing a recipe plays needs more than ~3kHz — skipped for a
 * file, which carries its own tone) into a master gain the volume setting controls, into
 * `destination`. `play` schedules one oscillator + gain envelope per partial for a recipe,
 * starting now; a file is fetched and decoded once, then played straight into the master gain.
 */
export interface Player {
  setVolume(v: number): void
  play(source: SoundSource): void
}

export function createPlayer(ctx: AudioContext, destination: AudioNode = ctx.destination): Player {
  const master = ctx.createGain()
  master.gain.value = 1
  const lowpass = ctx.createBiquadFilter()
  lowpass.type = 'lowpass'
  lowpass.frequency.value = 3200
  master.connect(lowpass)
  lowpass.connect(destination)

  const fileCache = new Map<string, Promise<AudioBuffer>>()
  function decodedFile(url: string): Promise<AudioBuffer> {
    let p = fileCache.get(url)
    if (!p) {
      p = fetch(url)
        .then((r) => r.arrayBuffer())
        .then((buf) => ctx.decodeAudioData(buf))
      fileCache.set(url, p)
    }
    return p
  }

  function playRecipe(recipe: SoundRecipe) {
    const at = ctx.currentTime
    for (const p of recipe) {
      const osc = ctx.createOscillator()
      osc.type = p.wave
      const gain = ctx.createGain()
      const start = at + p.start
      osc.frequency.setValueAtTime(p.f0, start)
      if (p.f1 !== p.f0) osc.frequency.exponentialRampToValueAtTime(p.f1, start + p.dur)
      gain.gain.setValueAtTime(0, start)
      gain.gain.linearRampToValueAtTime(p.peak, start + p.attack)
      // Approaches 0 exponentially, then a final linear ramp takes over and guarantees it
      // actually reaches exactly 0 by `dur` — a bare setTargetAtTime never does, which clicks.
      gain.gain.setTargetAtTime(0, start + p.attack, p.decay)
      gain.gain.linearRampToValueAtTime(0, start + p.dur)
      osc.connect(gain)
      gain.connect(master)
      osc.start(start)
      osc.stop(start + p.dur + 0.02)
    }
  }

  function playFile(url: string) {
    // Best-effort: a slow first fetch or a decode failure just means this one chime stays
    // silent, same as any other playback error this module already swallows.
    void decodedFile(url)
      .then((buffer) => {
        const src = ctx.createBufferSource()
        src.buffer = buffer
        src.connect(master)
        src.start()
      })
      .catch(() => {})
  }

  return {
    setVolume(v) {
      master.gain.value = Math.max(0, Math.min(1, v))
    },
    play(source) {
      if (source.kind === 'file') playFile(source.url)
      else playRecipe(source.recipe)
    },
  }
}
