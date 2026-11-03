import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { initLayout, type Layout } from '../src/core/paths.ts'
import { registerSource } from '../src/core/sources.ts'
import { createSourceSyncRunner, setSourceSync, sourceSyncOf, syncRunStateOf } from '../src/core/source-sync.ts'
import { BIN, decs, killAndWait, scratch } from './helpers.ts'

/** A project plus a machine-local home of its own, and a script that logs each run's start and end. */
function setup(t: { after: (fn: () => void | Promise<void>) => void }): {
  root: string
  home: string
  layout: Layout
  cmd: (args?: string) => string
  runs: () => string[][]
  monitors: ChildProcess[]
} {
  const root = scratch()
  // A test's monitors die before their cwd goes: Windows won't remove a live process's cwd.
  const monitors: ChildProcess[] = []
  t.after(async () => {
    await Promise.all(monitors.map((m) => killAndWait(m)))
    rmSync(root, { recursive: true, force: true })
  })
  const home = join(root, '.home')
  mkdirSync(home)
  const layout = initLayout(root)
  writeFileSync(
    join(root, 'run.cjs'),
    `const fs = require('fs')
const [ms, code] = [Number(process.argv[2] || 0), Number(process.argv[3] || 0)]
fs.appendFileSync('runs.txt', 'start ' + Date.now() + '\\n')
setTimeout(() => {
  fs.appendFileSync('runs.txt', 'end ' + Date.now() + '\\n')
  if (code) process.stderr.write('first line\\nAzure DevOps answered HTML\\n')
  process.exit(code)
}, ms)
`,
  )
  const cmd = (args = '') => `${JSON.stringify(process.execPath)} run.cjs ${args}`.trim()
  const runs = () => {
    const p = join(root, 'runs.txt')
    return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').map((l) => l.split(' ')) : []
  }
  return { root, home, layout, cmd, runs, monitors }
}

const until = async (ok: () => boolean, what: string, ms = 10_000) => {
  for (const end = Date.now() + ms; !ok(); await new Promise((r) => setTimeout(r, 50))) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
}

test('a sync command is stored on this machine, keyed by project — never under decisions/', (t) => {
  const { root, home, layout } = setup(t)
  registerSource(layout, { name: 'ado', title: 'ADO' })
  const saved = setSourceSync(layout, 'ado', { cmd: 'python3 sync.py --once' }, home)
  assert.deepEqual(saved, { cmd: 'python3 sync.py --once', every: '10m' })
  assert.deepEqual(sourceSyncOf(layout, 'ado', home), saved)
  assert.equal(sourceSyncOf({ projectRoot: join(root, 'elsewhere') }, 'ado', home), undefined)

  const underDecisions = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? underDecisions(join(dir, e.name)) : [readFileSync(join(dir, e.name), 'utf8')]))
  assert.ok(!underDecisions(layout.root).some((text) => text.includes('sync.py')), 'the command must not land in decisions/')

  assert.equal(setSourceSync(layout, 'ado', { cmd: 'python3 sync.py --once', every: '30s' }, home)?.every, '30s')
  assert.throws(() => setSourceSync(layout, 'ado', { cmd: 'x', every: 'often' }, home), /not a valid duration/)
  setSourceSync(layout, 'ado', null, home)
  assert.equal(sourceSyncOf(layout, 'ado', home), undefined)
})

test('the runner starts a due command once, then waits out --every before the next run', async (t) => {
  const { home, layout, cmd, runs } = setup(t)
  setSourceSync(layout, 'ado', { cmd: cmd(), every: '1m' }, home)
  let clock = Date.now()
  const errors: string[] = []
  const runner = createSourceSyncRunner({ layouts: [layout], home, onError: (m) => errors.push(m), now: () => clock })

  runner.tick()
  await runner.idle()
  assert.equal(runs().filter((r) => r[0] === 'start').length, 1)
  runner.tick()
  await runner.idle()
  assert.equal(runs().filter((r) => r[0] === 'start').length, 1, 'not again within the minute')

  clock += 61_000
  runner.tick()
  await runner.idle()
  assert.equal(runs().filter((r) => r[0] === 'start').length, 2)
  assert.deepEqual(errors, [])
  assert.equal(syncRunStateOf(layout, 'ado', home).lastExit, 0)
})

test('runs never overlap — not within one monitor, nor across two monitors on the machine', async (t) => {
  const { home, layout, cmd, runs } = setup(t)
  setSourceSync(layout, 'ado', { cmd: cmd('600'), every: '1s' }, home)
  let clock = Date.now()
  const a = createSourceSyncRunner({ layouts: [layout], home, onError: () => {}, now: () => clock })
  const b = createSourceSyncRunner({ layouts: [layout], home, onError: () => {}, now: () => clock })

  a.tick()
  clock += 5_000 // long past --every, but the first run is still going
  a.tick()
  b.tick()
  await new Promise((r) => setTimeout(r, 200))
  b.tick()
  await Promise.all([a.idle(), b.idle()])
  assert.deepEqual(runs().map((r) => r[0]), ['start', 'end'])

  clock += 5_000
  b.tick()
  await b.idle()
  assert.deepEqual(runs().map((r) => r[0]), ['start', 'end', 'start', 'end'], 'the lock is released once a run ends')
})

test('a failing command is reported with its last stderr line and remembered; the next success clears it', async (t) => {
  const { home, layout, cmd } = setup(t)
  setSourceSync(layout, 'ado', { cmd: cmd('0 3'), every: '1s' }, home)
  let clock = Date.now()
  const errors: string[] = []
  const runner = createSourceSyncRunner({ layouts: [layout], home, onError: (m) => errors.push(m), now: () => clock })
  runner.tick()
  await runner.idle()
  assert.equal(errors.length, 1)
  assert.match(errors[0], /"ado".*Azure DevOps answered HTML/)
  assert.equal(syncRunStateOf(layout, 'ado', home).lastExit, 3)

  setSourceSync(layout, 'ado', { cmd: cmd(), every: '1s' }, home)
  clock += 2_000
  runner.tick()
  await runner.idle()
  assert.equal(errors.length, 1)
  assert.equal(syncRunStateOf(layout, 'ado', home).lastError, undefined)
})

test('a command written into a committed source.md is never run — only the machine-local setting is', async (t) => {
  const { root, home, layout, cmd, runs, monitors } = setup(t)
  registerSource(layout, { name: 'ado', title: 'ADO' })
  const file = join(layout.root, 'sources', 'ado', 'source.md')
  writeFileSync(file, readFileSync(file, 'utf8').replace('---\n', `---\nsync_cmd: ${JSON.stringify(cmd())}\nsync_every: 1s\n`))
  const runner = createSourceSyncRunner({ layouts: [layout], home, onError: () => {} })
  runner.tick()
  await runner.idle()
  assert.deepEqual(runs(), [])

  // The same through a real lead monitor.
  const child = spawn(process.execPath, [BIN, 'monitor', '--with-parent', String(process.pid), '--interval', '150', '--idle-exit', '0'], {
    cwd: root,
    env: { ...process.env, NO_COLOR: '1', DECS_AUTHOR: 'cli-test · lane', CLAUDECODE: '1', DECS_HOME: home },
  })
  monitors.push(child)
  await until(() => existsSync(join(home, 'monitor')), 'the monitor to start')
  await new Promise((r) => setTimeout(r, 600))
  assert.deepEqual(runs(), [])
})

test('nod monitor (lead) runs a registered sync command while alive; a failure is a DECS-ERROR and the watch goes on; --mine never runs it', async (t) => {
  const { root, home, cmd, runs, monitors } = setup(t)
  const env = { DECS_HOME: home }
  const out = decs(root, ['source', 'register', 'ado', '--title', 'ADO', '--sync-cmd', cmd('0 2'), '--every', '1s'], env)
  assert.match(out, /this machine only/)
  assert.ok(!readFileSync(join(root, 'decisions', 'sources', 'ado', 'source.md'), 'utf8').includes('run.cjs'))
  assert.match(decs(root, ['source', 'list'], env), /syncs every 1s/)

  const mine = spawn(process.execPath, [BIN, 'monitor', '--with-parent', String(process.pid), '--mine', '--interval', '150', '--idle-exit', '0'], {
    cwd: root,
    env: { ...process.env, NO_COLOR: '1', DECS_AUTHOR: 'cli-test · lane', CLAUDECODE: '1', DECS_HOME: home },
  })
  monitors.push(mine)
  await until(() => existsSync(join(home, 'monitor')), 'the --mine monitor to start')
  await new Promise((r) => setTimeout(r, 600))
  assert.deepEqual(runs(), [], 'a lane monitor leaves sync commands to the lead')
  await killAndWait(mine)

  const lead = spawn(process.execPath, [BIN, 'monitor', '--with-parent', String(process.pid), '--interval', '150', '--idle-exit', '0'], {
    cwd: root,
    env: { ...process.env, NO_COLOR: '1', DECS_AUTHOR: 'cli-test · lane', CLAUDECODE: '1', DECS_HOME: home },
  })
  let stdout = ''
  lead.stdout.on('data', (b) => (stdout += b))
  monitors.push(lead)
  await until(() => /DECS-ERROR .*"ado".*Azure DevOps answered HTML/.test(stdout), 'the failure to surface')
  await until(() => runs().filter((r) => r[0] === 'start').length >= 2, 'a second run after --every')
  assert.equal(lead.exitCode, null, 'a failed sync does not end the monitor')
  assert.match(decs(root, ['source', 'list'], env), /last run failed: Azure DevOps answered HTML/)

  decs(root, ['source', 'register', 'ado', '--no-sync-cmd'], env)
  assert.doesNotMatch(decs(root, ['source', 'list'], env), /syncs every/)
})
