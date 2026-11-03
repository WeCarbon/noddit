import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { asQuote } from '../src/core/launch.ts'
import { gotoSessionScript } from '../src/core/goto-session.ts'
import type { SessionTerminal } from '../src/core/terminal.ts'
import { describeGoto, pickGotoTerminal } from '../src/cli/commands/session.ts'
import { BIN, decs, killAndWait, scratch } from './helpers.ts'

test('gotoSessionScript (iTerm2): guarded by "is running", matches on id, activates only once found, never unconditionally', () => {
  const terminal: SessionTerminal = { type: 'mac-iterm2', id: '2F1887AC-94DB-41F5-92C0-E9362BE653D0' }
  const script = gotoSessionScript(terminal)
  assert.ok(script.startsWith('if application "iTerm" is running then'), 'never bare `tell application`, which would launch it')
  assert.ok(script.includes(`set targetId to ${asQuote(terminal.id)}`))
  assert.ok(script.includes('if (id of sess) is targetId then'))
  assert.ok(script.includes('select sess'))
  assert.ok(script.includes('tell w to select'))
  // activate only appears inside the `if found then` branch, never before it
  const foundIdx = script.indexOf('if found then')
  const activateIdx = script.indexOf('activate')
  assert.ok(foundIdx >= 0 && activateIdx > foundIdx)
  assert.ok(script.trim().endsWith('return "not_found"'))
})

test('gotoSessionScript (Terminal.app): guarded by "is running", matches on tty, brings the window forward', () => {
  const terminal: SessionTerminal = { type: 'mac-terminal', id: '/dev/ttys003' }
  const script = gotoSessionScript(terminal)
  assert.ok(script.startsWith('if application "Terminal" is running then'))
  assert.ok(script.includes(`if (tty of tb) is ${asQuote(terminal.id)} then`))
  assert.ok(script.includes('set selected tab of w to tb'))
  assert.ok(script.includes('set index of w to 1'))
  const foundIdx = script.indexOf('if found then')
  const activateIdx = script.indexOf('activate')
  assert.ok(foundIdx >= 0 && activateIdx > foundIdx)
})

test('pickGotoTerminal: only a lead with a terminal counts, most recently seen wins among several', () => {
  const t1: SessionTerminal = { type: 'mac-iterm2', id: 'AAA' }
  const t2: SessionTerminal = { type: 'mac-terminal', id: '/dev/ttys001' }
  assert.equal(pickGotoTerminal([]), undefined)
  assert.equal(
    pickGotoTerminal([{ role: 'teammate', terminal: t1, last_seen: '2026-11-03T10:00:00.000Z' }]),
    undefined,
    'a sub-agent session never counts, however recent',
  )
  assert.equal(pickGotoTerminal([{ role: 'lead', terminal: undefined, last_seen: '2026-11-03T10:00:00.000Z' }]), undefined)
  assert.deepEqual(
    pickGotoTerminal([
      { role: 'lead', terminal: t1, last_seen: '2026-11-03T10:00:00.000Z' },
      { role: 'lead', terminal: t2, last_seen: '2026-11-03T10:05:00.000Z' },
    ]),
    t2,
    'the more recently seen of the two lead sessions wins',
  )
})

test('describeGoto reports success or "nothing to switch to", not the raw reason code', () => {
  const terminal: SessionTerminal = { type: 'mac-iterm2', id: 'AAA' }
  assert.match(describeGoto({ ok: true, terminal }, 'web'), /web/)
  assert.match(describeGoto({ ok: false, reason: 'no_terminal_session' }, 'web'), /web/)
  assert.match(describeGoto({ ok: false, reason: 'not_found' }, 'web'), /web/)
})

test('nod session goto --json: no monitor heartbeat at all is "no_terminal_session", exit 1', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  const home = join(root, 'home')
  let threw: { status: number; stdout: string } | undefined
  try {
    decs(root, ['session', 'goto', '--json'], { DECS_HOME: home })
  } catch (e) {
    threw = e as { status: number; stdout: string }
  }
  assert.ok(threw, 'goto with nothing listening must exit non-zero')
  assert.deepEqual(JSON.parse(threw!.stdout), { ok: false, reason: 'no_terminal_session', dry_run: false })
})

test('nod session goto --json: a recorded iTerm2 lead session is found and the AppleScript is built for its id', async (t) => {
  const root = scratch()
  decs(root, ['init', '--no-register'])
  const { spawn } = await import('node:child_process')
  const home = join(root, 'home')
  const child = spawn(process.execPath, [BIN, 'monitor', '--interval', '150', '--json'], {
    cwd: root,
    env: {
      ...process.env,
      NO_COLOR: '1',
      CLAUDECODE: '1',
      DECS_HOME: home,
      TERM_PROGRAM: 'iTerm.app',
      ITERM_SESSION_ID: 'w3t0p0:11111111-2222-3333-4444-555555555555',
    },
  })
  t.after(() => killAndWait(child))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const until = async (ok: () => boolean, what: string) => {
    for (const end = Date.now() + 10_000; !ok(); await new Promise((r) => setTimeout(r, 50)))
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
  }
  await until(() => {
    try {
      return readdirSync(join(home, 'sessions')).some((f) => f.endsWith('.json'))
    } catch {
      return false
    }
  }, 'the monitor to write its first heartbeat')

  const record = join(root, 'launch-record.jsonl')
  const out = decs(root, ['session', 'goto', '--json'], { DECS_HOME: home, NODDIT_LAUNCH_RECORD: record })
  assert.deepEqual(JSON.parse(out), { ok: true, terminal: { type: 'mac-iterm2', id: '11111111-2222-3333-4444-555555555555' }, dry_run: false })

  const lines = readFileSync(record, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(lines.length, 1)
  assert.equal(lines[0].kind, 'goto')
  assert.deepEqual(lines[0].terminal, { type: 'mac-iterm2', id: '11111111-2222-3333-4444-555555555555' })
  assert.ok(lines[0].script.includes('11111111-2222-3333-4444-555555555555'))

  // --dry-run (what the app's background/screenshot mode forces, mirroring `session start`):
  // reports the same target, but never runs the AppleScript at all — not even through the seam.
  const dryRecord = join(root, 'dry-run-record.jsonl')
  const dryOut = decs(root, ['session', 'goto', '--dry-run', '--json'], { DECS_HOME: home, NODDIT_LAUNCH_RECORD: dryRecord })
  assert.deepEqual(JSON.parse(dryOut), { ok: true, terminal: { type: 'mac-iterm2', id: '11111111-2222-3333-4444-555555555555' }, dry_run: true })
  assert.equal(existsSync(dryRecord), false, '--dry-run never shells out, even to the test seam')
})

test('nod session goto: a teammate-only heartbeat (no lead) is still "nothing to switch to"', async (t) => {
  const root = scratch()
  decs(root, ['init', '--no-register'])
  const { spawn } = await import('node:child_process')
  const home = join(root, 'home')
  const child = spawn(process.execPath, [BIN, 'monitor', '--mine', '--interval', '150', '--json'], {
    cwd: root,
    env: {
      ...process.env,
      NO_COLOR: '1',
      CLAUDECODE: '1',
      DECS_HOME: home,
      DECS_AUTHOR: 'cli-test · lane',
      TERM_PROGRAM: 'iTerm.app',
      ITERM_SESSION_ID: 'w4t0p0:66666666-7777-8888-9999-000000000000',
    },
  })
  t.after(() => killAndWait(child))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const until = async (ok: () => boolean, what: string) => {
    for (const end = Date.now() + 10_000; !ok(); await new Promise((r) => setTimeout(r, 50)))
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
  }
  await until(() => {
    try {
      return readdirSync(join(home, 'sessions')).some((f) => f.endsWith('.json'))
    } catch {
      return false
    }
  }, 'the teammate monitor to write its first heartbeat')

  let threw: { status: number; stdout: string } | undefined
  try {
    decs(root, ['session', 'goto', '--json'], { DECS_HOME: home })
  } catch (e) {
    threw = e as { status: number; stdout: string }
  }
  assert.ok(threw)
  assert.deepEqual(JSON.parse(threw!.stdout), { ok: false, reason: 'no_terminal_session', dry_run: false })
})
