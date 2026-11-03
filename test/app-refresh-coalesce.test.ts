import { test } from 'node:test'
import assert from 'node:assert/strict'

import { coalesce } from '../app/src/coalesce.ts'

/**
 * The app's main window folds concurrent `refresh()` calls into one pass after
 * the one already running (so a settings change never starts a second `nod
 * bench --json` racing the first). This is the piece of that logic with no
 * Preact in it, so it is tested here directly.
 */

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

test('a second call while the first is running gets its own fresh pass', { timeout: 2000 }, async () => {
  let calls = 0
  const resolvers: (() => void)[] = []
  const run = coalesce(async () => {
    calls++
    await new Promise<void>((resolve) => resolvers.push(resolve))
  })

  const first = run()
  const second = run() // arrives mid-flight: must not run alongside the first, but must still happen
  assert.equal(calls, 1, 'the second call does not start an overlapping pass')

  resolvers[0]()
  await tick()
  resolvers[1]?.()
  await Promise.all([first, second])
  assert.equal(calls, 2, 'the second call still got its own pass once the first finished')
})

test('a call arriving the instant the running pass finishes is still honored, not dropped', { timeout: 2000 }, async () => {
  // The bug this guards: a settings save that lands in the one tick between
  // "the running pass found nothing more to do" and "it is marked finished"
  // used to be silently swallowed — the owner's language change took effect
  // on disk but the window kept showing the old one until the next unrelated
  // refresh happened to come along.
  let calls = 0
  const resolvers: (() => void)[] = []
  let passPromise: Promise<void> | null = null
  // `fn` builds and hands back its own promise (rather than being `async`
  // itself) so the test can see exactly the promise `coalesce`'s `await fn()`
  // is suspended on, and attach to that same promise — landing its own call
  // in the identical microtask slot `coalesce`'s own continuation runs in.
  const fn = (): Promise<void> => {
    calls++
    const p = new Promise<void>((resolve) => resolvers.push(resolve)).then(() => {})
    passPromise = p
    return p
  }
  const run = coalesce(fn)

  const first = run()
  const raceCall = passPromise!.then(() => run())

  resolvers[0]()
  for (let i = 0; i < 20 && resolvers.length < 2; i++) await tick()
  resolvers[1]?.()

  await first
  await raceCall
  assert.equal(calls, 2, 'the call that landed right as the pass finished still triggered a fresh one')
})
