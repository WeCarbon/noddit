import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { agentNameOf, currentIdentity, currentSession } from '../src/core/identity.ts'
import { parseNotes } from '../src/core/parse.ts'
import { appendSection, noteHeading } from '../src/core/serialize.ts'
import { ownedBy } from '../src/core/store.ts'
import { teammateFromTeamConfig, teammateName } from '../src/cli/commands/monitor.ts'
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

test('teammateFromTeamConfig: finds the member whose cwd matches (or is an ancestor of) ours, skips the lead and inactive ones', (t) => {
  const home = fakeHome(t)
  writeTeamConfig(home, 'proj', [
    { agentId: 'team-lead@proj', name: 'team-lead', agentType: 'team-lead', cwd: '/home/alice/code/proj' },
    { agentId: 'lane-a@proj', name: 'lane-a', agentType: 'general-purpose', cwd: '/home/alice/code/proj' },
    { agentId: 'lane-b@proj', name: 'lane-b', agentType: 'general-purpose', cwd: '/home/alice/code/proj-other', isActive: false },
  ])
  assert.equal(teammateFromTeamConfig('/home/alice/code/proj', home), 'lane-a')
  assert.equal(teammateFromTeamConfig('/home/alice/code/proj/sub/dir', home), 'lane-a', 'a subdirectory of the member\'s cwd still matches')
  assert.equal(teammateFromTeamConfig('/home/alice/code/proj-other', home), undefined, 'inactive — does not count')
  assert.equal(teammateFromTeamConfig('/home/alice/code/unrelated', home), undefined)
})

test('teammateFromTeamConfig: no ~/.claude/teams at all is just undefined, not a throw', (t) => {
  const home = fakeHome(t)
  assert.equal(teammateFromTeamConfig('/anywhere', home), undefined)
})

test('teammateName: the --agent-name a teammate\'s own process was started with; undefined for a lead', () => {
  assert.equal(teammateName('/usr/local/bin/claude --agent-name lane-a'), 'lane-a')
  assert.equal(teammateName('/usr/local/bin/claude --resume'), undefined)
})

// ---------------------------------------------------------------------------
// nod monitor: project scope by default, --all-projects to widen it (N41)
// ---------------------------------------------------------------------------

test('a bare nod monitor watches only the project under cwd; another registered project is silent until --all-projects', async (t) => {
  const a = scratch()
  const b = scratch()
  const home = scratch()
  t.after(() => rmSync(a, { recursive: true, force: true }))
  t.after(() => rmSync(b, { recursive: true, force: true }))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  decs(a, ['init', '--no-register'], { DECS_HOME: home })
  decs(b, ['init', '--no-register'], { DECS_HOME: home })
  // `nod init` skips registering a scratch/tmp path; `projects add` doesn't, so the
  // registry side of --all-projects is exercised the same way a real one would be.
  decs(a, ['projects', 'add', a], { DECS_HOME: home })
  decs(b, ['projects', 'add', b], { DECS_HOME: home })
  decs(b, ['add', 'something in project b', '-o', '1=ok'], { DECS_HOME: home })

  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, [BIN, 'monitor', '--interval', '150', '--json'], {
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

  const allProjects = spawn(process.execPath, [BIN, 'monitor', '--interval', '150', '--json', '--all-projects'], {
    cwd: a,
    env: { ...process.env, NO_COLOR: '1', DECS_AUTHOR: undefined, CLAUDECODE: '1', DECS_HOME: home },
  })
  let out2 = ''
  allProjects.stdout.on('data', (b2) => (out2 += b2))
  t.after(() => killAndWait(allProjects))
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
