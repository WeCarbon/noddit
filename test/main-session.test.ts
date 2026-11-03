import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { launchPlan, type LaunchEnv } from '../src/core/launch.ts'
import { commonParent, isMainSession } from '../src/core/main-session.ts'
import { BIN, decs, decsResult, killAndWait, scratch } from './helpers.ts'

const OWNER = { CLAUDECODE: undefined, DECS_AUTHOR: undefined }
const PLUGIN = fileURLToPath(new URL('../plugin/', import.meta.url))

/** A folder of projects (`code/alpha` lettered A, `code/beta` lettered B) registered in a home of its own. */
function workspace(t: { after: (fn: () => void) => void }) {
  const base = realpathSync.native(scratch())
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const home = join(base, '.home')
  const code = join(base, 'code')
  const alpha = join(code, 'alpha')
  const beta = join(code, 'beta')
  for (const [dir, letter] of [[alpha, 'A'], [beta, 'B']] as const) {
    mkdirSync(dir, { recursive: true })
    decs(dir, ['init', '--no-register', '--letter', letter], { DECS_HOME: home })
  }
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'config.json'), JSON.stringify({ projects: [{ name: 'alpha', root: alpha }, { name: 'beta', root: beta }] }))
  const env = (extra: Record<string, string | undefined> = {}) => ({ DECS_HOME: home, ...extra })
  return { base, home, code, alpha, beta, env }
}

const fakeHeartbeat = (home: string, name: string, roots: string[], role: string) => {
  mkdirSync(join(home, 'sessions'), { recursive: true })
  const now = new Date().toISOString()
  writeFileSync(join(home, 'sessions', `${name}.json`), JSON.stringify({ pid: process.pid, roots, author: `${name} · lead`, harness: 'claude-code', role, started_at: now, last_seen: now }))
}

async function waitFor(ok: () => boolean, what: string, ms = 15_000): Promise<void> {
  for (const start = Date.now(); Date.now() - start < ms; ) {
    if (ok()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  assert.fail(`timed out waiting for ${what}`)
}

test('main session detection: NODDIT_ROLE=main, or a cwd in no project with registered projects below it', (t) => {
  const w = workspace(t)
  const roots = [w.alpha, w.beta]
  assert.equal(isMainSession(w.alpha, { NODDIT_ROLE: 'main' }, roots), true)
  assert.equal(isMainSession(w.code, {}, roots), true, 'the projects’ parent')
  assert.equal(isMainSession(w.alpha, {}, roots), false, 'inside a project')
  assert.equal(isMainSession(join(w.base, '.home'), {}, roots), false, 'no project below')
  assert.equal(isMainSession(w.code, { NODDIT_ROLE: 'agent' }, roots), true, 'agent is not an opt-out')
})

test('commonParent: the deepest shared folder; home when they share only the root', () => {
  assert.equal(commonParent(['/w/code/a', '/w/code/b']), resolve('/w/code'))
  assert.equal(commonParent(['/w/code/a', '/w/code/b/c']), resolve('/w/code'))
  assert.equal(commonParent(['/w/code/a']), resolve('/w/code'))
  assert.equal(commonParent(['/a/x', '/b/y']), homedir())
  assert.equal(commonParent([]), null)
})

test('nod init refuses in the main session’s folder, but a new project below it is fine', (t) => {
  const w = workspace(t)
  const refused = decsResult(w.code, ['init', '--no-register'], w.env({ NODDIT_ROLE: 'main' }))
  assert.equal(refused.code, 1)
  assert.match(refused.stderr, /this is the main agent, and .* is not a project/)
  assert.ok(!existsSync(join(w.code, 'decisions')), 'no decisions/ in the projects’ parent')
  // Detected without the variable too: a session opened by hand in the parent.
  assert.equal(decsResult(w.code, ['init', '--no-register'], w.env()).code, 1)
  const fresh = join(w.code, 'gamma')
  decs(w.code, ['init', '--no-register', '--dir', fresh], w.env({ NODDIT_ROLE: 'main' }))
  assert.ok(existsSync(join(fresh, 'decisions', 'active')))
})

test('nod session start --main: opens in the projects’ parent with NODDIT_ROLE=main; one at a time', (t) => {
  const w = workspace(t)
  const record = join(w.base, 'launch.jsonl')
  const dry = JSON.parse(decs(w.alpha, ['session', 'start', '--main', '--dry-run', '--json'], w.env({ NODDIT_LAUNCH_RECORD: record })))
  assert.equal(dry.ok, true)
  assert.equal(dry.started, false)
  assert.equal(dry.plan.root, w.code)
  assert.match(
    dry.plan.command,
    process.platform === 'win32'
      ? /set "NODDIT_ROLE=main"&& set "NODDIT_AUTHOR=main-session"&& claude "nod: you are the main session/
      : /NODDIT_ROLE='main' NODDIT_AUTHOR='main-session' 'claude' 'nod: you are the main session/,
  )
  assert.ok(!existsSync(record), '--dry-run opens nothing')
  assert.ok(existsSync(join(w.home, 'main', 'decisions', 'active')), 'its own store is ready')

  const there = JSON.parse(decs(w.alpha, ['session', 'start', '--main', '--dir', w.base, '--dry-run', '--json'], w.env()))
  assert.equal(there.plan.root, w.base)

  fakeHeartbeat(w.home, 'main-x', [join(w.home, 'main')], 'main')
  const again = decsResult(w.alpha, ['session', 'start', '--main'], w.env({ NODDIT_LAUNCH_RECORD: record }))
  assert.equal(again.code, 1)
  assert.match(again.stderr, /main agent already has a session listening/)
  const sessions = JSON.parse(decs(w.alpha, ['sessions', '--json'], w.env()))
  assert.equal(sessions.main.role, 'main')
  assert.equal(sessions.projects.every((p: { listening: boolean }) => !p.listening), true, 'the main session is nobody’s lead')
  assert.equal(JSON.parse(decs(w.alpha, ['add', 'a brief', '--json'], w.env(OWNER))).listening, true, 'but it will pick up a brief')

  rmSync(join(w.home, 'config.json'))
  rmSync(join(w.home, 'sessions'), { recursive: true })
  const none = decsResult(w.alpha, ['session', 'start', '--main', '--dry-run'], w.env())
  assert.equal(none.code, 1)
  assert.match(none.stderr, /no project is registered/)
})

test('launch plans carry the given variables on every platform', () => {
  const env = (platform: NodeJS.Platform, has: string[]): LaunchEnv => ({ platform, has: (n) => has.includes(n) })
  const vars = { NODDIT_ROLE: 'main', 'bad name': 'x' }
  assert.equal(launchPlan('kimi', '/w/code', env('linux', []), '', vars).command, `cd '/w/code' && NODDIT_ROLE='main' 'kimi'`)
  const cmd = launchPlan('codex', 'C:\\w\\code', env('win32', []), 'go', vars)
  assert.equal(cmd.command, 'set "NODDIT_ROLE=main"&& codex "go"')
})

test('the main session’s monitor takes briefs where no lead listens, and leaves the rest to that lead', async (t) => {
  const w = workspace(t)
  decs(w.alpha, ['add', 'alpha brief'], w.env(OWNER))
  decs(w.beta, ['add', 'beta brief'], w.env(OWNER))
  mkdirSync(join(w.home, 'main', 'decisions', 'active'), { recursive: true })
  decs(w.code, ['add', 'my own to-do', '--task', '--dir', join(w.home, 'main')], w.env())
  decs(w.code, ['add', 'note to self', '--dir', join(w.home, 'main')], w.env(OWNER))
  fakeHeartbeat(w.home, 'alpha-lead', [w.alpha], 'lead')

  const env = { ...process.env, NO_COLOR: '1', DECS_LANG: 'en', CLAUDECODE: '1', DECS_HOME: w.home, NODDIT_ROLE: 'main', DECS_AUTHOR: 'main-session' }
  const mon = spawn(process.execPath, [BIN, 'monitor', '--with-parent', String(process.pid), '--here', '--interval', '200', '--no-sources'], { cwd: w.code, env })
  t.after(() => killAndWait(mon))
  let out = ''
  mon.stdout.on('data', (b) => (out += b))
  await waitFor(() => out.includes('DECS-BRIEF B1'), 'beta’s brief')
  await waitFor(() => /DECS-BRIEF X2 .*note to self/.test(out), 'the brief in its own store')
  await waitFor(() => readdirSync(join(w.home, 'sessions')).length === 2, 'its heartbeat')
  const beat = readdirSync(join(w.home, 'sessions'))
    .filter((n) => n !== 'alpha-lead.json')
    .map((n) => JSON.parse(readFileSync(join(w.home, 'sessions', n), 'utf8')))[0]
  assert.equal(beat.role, 'main')
  assert.deepEqual(beat.roots, [join(w.home, 'main')])

  // A brief landing in alpha while its lead is live stays alpha's; once the lead is gone it is the main session's.
  decs(w.alpha, ['add', 'second alpha brief'], w.env(OWNER))
  await new Promise((r) => setTimeout(r, 1000))
  assert.ok(!out.includes('DECS-BRIEF A'), out)
  rmSync(join(w.home, 'sessions', 'alpha-lead.json'))
  await waitFor(() => out.includes('DECS-BRIEF A1') && out.includes('DECS-BRIEF A2'), 'alpha’s briefs once nobody listens there')
  await killAndWait(mon)
})

test('the session-start hook gives the main session its own rules first', (t) => {
  const w = workspace(t)
  const run = (env: Record<string, string>) =>
    JSON.parse(
      execFileSync(process.execPath, [join(PLUGIN, 'session-start.mjs')], { cwd: w.code, input: '', encoding: 'utf8', env: { ...process.env, DECS_LANG: 'en', DECS_HOME: w.home, ...env } }),
    ).hookSpecificOutput.additionalContext as string
  const main = run({ NODDIT_ROLE: 'main' })
  assert.ok(main.startsWith('## nod: you are the main session'), main.slice(0, 80))
  assert.match(main, /Never create `decisions\/` here/)
  assert.match(main, /## nod: this project's tasks/, 'the general rules follow')
  assert.ok(main.length < 9500)
  const inProject = execFileSync(process.execPath, [join(PLUGIN, 'session-start.mjs')], { cwd: w.alpha, input: '', encoding: 'utf8', env: { ...process.env, DECS_LANG: 'en', DECS_HOME: w.home, NODDIT_ROLE: '' } })
  assert.doesNotMatch(inProject, /you are the main session/)
})
