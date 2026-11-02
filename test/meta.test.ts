import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { benchOrder, compareUrgency, overdue } from '../src/core/order.ts'
import type { Decision } from '../src/core/types.ts'
import { decs, decsResult, scratch } from './helpers.ts'

test('urgency outranks age; manual order outranks urgency; nearer deadline first', () => {
  const mk = (id: number, created: string, extra: Partial<Decision> = {}) =>
    ({ id, created, options: [], tags: [], ...extra }) as unknown as Decision
  const list = [
    mk(1, '2026-09-01T00:00:00+08:00'),
    mk(2, '2026-09-05T00:00:00+08:00', { urgency: 'high' }),
    mk(3, '2026-08-01T00:00:00+08:00', { urgency: 'low' }),
    mk(4, '2026-09-06T00:00:00+08:00', { urgency: 'high', due: '2026-09-07T00:00:00+08:00' }),
    mk(5, '2026-09-09T00:00:00+08:00', { order: -1 }),
    mk(6, '2026-07-01T00:00:00+08:00', { urgency: 'high', order: 1 }),
  ].sort(benchOrder)
  assert.deepEqual(list.map((d) => d.id), [5, 4, 2, 1, 3, 6])
  assert.ok(compareUrgency({ urgency: 'high' }, {}) < 0)
  assert.ok(overdue({ due: '2000-01-01T00:00:00Z', status: 'open' }))
  assert.ok(!overdue({ due: '2000-01-01T00:00:00Z', status: 'answered' }))
})

test('decs add --urgency/--due/--if-no-answer/--reversible are stored and shown', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 'an ordinary entry filed early'])
  decs(root, ['add', 'ship release', '--urgency', 'high', '--due', '4h', '--if-no-answer', "don't ship, come back to it Friday", '--reversible', 'yes'])

  const d = JSON.parse(decs(root, ['get', '2', '--json']))
  assert.equal(d.urgency, 'high')
  assert.ok(Date.parse(d.due) > Date.now() + 3.9 * 3_600_000)
  assert.equal(d.if_no_answer, "don't ship, come back to it Friday")
  assert.equal(d.reversible, true)
  assert.equal(JSON.parse(decs(root, ['get', '1', '--json'])).urgency, 'normal')
  assert.ok(!readFileSync(JSON.parse(decs(root, ['get', '1', '--json'])).file, 'utf8').includes('urgency'), 'normal is not written')

  const shown = decs(root, ['show']).trim().split('\n')
  assert.match(shown[0], /urgent.*ship release/, 'high goes first even though it is newer')
  assert.match(decs(root, ['get', '2']), /if you don't answer: don't ship, come back to it Friday \(reversible\)/)

  assert.equal(decsResult(root, ['add', 'x', '--urgency', 'asap']).code, 1)
  assert.equal(decsResult(root, ['add', 'x', '--reversible', 'maybe']).code, 1)
})

test('--notify runs DECS_NOTIFY_CMD with the entry in env, and is a no-op without it', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  const out = join(root, 'pinged.txt')
  // DECS_NOTIFY_CMD runs through the host's own shell — sh on POSIX, cmd.exe on
  // Windows — so `printf`/`touch` and `$VAR` only work on one of them. A Node
  // one-liner (no `$`, no backtick, so neither shell's own expansion kicks in)
  // runs the same under both; the output path travels as an env var rather than
  // being interpolated into the command text, so it never needs OS-specific quoting.
  const writeFromEnv = `node -e "require('fs').writeFileSync(process.env.DECS_TEST_OUT, [process.env.DECS_REF, process.env.DECS_TITLE, process.env.DECS_URGENCY].join('|'))"`
  const touchFile = `node -e "require('fs').writeFileSync(process.env.DECS_TEST_OUT, '')"`
  decs(root, ['add', 'should notify', '--urgency', 'high', '--notify'], {
    DECS_NOTIFY_CMD: writeFromEnv,
    DECS_TEST_OUT: out,
  })
  assert.equal(readFileSync(out, 'utf8'), 'X1|should notify|high')

  const quiet = decsResult(root, ['add', 'should not notify', '--notify'], { DECS_NOTIFY_CMD: '' })
  assert.equal(quiet.code, 0)
  rmSync(out)
  decs(root, ['add', 'no notify flag'], { DECS_NOTIFY_CMD: touchFile, DECS_TEST_OUT: out })
  assert.ok(!existsSync(out), 'default off: nothing is pushed without --notify')
})

test('session id is recorded from the environment', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 'who wrote this'], { CLAUDE_SESSION_ID: 'sess-123' })
  assert.equal(JSON.parse(decs(root, ['get', '1', '--json'])).session, 'sess-123')
})
