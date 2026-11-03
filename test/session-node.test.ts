import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { BIN, decs, decsResult, scratch } from './helpers.ts'

/** A project with its own home and session-nodes file, so no other test's `nod start` leaks in. */
function project(t: { after: (fn: () => void) => void }) {
  const root = scratch()
  const home = scratch()
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })
  const base = { DECS_HOME: home, NODDIT_SESSION_NODES: join(home, 'session-nodes.json'), NODDIT_IDENTITY: 'lane-a#s1' }
  const run = (args: string[], env: Record<string, string | undefined> = {}, input = '') => decs(root, args, { ...base, ...env }, input)
  const result = (args: string[], env: Record<string, string | undefined> = {}) => decsResult(root, args, { ...base, ...env })
  const get = (id: number) => JSON.parse(run(['get', String(id), '--json']))
  run(['init', '--no-register'])
  return { root, home, run, result, get }
}

test('nod start records this session’s current node: progress / beat / note / steps / step need no id after it', (t) => {
  const p = project(t)
  p.run(['add', 'ship the login page', '--task'])
  const started = p.run(['start', '1'])
  assert.match(started, /current node is now X1/)

  p.run(['progress', '30'])
  assert.equal(p.get(1).progress, 30)

  p.run(['note', 'the form posts now'])
  assert.equal(p.get(1).notes.at(-1).text, 'the form posts now')

  p.run(['beat', '--note', 'still on it'])
  assert.equal(p.get(1).notes.at(-1).text, 'still on it')

  p.run(['steps', 'build', 'test'])
  p.run(['step', '1'])
  assert.equal(p.get(1).progress, 50)
})

test('NODDIT_NODE still wins over the recorded node, and an explicit id wins over both', (t) => {
  const p = project(t)
  p.run(['add', 'one', '--task'])
  p.run(['add', 'two', '--task'])
  p.run(['add', 'three', '--task'])
  p.run(['start', '1'])
  p.run(['progress', '40'], { NODDIT_NODE: '2' })
  assert.equal(p.get(2).progress, 40)
  assert.equal(p.get(1).progress ?? 0, 0)
  p.run(['note', '3', 'on three'])
  assert.equal(p.get(3).notes.at(-1).text, 'on three')
})

test('the current node is per session identity, and a finished one is no longer a default', (t) => {
  const p = project(t)
  p.run(['add', 'mine', '--task'])
  p.run(['start', '1'])
  const other = p.result(['progress', '10'], { NODDIT_IDENTITY: 'lane-b#s2' })
  assert.notEqual(other.code, 0, 'another session has no current node')
  assert.match(other.stderr, /nod start <id> first/)

  p.run(['done', '1'])
  const after = p.result(['note', 'late'])
  assert.notEqual(after.code, 0)
})

test('the owner’s own terminal (not an agent) records no current node', (t) => {
  const p = project(t)
  p.run(['add', 'by hand', '--task'])
  const out = p.run(['start', '1'], { CLAUDECODE: undefined })
  assert.doesNotMatch(out, /current node/)
  assert.notEqual(p.result(['progress', '10'], { CLAUDECODE: undefined }).code, 0)
})

test('an agent can’t start a node the owner deferred, or expand the owner’s own to-do (--force when asked)', (t) => {
  const p = project(t)
  p.run(['add', 'later', '--task'])
  p.run(['defer', '1'], { CLAUDECODE: undefined })
  const r = p.result(['start', '1'])
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /deferred by the owner/)
  p.run(['start', '1', '--force'])

  p.run(['add', 'call the vendor', '--for', 'me'], { CLAUDECODE: undefined })
  const e = p.result(['expand', '2'], {})
  assert.notEqual(e.code, 0)
})

test('nod add --task tells an agent to nod start it; nod ask says where the answer arrives', (t) => {
  const p = project(t)
  p.run(['add', 'a task', '--task'])
  const add = decsResultBoth(p, ['add', 'another task', '--task'])
  assert.match(add, /next: nod start X2/)
  p.run(['start', '2'])
  assert.match(p.run(['ask', '2', '-o', '1=keep it', '-o', '2=drop it']), /arrives as a nod monitor line/)
})

test('nod note "waiting on …" in English also points at nod hold', (t) => {
  const p = project(t)
  p.run(['add', 'deploy', '--task'])
  p.run(['start', '1'])
  assert.match(decsResultBoth(p, ['note', '1', 'waiting on Bob for the keys']), /nod hold 1 --on/)
})

/** stdout and stderr together, on success too — the next-step hints go to stderr. */
function decsResultBoth(p: ReturnType<typeof project>, args: string[]): string {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: p.root,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', DECS_AUTHOR: 'cli-test · lane', DECS_LANG: 'en', CLAUDECODE: '1', DECS_HOME: p.home, NODDIT_SESSION_NODES: join(p.home, 'session-nodes.json'), NODDIT_IDENTITY: 'lane-a#s1' },
  })
  assert.equal(r.status, 0, r.stderr)
  return `${r.stdout}${r.stderr}`
}

test('nod tidy: a node started in a session whose monitor is live is not orphaned, whatever name it was filed under', (t) => {
  const p = project(t)
  const SESSION = { NODDIT_SESSION_PID: String(process.pid) }
  p.run(['add', 'planned by the lead', '--task', '--author', 'lead · planning'])
  p.run(['start', '1', '--author', 'lead · planning'], SESSION)
  p.run(['add', 'also the lead’s', '--task', '--author', 'lead · planning'])
  // Started before starters were recorded: no record at all for it.
  p.run(['start', '2', '--author', 'lead · planning'], { NODDIT_SESSION_NODES: join(p.home, 'elsewhere.json') })
  p.run(['add', 'a dead lane', '--task', '--author', 'lane-x · gone'])
  p.run(['start', '3', '--author', 'lane-x · gone'], { NODDIT_SESSION_PID: '999999' })

  const orphans = () =>
    (JSON.parse(p.run(['tidy', '--json'])) as Array<{ ref: string; tidy: string[] }>)
      .filter((d) => d.tidy.includes('orphanedAuthor'))
      .map((d) => d.ref)
  assert.deepEqual(orphans(), ['X1', 'X2', 'X3'], 'no monitor at all: all three')

  // The lead's monitor: no author on it, running in the session that started X1.
  mkdirSync(join(p.home, 'sessions'), { recursive: true })
  const now = new Date().toISOString()
  writeFileSync(
    join(p.home, 'sessions', 'lead.json'),
    JSON.stringify({ pid: process.pid, session_pid: process.pid, roots: [p.root], author: null, harness: 'claude-code', role: 'lead', started_at: now, last_seen: now }),
  )
  assert.deepEqual(orphans(), ['X3'], 'X1 by its starter, X2 by the name that session starts nodes under')

  // What the finding suggests actually clears it: start it again from the live session.
  assert.match(p.run(['tidy']), /nod start X3 from a live session/)
  p.run(['start', '3', '--force', '--author', 'lead · planning'], SESSION)
  assert.deepEqual(orphans(), [])
})

test('nod monitor text lines carry their next step: a source item, an owner answer', (t) => {
  const p = project(t)
  p.run(['source', 'register', 'issues', '--title', 'web issues'])
  p.run(['source', 'push', 'issues', '--id', '7', '--title', 'login is broken'])
  p.run(['add', 'pick a host', '-o', '1=keep', '-o', '2=move'])
  p.run(['push', '1', '1'], { CLAUDECODE: undefined })
  const r = spawnSync(process.execPath, [BIN, 'monitor', '--since', '1h', '--idle-exit', '1s', '--interval', '200', '--no-heartbeat', '--no-sync'], {
    cwd: p.root,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', DECS_AUTHOR: 'lead · x', DECS_LANG: 'en', CLAUDECODE: '1', DECS_HOME: p.home },
    timeout: 30_000,
  })
  assert.match(r.stdout, /login is broken.*→ handle it, then nod source ack issues 7/)
  assert.match(r.stdout, /^X1 owner answered 1.*→ nod read X1 --ack/m)
})
