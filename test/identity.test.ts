import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { agentNameOf, currentIdentity, currentSession } from '../src/core/identity.ts'
import { parseNotes } from '../src/core/parse.ts'
import { appendSection, noteHeading } from '../src/core/serialize.ts'
import { ownedBy } from '../src/core/store.ts'
import { parentIsGone, teammateFromTeamConfig, teammateName } from '../src/cli/commands/monitor.ts'
import { BIN, decs, killAndWait, scratch } from './helpers.ts'

// ---------------------------------------------------------------------------
// core/identity.ts
// ---------------------------------------------------------------------------

test('agentNameOf: the part before · or ・, trimmed; undefined for nothing', () => {
  assert.equal(agentNameOf('lane-x · fixing the gate'), 'lane-x')
  assert.equal(agentNameOf('lane-y・何かやってる'), 'lane-y')
  assert.equal(agentNameOf('  solo  '), 'solo')
  assert.equal(agentNameOf(undefined), undefined)
  assert.equal(agentNameOf(''), undefined)
})

test('currentSession: CLAUDE_SESSION_ID first, then NODDIT_SESSION/DECS_SESSION, else undefined', () => {
  assert.equal(currentSession({ CLAUDE_SESSION_ID: 'abc' }), 'abc')
  assert.equal(currentSession({ NODDIT_SESSION: 'xyz' }), 'xyz')
  assert.equal(currentSession({ DECS_SESSION: 'old' }), 'old')
  assert.equal(currentSession({}), undefined)
})

test('currentIdentity: NODDIT_IDENTITY/DECS_IDENTITY wins outright; otherwise author name + session; a deliberately different variable from NODDIT_AGENT', () => {
  assert.equal(currentIdentity({ NODDIT_IDENTITY: 'pinned', NODDIT_AUTHOR: 'lane-x · y', CLAUDE_SESSION_ID: 's1' }), 'pinned')
  assert.equal(currentIdentity({ DECS_IDENTITY: 'pinned-old-name' }), 'pinned-old-name')
  assert.equal(currentIdentity({ NODDIT_AUTHOR: 'lane-x · fixing it', CLAUDE_SESSION_ID: 's1' }), 'lane-x#s1')
  assert.equal(currentIdentity({ NODDIT_AUTHOR: 'lane-x · fixing it' }), 'lane-x', 'name alone when there is no session')
  assert.equal(currentIdentity({ CLAUDE_SESSION_ID: 's1' }), 's1', 'session alone when there is no author name')
  assert.equal(currentIdentity({}), undefined, 'a bare terminal — no NODDIT_AUTHOR, no session — has no identity')
  // NODDIT_AGENT is nod session start's claude/codex/kimi choice, a different variable entirely.
  assert.equal(currentIdentity({ NODDIT_AGENT: 'codex' }), undefined)
})

// ---------------------------------------------------------------------------
// The invisible writer marker: serialize.ts writes it, parse.ts reads it back
// out and strips it from the visible text (N41).
// ---------------------------------------------------------------------------

test('appendSection stamps the current identity as an invisible marker; parseNotes strips it back out into .writer', (t) => {
  const prevAgent = process.env.NODDIT_AGENT
  const prevAuthor = process.env.NODDIT_AUTHOR
  const prevSession = process.env.CLAUDE_SESSION_ID
  process.env.NODDIT_AGENT = ''
  process.env.NODDIT_AUTHOR = 'lead · relaying'
  process.env.CLAUDE_SESSION_ID = ''
  t.after(() => {
    const restore = (k: string, v: string | undefined) => (v === undefined ? delete (process.env as Record<string, string | undefined>)[k] : (process.env[k] = v))
    restore('NODDIT_AGENT', prevAgent)
    restore('NODDIT_AUTHOR', prevAuthor)
    restore('CLAUDE_SESSION_ID', prevSession)
  })

  const heading = noteHeading('回复', 'human', 'owner（对话里说，lead 转记）', '2026-10-30T12:18:39+08:00')
  const body = appendSection('some existing body', heading, "the owner's own words")
  assert.match(body, /<!-- nod:by=lead -->/)

  const [note] = parseNotes(body)
  assert.equal(note.text, "the owner's own words", 'the marker never leaks into the visible text')
  assert.equal(note.writer, 'lead', 'who actually wrote it, regardless of the human signature above')
  assert.equal(note.role, 'human')
  // noteHeading strips parentheses (they delimit the heading itself).
  assert.equal(note.author, 'owner 对话里说，lead 转记')
})

test('appendSection writes no marker at all when there is no identity to stamp', () => {
  const prevAgent = process.env.NODDIT_AGENT
  const prevAuthor = process.env.NODDIT_AUTHOR
  const prevSession = process.env.CLAUDE_SESSION_ID
  delete process.env.NODDIT_AGENT
  delete process.env.NODDIT_AUTHOR
  delete process.env.CLAUDE_SESSION_ID
  try {
    const body = appendSection('body', noteHeading('回复', 'human', 'owner', '2026-10-30T12:18:39+08:00'), 'text')
    assert.doesNotMatch(body, /nod:by/)
    assert.equal(parseNotes(body)[0].writer, undefined)
  } finally {
    const restore = (k: string, v: string | undefined) => (v === undefined ? delete (process.env as Record<string, string | undefined>)[k] : (process.env[k] = v))
    restore('NODDIT_AGENT', prevAgent)
    restore('NODDIT_AUTHOR', prevAuthor)
    restore('CLAUDE_SESSION_ID', prevSession)
  }
})

test('parseNotes reads an old file with no marker just fine', () => {
  const body = `## ${noteHeading('补充', 'agent', 'lane-x', '2026-10-28T10:51:30+08:00')}\n\nold note, no marker`
  const [note] = parseNotes(body)
  assert.equal(note.text, 'old note, no marker')
  assert.equal(note.writer, undefined)
})

// ---------------------------------------------------------------------------
// ownedBy also matches owner_agent, not just author/claimed_by (N41)
// ---------------------------------------------------------------------------

test('ownedBy: matches the author, the owner_agent (who actually runs it), or who claimed a brief', () => {
  assert.equal(ownedBy({ author: 'lane-x · fixing it' }, 'lane-x'), true)
  assert.equal(ownedBy({ author: 'owner', ownerAgent: 'lane-x · runs it' }, 'lane-x'), true, 'filed by the owner, run by the lane')
  assert.equal(ownedBy({ author: 'owner', claimedBy: 'lane-y · claimed' }, 'lane-y'), true)
  assert.equal(ownedBy({ author: 'lane-z · other' }, 'lane-x'), false)
})

// ---------------------------------------------------------------------------
// Teammate detection fallback: ~/.claude/teams/<team>/config.json (N41)
// ---------------------------------------------------------------------------

function fakeHome(t: { after: (fn: () => void) => void }): string {
  const home = scratch()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  return home
}

function writeTeamConfig(home: string, team: string, members: Record<string, unknown>[]): void {
  const dir = join(home, '.claude', 'teams', team)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ name: team, members }))
}

test('teammateFromTeamConfig: finds the member whose cwd is exactly ours, skips the lead and inactive ones', (t) => {
  const home = fakeHome(t)
  writeTeamConfig(home, 'proj', [
    { agentId: 'team-lead@proj', name: 'team-lead', agentType: 'team-lead', cwd: '/home/alice/code/proj', backendType: 'tmux' },
    { agentId: 'lane-a@proj', name: 'lane-a', agentType: 'general-purpose', cwd: '/home/alice/code/proj/.worktrees/lane-a', backendType: 'tmux' },
    { agentId: 'lane-b@proj', name: 'lane-b', agentType: 'general-purpose', cwd: '/home/alice/code/proj-other', backendType: 'tmux', isActive: false },
  ])
  assert.equal(teammateFromTeamConfig('/home/alice/code/proj/.worktrees/lane-a', home), 'lane-a')
  assert.equal(teammateFromTeamConfig('/home/alice/code/proj/.worktrees/lane-a/sub/dir', home), undefined, 'only the exact directory matches')
  assert.equal(teammateFromTeamConfig('/home/alice/code/proj-other', home), undefined, 'inactive — does not count')
  assert.equal(teammateFromTeamConfig('/home/alice/code/unrelated', home), undefined)
  // The lead's own cwd — never the lead itself, whatever else is in the config.
  assert.equal(teammateFromTeamConfig('/home/alice/code/proj', home), undefined)
})

test('teammateFromTeamConfig: no ~/.claude/teams at all is just undefined, not a throw', (t) => {
  const home = fakeHome(t)
  assert.equal(teammateFromTeamConfig('/anywhere', home), undefined)
})

// ---------------------------------------------------------------------------
// N141: the lead's own re-armed `nod monitor` got misidentified as whichever
// in-process teammate (Agent tool: lane-weekly, lane-secrets) it had most
// recently spawned — because in-process teammates share the lead's own
// process and cwd, cwd alone can never tell them apart. Fixed by never
// matching an in-process member, and never matching at all when the lead's
// own cwd in that config also covers the query.
// ---------------------------------------------------------------------------

test('teammateFromTeamConfig: never matches an in-process teammate (Agent-tool) sharing the lead\'s cwd — the exact N141 bug', (t) => {
  const home = fakeHome(t)
  writeTeamConfig(home, 'oa', [
    { agentId: 'team-lead@web', name: 'team-lead', agentType: 'team-lead', cwd: '/home/alice/code/web', backendType: 'in-process' },
    { agentId: 'lane-weekly@web', name: 'lane-weekly', agentType: 'general-purpose', cwd: '/home/alice/code/web', backendType: 'in-process' },
    { agentId: 'lane-secrets@web', name: 'lane-secrets', agentType: 'general-purpose', cwd: '/home/alice/code/web', backendType: 'in-process' },
  ])
  // Queried from the lead's own shell — same cwd as both teammates. Before the fix this
  // picked one of them (whichever tied first/last); it must now always be undefined.
  assert.equal(teammateFromTeamConfig('/home/alice/code/web', home), undefined)
})

test('teammateFromTeamConfig: a lead + two members (one real, in-process) is never a teammate when queried as the lead', (t) => {
  const home = fakeHome(t)
  writeTeamConfig(home, 'oa', [
    { agentId: 'team-lead@web', name: 'team-lead', agentType: 'team-lead', cwd: '/home/alice/code/web' },
    { agentId: 'lane-weekly@web', name: 'lane-weekly', agentType: 'general-purpose', cwd: '/home/alice/code/web', backendType: 'in-process' },
    { agentId: 'lane-secrets@web', name: 'lane-secrets', agentType: 'general-purpose', cwd: '/home/alice/code/web', backendType: 'in-process' },
  ])
  assert.equal(teammateFromTeamConfig('/home/alice/code/web', home), undefined, 'the lead, run from the lead\'s own cwd, is never a teammate')
})

test('teammateFromTeamConfig: two non-in-process members tied at the same (ancestor) cwd length is ambiguous, not "the latest one"', (t) => {
  const home = fakeHome(t)
  writeTeamConfig(home, 'proj', [
    { agentId: 'team-lead@proj', name: 'team-lead', agentType: 'team-lead', cwd: '/home/alice/code/elsewhere' },
    { agentId: 'lane-a@proj', name: 'lane-a', agentType: 'general-purpose', cwd: '/home/alice/code/proj', backendType: 'tmux' },
    { agentId: 'lane-b@proj', name: 'lane-b', agentType: 'general-purpose', cwd: '/home/alice/code/proj', backendType: 'tmux' },
  ])
  assert.equal(teammateFromTeamConfig('/home/alice/code/proj/sub', home), undefined, 'two different names tie — never just pick one')
})

test('teammateName: the --agent-name a teammate\'s own process was started with; undefined for a lead', () => {
  assert.equal(teammateName('/usr/local/bin/claude --agent-name lane-a'), 'lane-a')
  assert.equal(teammateName('/usr/local/bin/claude --resume'), undefined)
})

// ---------------------------------------------------------------------------
// N260: --with-parent must not be fooled by PID reuse on a long-running,
// busy machine — a pid still "alive" can be a different process entirely by
// then. When --with-parent names our actual OS parent (every caller in this
// codebase passes its own pid), a changed ppid is the unambiguous signal
// instead; alive() stays the fallback for an indirect ancestor, where ppid
// comparison does not apply.
// ---------------------------------------------------------------------------

test('parentIsGone: --with-parent 0 (not given) never says to exit', () => {
  assert.equal(parentIsGone(0, 111, 111), false)
  assert.equal(parentIsGone(0, 111, 999), false)
})

test('parentIsGone: --with-parent names our own ppid — a changed ppid alone is reparenting, regardless of what alive() would say about the old number', () => {
  // The exact N260 bug: the original parent pid got recycled onto an
  // unrelated process, so a plain alive(parent) still reports true. With the
  // ppid comparison this is never even consulted for the direct-parent case.
  const aliveSaysYesToAnImpostor = () => true
  assert.equal(parentIsGone(111, 111, 111, aliveSaysYesToAnImpostor), false, 'ppid unchanged: still our real parent, no ambiguity')
  assert.equal(parentIsGone(111, 111, 1, aliveSaysYesToAnImpostor), true, 'reparented to init — gone, however alive() answers')
  assert.equal(parentIsGone(111, 111, 222, aliveSaysYesToAnImpostor), true, 'reparented to a subreaper — gone')
})

test('parentIsGone: --with-parent names an indirect ancestor (not our own ppid) — falls back to alive()', () => {
  assert.equal(parentIsGone(50, 111, 111, () => true), false, 'alive() says the ancestor is still there')
  assert.equal(parentIsGone(50, 111, 111, () => false), true, 'alive() says it is gone')
})

// ---------------------------------------------------------------------------
// nod monitor: project scope by default, --all-projects to widen it (N41)
// ---------------------------------------------------------------------------

test('a bare nod monitor watches only the project under cwd; another registered project is silent until --all-projects', async (t) => {
  const a = scratch()
  const b = scratch()
  const home = scratch()
  // Registered below, after both monitors' own t.after(killAndWait) — hooks
  // run in the order they were added, and these monitors write under `home`
  // (and watch `a`) while alive, so deleting those trees first races a still
  // -live process and can throw ENOTEMPTY under load (N260, same as N257's).
  decs(a, ['init', '--no-register'], { DECS_HOME: home })
  decs(b, ['init', '--no-register'], { DECS_HOME: home })
  // `nod init` skips registering a scratch/tmp path; `projects add` doesn't, so the
  // registry side of --all-projects is exercised the same way a real one would be.
  decs(a, ['projects', 'add', a], { DECS_HOME: home })
  decs(b, ['projects', 'add', b], { DECS_HOME: home })
  decs(b, ['add', 'something in project b', '-o', '1=ok'], { DECS_HOME: home })

  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, [BIN, 'monitor', '--with-parent', String(process.pid), '--interval', '150', '--json'], {
    cwd: a,
    env: { ...process.env, NO_COLOR: '1', DECS_AUTHOR: undefined, CLAUDECODE: '1', DECS_HOME: home },
  })
  let out = ''
  child.stdout.on('data', (b2) => (out += b2))
  t.after(() => killAndWait(child))
  const until = async (ok: () => boolean, what: string) => {
    for (const end = Date.now() + 8_000; !ok(); await new Promise((r) => setTimeout(r, 50)))
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${out}`)
  }
  // No DECS_AUTHOR on this push: clear of the self-echo marker question entirely for this test.
  decs(b, ['push', '1', '1'], { DECS_HOME: home, CLAUDECODE: undefined, DECS_AUTHOR: undefined })
  await new Promise((r) => setTimeout(r, 800))
  assert.equal(out, '', 'project b is not even registered to this bare monitor\'s own project')

  const allProjects = spawn(process.execPath, [BIN, 'monitor', '--with-parent', String(process.pid), '--interval', '150', '--json', '--all-projects'], {
    cwd: a,
    env: { ...process.env, NO_COLOR: '1', DECS_AUTHOR: undefined, CLAUDECODE: '1', DECS_HOME: home },
  })
  let out2 = ''
  allProjects.stdout.on('data', (b2) => (out2 += b2))
  t.after(() => killAndWait(allProjects))
  t.after(() => rmSync(a, { recursive: true, force: true }))
  t.after(() => rmSync(b, { recursive: true, force: true }))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  await until(() => out2.includes('"event":"answered"') || out2.includes('X1'), '--all-projects to see project b')
})

test('nod monitor outside any project, without --here/--all-projects/--dir, watches nothing and says so — never silently every registered project', async (t) => {
  const outside = scratch()
  const home = scratch()
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const { spawnSync } = await import('node:child_process')
  const env: Record<string, string> = { ...process.env, NO_COLOR: '1', DECS_HOME: home, DECS_LANG: 'en' }
  delete env.DECS_AUTHOR
  delete env.NODDIT_AUTHOR
  delete env.CLAUDECODE
  const r = spawnSync(process.execPath, [BIN, 'monitor'], { cwd: outside, env, encoding: 'utf8' })
  assert.equal(r.status, 0)
  assert.match(r.stderr, /--all-projects/)
})

// ---------------------------------------------------------------------------
// nod whoami
// ---------------------------------------------------------------------------

test('nod whoami: nothing set says so; NODDIT_IDENTITY wins outright; --json carries the pieces', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const none = decs(root, ['whoami'], { DECS_AUTHOR: undefined, CLAUDECODE: undefined })
  assert.match(none, /no identity/)

  const pinned = decs(root, ['whoami'], { NODDIT_IDENTITY: 'pinned-id', DECS_AUTHOR: undefined, CLAUDECODE: undefined })
  assert.match(pinned, /pinned-id/)

  const json = JSON.parse(decs(root, ['whoami', '--json'], { NODDIT_IDENTITY: 'pinned-id', DECS_AUTHOR: undefined, CLAUDECODE: undefined }))
  assert.deepEqual(json, { identity: 'pinned-id', explicit: true, author: null, session: null, harness: null })
})

// ---------------------------------------------------------------------------
// N141: a monitor that auto-detects itself as a teammate (no --mine/--author/
// --all given) says so loudly — in the watching line and as a DECS-WARN —
// instead of silently missing everything that isn't that name's.
// ---------------------------------------------------------------------------

test('nod monitor --json: auto-detecting as a teammate (DECS_TEAMMATE, no --mine/--author/--all) emits a warn event; --mine does not', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])

  const r = spawnSync(process.execPath, [BIN, 'monitor', '--json', '--interval', '100', '--idle-exit', '1s'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, NO_COLOR: '1', CLAUDECODE: '1', DECS_TEAMMATE: 'lane-weekly', DECS_HOME: scratch() },
  })
  // nod monitor's own DECS-IDLE line is plain text even under --json (a pre-existing,
  // unrelated quirk) — skip whatever doesn't parse rather than choke on it.
  const parseJsonLines = (out: string) =>
    out.trim().split('\n').filter(Boolean).flatMap((l) => {
      try {
        return [JSON.parse(l)]
      } catch {
        return []
      }
    })
  const lines = parseJsonLines(r.stdout)
  const warn = lines.find((l) => l.event === 'warn')
  assert.equal(warn?.kind, 'auto_filtered_as_teammate')
  assert.equal(warn?.author, 'lane-weekly')
  assert.match(r.stderr, /lane-weekly/)
  assert.match(r.stderr, /--all/)

  // The same detection, but asked for on purpose with --mine: no warning.
  const explicit = spawnSync(process.execPath, [BIN, 'monitor', '--json', '--mine', '--interval', '100', '--idle-exit', '1s'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, NO_COLOR: '1', CLAUDECODE: '1', DECS_AUTHOR: 'lane-weekly', DECS_HOME: scratch() },
  })
  const explicitLines = parseJsonLines(explicit.stdout)
  assert.equal(explicitLines.some((l) => l.event === 'warn'), false)
})

test('teammateFromTeamConfig: another team\'s teammate recorded at a broad parent folder never claims a project underneath it', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'nod-teams-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  mkdirSync(join(home, '.claude', 'teams', 'other'), { recursive: true })
  writeFileSync(join(home, '.claude', 'teams', 'other', 'config.json'), JSON.stringify({ members: [
    { name: 'team-lead', agentType: 'team-lead', cwd: '/home/alice/code/other-proj', backendType: 'in-process' },
    { name: 'research', agentType: 'claude', cwd: '/home/alice/code', backendType: 'iterm2', isActive: true },
  ] }))
  assert.equal(teammateFromTeamConfig('/home/alice/code/web', home), undefined)
})
