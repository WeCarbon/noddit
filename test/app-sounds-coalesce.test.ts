import { test } from 'node:test'
import assert from 'node:assert/strict'

import { INITIAL_COALESCE_STATE, shouldPlaySound } from '../app/src/sounds.ts'

/**
 * At most one notice sound plays in any 5-second window; a "decide" arriving inside that window
 * still gets through if the one that played it was "update" (the more important of the two wins).
 * No audio, no timers, no DOM — `shouldPlaySound` is pure, so the policy is tested directly.
 */

test('the first sound of any kind always plays', () => {
  const { play } = shouldPlaySound(1000, 'update', INITIAL_COALESCE_STATE)
  assert.equal(play, true)
})

test('a second "update" right after the first is swallowed', () => {
  const first = shouldPlaySound(1000, 'update', INITIAL_COALESCE_STATE)
  const second = shouldPlaySound(1500, 'update', first.next)
  assert.equal(second.play, false)
})

test('a second "decide" right after the first is swallowed too', () => {
  const first = shouldPlaySound(1000, 'decide', INITIAL_COALESCE_STATE)
  const second = shouldPlaySound(2000, 'decide', first.next)
  assert.equal(second.play, false)
})

test('a "decide" arriving soon after an "update" still plays — the more important one wins', () => {
  const first = shouldPlaySound(1000, 'update', INITIAL_COALESCE_STATE)
  const second = shouldPlaySound(3000, 'decide', first.next)
  assert.equal(second.play, true)
  assert.equal(second.next.lastKind, 'decide')
})

test('an "update" arriving soon after a "decide" is still swallowed — it does not downgrade', () => {
  const first = shouldPlaySound(1000, 'decide', INITIAL_COALESCE_STATE)
  const second = shouldPlaySound(3000, 'update', first.next)
  assert.equal(second.play, false)
  assert.equal(second.next.lastKind, 'decide')
})

test('once 5 seconds pass, the next sound plays again, of either kind', () => {
  const first = shouldPlaySound(1000, 'update', INITIAL_COALESCE_STATE)
  const second = shouldPlaySound(6001, 'update', first.next)
  assert.equal(second.play, true)
  const third = shouldPlaySound(1000, 'decide', INITIAL_COALESCE_STATE)
  const fourth = shouldPlaySound(6001, 'decide', third.next)
  assert.equal(fourth.play, true)
})

test('the 5-second window is a half-open interval: 4999ms later is still inside it, 5000ms is past it', () => {
  const first = shouldPlaySound(1000, 'update', INITIAL_COALESCE_STATE)
  const stillWithin = shouldPlaySound(5999, 'update', first.next)
  assert.equal(stillWithin.play, false, '4999ms later is still inside the window')
  const pastIt = shouldPlaySound(6000, 'update', first.next)
  assert.equal(pastIt.play, true, '5000ms later is past the window')
})

test('a burst of several "update"s plays once, not once each', () => {
  let state = INITIAL_COALESCE_STATE
  let plays = 0
  for (const t of [1000, 1200, 1400, 1600, 1800]) {
    const { play, next } = shouldPlaySound(t, 'update', state)
    state = next
    if (play) plays++
  }
  assert.equal(plays, 1)
})
