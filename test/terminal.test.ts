import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { detectTerminal, findTty, parseTtyLine, type ProcessTty, type TtyLookup } from '../src/core/terminal.ts'
import { BIN, decs, killAndWait, scratch } from './helpers.ts'

test('parseTtyLine reads a `ps -o tty=,ppid=` line, both with and without a real tty', () => {
  assert.deepEqual(parseTtyLine('ttys003 1234'), { tty: 'ttys003', ppid: 1234 })
  assert.deepEqual(parseTtyLine('  ??       57674'), { tty: '??', ppid: 57674 })
  assert.equal(parseTtyLine(''), null)
  assert.equal(parseTtyLine('not-a-pid'), null)
})

/** A fake process chain, pid -> {tty, ppid}, for `findTty`/`detectTerminal` without touching real `ps`. */
function chain(entries: Record<number, ProcessTty>): TtyLookup {
  return (pid) => entries[pid] ?? null
}

test('findTty walks the parent chain to the first ancestor with a real tty', () => {
  const lookup = chain({
    500: { tty: '??', ppid: 400 }, // the monitor itself: piped, no tty
    400: { tty: '??', ppid: 300 }, // the agent harness
    300: { tty: 'ttys003', ppid: 200 }, // the shell inside the terminal: has one
    200: { tty: 'ttys003', ppid: 1 },
  })
  assert.equal(findTty(500, lookup), '/dev/ttys003')
})

test('findTty gives up cleanly when the chain is unreadable or never finds a tty', () => {
  const noPs: TtyLookup = () => null
  assert.equal(findTty(500, noPs), undefined)
  const allDetached = chain({ 500: { tty: '??', ppid: 1 } })
  assert.equal(findTty(500, allDetached), undefined)
})

test('findTty stops after maxHops rather than looping forever on a bad chain', () => {
  const cyclic: TtyLookup = (pid) => ({ tty: '??', ppid: pid === 1 ? 1 : pid + 1 })
  assert.equal(findTty(2, cyclic, 3), undefined)
})

test('detectTerminal: iTerm2 reads the uuid after the colon in ITERM_SESSION_ID, no process walk needed', () => {
  const neverCalled: TtyLookup = () => {
    throw new Error('iTerm2 must not need a process lookup')
  }
  const terminal = detectTerminal({ TERM_PROGRAM: 'iTerm.app', ITERM_SESSION_ID: 'w1t0p0:2F1887AC-94DB-41F5-92C0-E9362BE653D0' }, neverCalled, 500)
  assert.deepEqual(terminal, { type: 'mac-iterm2', id: '2F1887AC-94DB-41F5-92C0-E9362BE653D0' })
})

test('detectTerminal: iTerm2 without ITERM_SESSION_ID (e.g. a shell inside tmux) records nothing', () => {
  assert.equal(detectTerminal({ TERM_PROGRAM: 'iTerm.app' }, chain({}), 500), undefined)
})

test('detectTerminal: Apple_Terminal walks to the tty, since TERM_SESSION_ID cannot be used in AppleScript', () => {
  const lookup = chain({ 500: { tty: '??', ppid: 1 } })
  assert.equal(detectTerminal({ TERM_PROGRAM: 'Apple_Terminal' }, lookup, 500), undefined, 'no real tty anywhere above it')
  const withTty = chain({ 500: { tty: '??', ppid: 400 }, 400: { tty: 'ttys007', ppid: 1 } })
  assert.deepEqual(detectTerminal({ TERM_PROGRAM: 'Apple_Terminal' }, withTty, 500), { type: 'mac-terminal', id: '/dev/ttys007' })
})

test('detectTerminal: any other terminal (or none at all) records nothing', () => {
  assert.equal(detectTerminal({ TERM_PROGRAM: 'vscode' }, chain({}), 500), undefined)
  assert.equal(detectTerminal({}, chain({}), 500), undefined)
  assert.equal(detectTerminal({ TERM_PROGRAM: 'tmux' }, chain({}), 500), undefined)
})

test('a monitor running as if under iTerm2 records the terminal in its heartbeat, seen in `nod sessions --json`', async (t) => {
  const root = scratch()
  decs(root, ['init', '--no-register'])
  const { spawn } = await import('node:child_process')
  const home = join(root, 'home')
  const child = spawn(process.execPath, [BIN, 'monitor', '--with-parent', String(process.pid), '--interval', '150', '--json'], {
    cwd: root,
    env: {
      ...process.env,
      NO_COLOR: '1',
      CLAUDECODE: '1',
      DECS_HOME: home,
      TERM_PROGRAM: 'iTerm.app',
      ITERM_SESSION_ID: 'w2t0p0:AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
    },
  })
  let out = ''
  child.stdout.on('data', (b) => (out += b))
  t.after(() => killAndWait(child))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const until = async (ok: () => boolean, what: string) => {
    for (const end = Date.now() + 10_000; !ok(); await new Promise((r) => setTimeout(r, 50)))
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${out}`)
  }
  await until(() => {
    try {
      return readdirSync(join(home, 'sessions')).some((f) => f.endsWith('.json'))
    } catch {
      return false
    }
  }, 'the monitor to write its first heartbeat')

  const sessions = JSON.parse(decs(root, ['sessions', '--json'], { DECS_HOME: home }))
  const web = sessions.projects.find((p: { root: string }) => p.root === root || p.root.endsWith(root))
  assert.ok(web, `no project entry for ${root}: ${JSON.stringify(sessions)}`)
  assert.deepEqual(web.sessions[0].terminal, { type: 'mac-iterm2', id: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE' })
})

test('a monitor running as if under an untracked terminal leaves the terminal field off entirely', async (t) => {
  const root = scratch()
  decs(root, ['init', '--no-register'])
  const { spawn } = await import('node:child_process')
  const home = join(root, 'home')
  const child = spawn(process.execPath, [BIN, 'monitor', '--with-parent', String(process.pid), '--interval', '150', '--json'], {
    cwd: root,
    env: { ...process.env, NO_COLOR: '1', CLAUDECODE: '1', DECS_HOME: home, TERM_PROGRAM: 'vscode', ITERM_SESSION_ID: '' },
  })
  let out = ''
  child.stdout.on('data', (b) => (out += b))
  t.after(() => killAndWait(child))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const until = async (ok: () => boolean, what: string) => {
    for (const end = Date.now() + 10_000; !ok(); await new Promise((r) => setTimeout(r, 50)))
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${out}`)
  }
  await until(() => {
    try {
      return readdirSync(join(home, 'sessions')).some((f) => f.endsWith('.json'))
    } catch {
      return false
    }
  }, 'the monitor to write its first heartbeat')

  const files = readdirSync(join(home, 'sessions')).filter((f) => f.endsWith('.json'))
  const raw = JSON.parse(readFileSync(join(home, 'sessions', files[0]), 'utf8'))
  assert.equal('terminal' in raw, false, 'no field at all, not a null placeholder')

  const sessions = JSON.parse(decs(root, ['sessions', '--json'], { DECS_HOME: home }))
  const web = sessions.projects.find((p: { root: string }) => p.root === root || p.root.endsWith(root))
  assert.equal(web.sessions[0].terminal, undefined)
})
