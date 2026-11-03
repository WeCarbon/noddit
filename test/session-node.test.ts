import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'

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

// ---------------------------------------------------------------------------
// N267: the author signature, remembered per session the same way as the
// current node above — same session-nodes.json, same sessionKey().
// ---------------------------------------------------------------------------

test('an explicit --author is remembered for the session: a later write with neither --author nor NODDIT_AUTHOR signs the same way', (t) => {
  const p = project(t)
  p.run(['add', 'first', '--task'])
  p.run(['note', '1', 'signed explicitly', '--agent', '--author', 'lane-x · work'], { DECS_AUTHOR: undefined })
  assert.equal(p.get(1).notes.at(-1).author, 'lane-x · work')

  // No --author and no NODDIT_AUTHOR/DECS_AUTHOR this time — same session identity.
  p.run(['note', '1', 'should reuse it', '--agent'], { DECS_AUTHOR: undefined })
  assert.equal(p.get(1).notes.at(-1).author, 'lane-x · work')
})

test('nod start under an author — even one that came from NODDIT_AUTHOR, not --author — is remembered too', (t) => {
  const p = project(t)
  p.run(['add', 'second', '--task'])
  p.run(['start', '1', '--force'], { DECS_AUTHOR: 'start-env · lane' })
  p.run(['note', '1', 'reuses start’s author', '--agent'], { DECS_AUTHOR: undefined })
  assert.equal(p.get(1).notes.at(-1).author, 'start-env · lane')
})

test('an explicit --author or NODDIT_AUTHOR on a later call still wins over the remembered one, but only an explicit --author (or nod start) updates what gets remembered next', (t) => {
  const p = project(t)
  p.run(['add', 'third', '--task'])
  p.run(['note', '1', 'first', '--agent', '--author', 'lane-a · x'], { DECS_AUTHOR: undefined })
  p.run(['note', '1', 'second', '--agent', '--author', 'lane-b · y'], { DECS_AUTHOR: undefined })
  assert.equal(p.get(1).notes.at(-1).author, 'lane-b · y', '--author wins outright')

  p.run(['note', '1', 'third', '--agent'], { DECS_AUTHOR: 'env-lane · z' })
  assert.equal(p.get(1).notes.at(-1).author, 'env-lane · z', 'NODDIT_AUTHOR wins outright')

  // NODDIT_AUTHOR alone (no --author, not nod start) signs its own call but
  // isn't remembered — the last explicit --author still is.
  p.run(['note', '1', 'fourth', '--agent'], { DECS_AUTHOR: undefined })
  assert.equal(p.get(1).notes.at(-1).author, 'lane-b · y', 'the remembered author is unchanged by an env-only call')
})

test('the remembered author is per session identity: a different session (and the owner’s own terminal) sees none of it', (t) => {
  const p = project(t)
  p.run(['add', 'fourth', '--task'])
  p.run(['note', '1', 'signed', '--agent', '--author', 'lane-a · x'], { DECS_AUTHOR: undefined })

  // A different session identity: nothing remembered, and scratch() is outside any
  // git repo, so the branch-name guess fails too — the "no author" error, same as ever.
  const other = p.result(['note', '1', 'from elsewhere', '--agent'], { DECS_AUTHOR: undefined, NODDIT_IDENTITY: 'lane-b#s2' })
  assert.notEqual(other.code, 0)
  assert.match(other.stderr, /who is writing this/)
})

// ---------------------------------------------------------------------------
// N280: a sub-agent spawned inside the same agent process shares everything
// sessionKey() used to key off (CLAUDE_CODE_SESSION_ID is set once for the
// whole top-level harness process, not reassigned per agent inside it) — so
// without more, it also shares the lead's current node and remembered
// author. The fix folds the cwd's own git worktree root into the key too; a
// lane working its own worktree now differs from its lead even under the
// same identity, while two calls from the very same worktree still share.
// ---------------------------------------------------------------------------

/** Two linked worktrees of one repo — same `decisions/` (findLayout's main-worktree
 *  rule), same `$NODDIT_HOME`, same pinned identity: everything a sub-agent sharing
 *  its lead's agent process would also share, except the cwd itself. */
function worktreeProject(t: { after: (fn: () => void) => void }) {
  const root = scratch()
  const laneParent = scratch()
  const home = scratch()
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(laneParent, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  git(['init', '-q'])
  git(['config', 'user.email', 'tester@example.com'])
  git(['config', 'user.name', 'tester'])
  writeFileSync(join(root, '.gitkeep'), '')
  git(['add', '.gitkeep'])
  git(['commit', '-q', '-m', 'init'])
  const lane = join(laneParent, 'lane')
  git(['worktree', 'add', '-q', '-b', 'lane', lane])

  const base = { DECS_HOME: home, NODDIT_SESSION_NODES: join(home, 'session-nodes.json'), NODDIT_IDENTITY: 'lane-x#s1' }
  const run = (cwd: string, args: string[], env: Record<string, string | undefined> = {}) => decs(cwd, args, { ...base, ...env })
  const result = (cwd: string, args: string[], env: Record<string, string | undefined> = {}) => decsResult(cwd, args, { ...base, ...env })
  const get = (id: number) => JSON.parse(run(root, ['get', String(id), '--json']))
  run(root, ['init', '--no-register'])
  return { root, lane, run, result, get }
}

test('N280: the same session identity in a different worktree sees neither the current node nor the remembered author', (t) => {
  const p = worktreeProject(t)
  p.run(p.root, ['add', 'ship the login page', '--task', '--author', 'lead · main'])
  p.run(p.root, ['start', '1', '--author', 'lead · main'])

  const elsewhereProgress = p.result(p.lane, ['progress', '10'])
  assert.notEqual(elsewhereProgress.code, 0, 'a different worktree has no current node to default to')
  assert.match(elsewhereProgress.stderr, /nod start <id> first/)

  // The lane's own cwd is a git worktree too (branch `lane`), so resolveAuthor's
  // last resort — the branch-name guess — succeeds here instead of erroring
  // outright; what matters is that it's *that* guess, not the lead's "lead · main"
  // leaking across the worktree boundary.
  p.run(p.lane, ['note', '1', 'from another lane', '--agent'], { DECS_AUTHOR: undefined })
  assert.equal(p.get(1).notes.at(-1).author, 'lane · lane', 'a different worktree does not inherit the lead’s remembered author')
})

test('N280: the same worktree still shares its current node and remembered author across calls', (t) => {
  const p = worktreeProject(t)
  p.run(p.root, ['add', 'ship the login page', '--task', '--author', 'lead · main'])
  p.run(p.root, ['start', '1', '--author', 'lead · main'])

  p.run(p.root, ['progress', '40'])
  assert.equal(p.get(1).progress, 40, 'same worktree still defaults to the node nod start left it on')

  p.run(p.root, ['note', '1', 'reuses the remembered author', '--agent'], { DECS_AUTHOR: undefined })
  assert.equal(p.get(1).notes.at(-1).author, 'lead · main', 'same worktree still reuses the remembered author')
})

// ---------------------------------------------------------------------------
// N296: decisions/ is gitignored and only ever checked out in the main
// worktree, so every lane has to point cwd there to run `nod` at all —
// unlike the two lanes above, which each kept a cwd of their own. That
// collapses N280's worktree-of-cwd back to one shared value for every
// lane, the exact case it was meant to fix. NODDIT_WORKTREE/DECS_WORKTREE
// lets a lane say which worktree it actually is, independent of cwd.
// ---------------------------------------------------------------------------

test('N296: two lanes both forced to run nod from the main checkout share a current node and remembered author, same as N280 without the worktree', (t) => {
  const p = worktreeProject(t)
  p.run(p.root, ['add', 'lane ones task', '--task', '--author', 'lane-one · work'])
  p.run(p.root, ['add', 'lane twos task', '--task', '--author', 'lane-two · work'])

  // Both lanes have to run from p.root — the main checkout, where
  // decisions/ exists — with the same ambient identity worktreeProject's
  // base gives every call: no NODDIT_WORKTREE either, same as a harness
  // that gives every lane in one agent process the same session id.
  p.run(p.root, ['start', '1', '--author', 'lane-one · work'])
  // Lane two starts its own node from the same cwd right after — same
  // key, so it clobbers lane one's "current node" pointer instead of
  // getting one of its own.
  p.run(p.root, ['start', '2', '--author', 'lane-two · work'])
  // Lane one's own progress call, with no id given, lands on node 2 instead
  // of node 1 — whichever lane last ran nod start from that cwd wins.
  p.run(p.root, ['progress', '10'])
  assert.equal(p.get(2).progress, 10, 'lane twos node silently absorbed lane ones update')
  assert.equal(p.get(1).progress ?? 0, 0, 'lane ones own node was never touched')

  p.run(p.root, ['note', '2', 'signed explicitly', '--agent', '--author', 'lane-two · work'], { DECS_AUTHOR: undefined })
  p.run(p.root, ['note', '1', 'lane one, no author given', '--agent'], { DECS_AUTHOR: undefined })
  assert.equal(p.get(1).notes.at(-1).author, 'lane-two · work', 'lane ones note silently signed as lane two')
})

test('N296: NODDIT_WORKTREE keeps a current node and remembered author apart even from that one shared cwd', (t) => {
  const p = worktreeProject(t)
  p.run(p.root, ['add', 'lane ones task', '--task', '--author', 'lane-one · work'])
  p.run(p.root, ['add', 'lane twos task', '--task', '--author', 'lane-two · work'])

  // Lane one starts first; lane two starts second, from the same cwd — the
  // more recent call, so it is the one a shared key would be left
  // pointing at. Only a lane-one key of its own survives that.
  p.run(p.root, ['start', '1', '--author', 'lane-one · work'], { NODDIT_WORKTREE: '/lanes/lane-one' })
  p.run(p.root, ['start', '2', '--author', 'lane-two · work'], { NODDIT_WORKTREE: '/lanes/lane-two' })

  p.run(p.root, ['progress', '10'], { NODDIT_WORKTREE: '/lanes/lane-one' })
  assert.equal(p.get(1).progress, 10, 'lane ones own current node')
  assert.equal(p.get(2).progress ?? 0, 0, 'lane twos is untouched by lane ones progress call')

  p.run(p.root, ['note', '1', 'lane one, no author given', '--agent'], { DECS_AUTHOR: undefined, NODDIT_WORKTREE: '/lanes/lane-one' })
  assert.equal(p.get(1).notes.at(-1).author, 'lane-one · work', 'reuses lane ones own remembered author, not lane twos')
})
