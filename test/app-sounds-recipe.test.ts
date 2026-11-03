import { test } from 'node:test'
import assert from 'node:assert/strict'

import { RECIPES, recipeLength, renderToSamples, type SoundKind, type Variant } from '../app/src/sounds.ts'

const SAMPLE_RATE = 44100
const ALL: [SoundKind, Variant][] = [
  ['update', 'A'],
  ['update', 'B'],
  ['decide', 'A'],
  ['decide', 'B'],
]

for (const [kind, variant] of ALL) {
  const recipe = RECIPES[kind][variant]

  test(`${kind} ${variant}: no longer than the 0.5s notice-sound budget`, () => {
    assert.ok(recipeLength(recipe) <= 0.5, `${kind} ${variant} is ${recipeLength(recipe)}s`)
  })

  test(`${kind} ${variant}: every attack is at least 4ms, so the onset never clicks`, () => {
    for (const p of recipe) assert.ok(p.attack >= 0.004, `${kind} ${variant}: a partial's attack is ${p.attack}s`)
  })

  test(`${kind} ${variant}: renders to exactly recipeLength() worth of samples`, () => {
    const samples = renderToSamples(recipe, SAMPLE_RATE)
    const want = Math.ceil(recipeLength(recipe) * SAMPLE_RATE)
    assert.equal(samples.length, want)
  })

  test(`${kind} ${variant}: never clips (stays within -1..1) and peaks well under full scale`, () => {
    const samples = renderToSamples(recipe, SAMPLE_RATE)
    let peak = 0
    for (const v of samples) {
      assert.ok(v >= -1 && v <= 1, `sample ${v} outside -1..1`)
      peak = Math.max(peak, Math.abs(v))
    }
    // -18dBFS or so, as the design asks; a little headroom either way for variants layering
    // more than one partial.
    assert.ok(peak < 0.3, `peak ${peak} is not well under full scale`)
  })

  test(`${kind} ${variant}: starts and ends at (near) silence — no click at either edge`, () => {
    const samples = renderToSamples(recipe, SAMPLE_RATE)
    assert.ok(Math.abs(samples[0]) < 0.001, `first sample is ${samples[0]}`)
    assert.ok(Math.abs(samples[samples.length - 1]) < 0.001, `last sample is ${samples[samples.length - 1]}`)
  })
}

test('update is quieter than decide: the two peaks are clearly ordered, "update" being the quietest', () => {
  const peakOf = (kind: SoundKind, variant: Variant) => {
    const samples = renderToSamples(RECIPES[kind][variant], SAMPLE_RATE)
    return samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
  }
  assert.ok(peakOf('update', 'A') < peakOf('decide', 'A'), 'update A should be quieter than decide A')
  assert.ok(peakOf('update', 'B') < peakOf('decide', 'B'), 'update B should be quieter than decide B')
})

test('no partial carries a frequency above ~3kHz (nothing harsh)', () => {
  for (const [kind, variant] of ALL) {
    for (const p of RECIPES[kind][variant]) {
      assert.ok(p.f0 <= 3000 && p.f1 <= 3000, `${kind} ${variant}: a partial reaches ${Math.max(p.f0, p.f1)}Hz`)
    }
  }
})
