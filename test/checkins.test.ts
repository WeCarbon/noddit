import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { askIfDue, checkinOf, resetCheckin, UNANSWERED_AFTER } from '../src/core/checkins.ts'
import { initLayout, type Layout } from '../src/core/paths.ts'
import type { Decision } from '../src/core/types.ts'
import { BIN, decs, killAndWait, scratch } from './helpers.ts'

function tmpLayout(t: { after: (fn: () => void) => void }): Layout {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return initLayout(root)
}

type Probe = Pick<Decision, 'id' | 'state' | 'updatedAt' | 'created' | 'staleAfter' | 'activeAt' | 'deferredAt'>

function node(overrides: Partial<Probe> = {}): Probe {
  const now = new Date().toISOString()
  return { id: 1, state: 'in_progress', updatedAt: now, created: now, staleAfter: '10m', ...overrides }
}

test('askIfDue: not due before the span, due once past it, spaced by another span after that', (t) => {
  const l = tmpLayout(t)
  const write = Date.parse('2026-01-01T00:00:00.000Z')
  const old = new Date(write).toISOString()
  const d = node({ updatedAt: old, activeAt: old })
  const min = 60_000

  assert.equal(askIfDue(l, d, write + 5 * min), undefined, 'only 5m idle, span is 10m')
  assert.equal(checkinOf(l, d.id), undefined)

  const first = askIfDue(l, d, write + 11 * min)
  assert.deepEqual(first && { asked: first.asked, unanswered: first.unanswered }, { asked: 1, unanswered: false })

  assert.equal(askIfDue(l, d, write + 15 * min), undefined, 'only 4m since the last ask, span is 10m')
  assert.equal(checkinOf(l, d.id)?.asked, 1)

  const second = askIfDue(l, d, write + 22 * min)
  assert.equal(second?.asked, 2)

  const third = askIfDue(l, d, write + 33 * min)
  assert.equal(third?.asked, UNANSWERED_AFTER)
  assert.equal(third?.unanswered, true)
  assert.equal(checkinOf(l, d.id)?.unanswered, true)

  resetCheckin(l, d.id)
  assert.equal(checkinOf(l, d.id), undefined, 'any write (here, simulated directly) clears it')
})

test('askIfDue: never for a deferred node, a not-in_progress node, or one still fresh', (t) => {
  const l = tmpLayout(t)
  const write = Date.parse('2026-01-01T00:00:00.000Z')
  const old = new Date(write).toISOString()
  const far = write + 3600_000

  assert.equal(askIfDue(l, node({ updatedAt: old, activeAt: old, deferredAt: old }), far), undefined)
  assert.equal(askIfDue(l, node({ updatedAt: old, activeAt: old, state: 'needs_decision' }), far), undefined)
  assert.equal(askIfDue(l, node({ updatedAt: new Date(far - 60_000).toISOString(), activeAt: new Date(far - 60_000).toISOString() }), far), undefined, 'well inside its own 10m span')
})

test('askIfDue: no staleAfter on the node falls back to the checkin-after setting', (t) => {
  const l = tmpLayout(t)
  const prev = process.env.NODDIT_CHECKIN_AFTER
  process.env.NODDIT_CHECKIN_AFTER = '20m'
  t.after(() => {
    if (prev === undefined) delete process.env.NODDIT_CHECKIN_AFTER
    else process.env.NODDIT_CHECKIN_AFTER = prev
  })
  const write = Date.parse('2026-01-01T00:00:00.000Z')
  const old = new Date(write).toISOString()
  const d = node({ updatedAt: old, activeAt: old, staleAfter: undefined })
  assert.equal(askIfDue(l, d, write + 15 * 60_000), undefined, 'under the 20m setting default')
  assert.equal(askIfDue(l, d, write + 21 * 60_000)?.asked, 1, 'past it now')
})

test('checkins.json is gitignored the first time anything is actually asked, even in a project set up before the feature existed', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  const l = initLayout(root)
  const ignore = join(l.root, '.gitignore')
  const before = readFileSync(ignore, 'utf8')
  assert.ok(before.includes('checkins.json'), 'nod init already writes the line for a new project')

  // Simulate an old project: strip the line back out, as if init pre-dated this feature.
  writeFileSync(ignore, before.split('\n').filter((line) => line.trim() !== 'checkins.json').join('\n'))
  assert.ok(!readFileSync(ignore, 'utf8').includes('checkins.json'))

  const write = Date.parse('2026-01-01T00:00:00.000Z')
  const old = new Date(write).toISOString()
  askIfDue(l, node({ updatedAt: old, activeAt: old }), write + 15 * 60_000)
  assert.ok(readFileSync(ignore, 'utf8').includes('checkins.json'), 'the first real write ensures the line')
  assert.ok(existsSync(join(l.root, 'checkins.json')))
})

test('a check-in ask rides along the next monitor line when there is one, but still fires on its own after a long enough silence — at most once per span', async (t) => {
  const root = scratch()
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 'run the long build', '--task', '--stale-after', '1s'])
  decs(root, ['start', '1'])
  const { spawn } = await import('node:child_process')
  const home = join(root, 'home')
  const child = spawn(process.execPath, [BIN, 'monitor', '--interval', '150', '--json'], {
    cwd: root,
    env: { ...process.env, NO_COLOR: '1', DECS_AUTHOR: 'cli-test · lane', CLAUDECODE: '1', DECS_HOME: home },
  })
  let out = ''
  child.stdout.on('data', (b) => (out += b))
  t.after(() => killAndWait(child))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const lines = () => out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const until = async (ok: () => boolean, what: string) => {
    for (const end = Date.now() + 10_000; !ok(); await new Promise((r) => setTimeout(r, 50)))
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${out}`)
  }
  // A monitor has finished a poll once it has saved its cursor under DECS_HOME.
  await until(() => existsSync(join(home, 'monitor')) && readdirSync(join(home, 'monitor')).some((f) => f.endsWith('.json')), 'the monitor to start')

  // Node 1 goes past its 1s span with nothing else happening at all — it still gets asked,
  // on its own (N47: "no event for a while, the check-in may itself be the event").
  await until(() => lines().some((l) => l.event === 'checkin' && l.ref === 'X1'), 'a standalone checkin after enough silence')
  assert.equal(lines().find((l) => l.event === 'checkin')?.asked, 1)
  assert.equal(lines().find((l) => l.event === 'checkin')?.unanswered, false)

  // Asked once already — it must not be asked again every 150ms poll while still silent
  // (several polls fit in 600ms; the count must not grow past 1 here).
  await new Promise((r) => setTimeout(r, 600))
  assert.equal(lines().filter((l) => l.event === 'checkin').length, 1, 'at most once per span, not once per poll')
})
