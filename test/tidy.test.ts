import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { initLayout, layoutFor, type Layout } from '../src/core/paths.ts'
import type { Decision } from '../src/core/types.ts'
import { recordTidyAck, recordTidySent, tidyAckOf, tidyDue, tidyFindings } from '../src/core/tidy.ts'
import { BIN, decs, killAndWait, scratch } from './helpers.ts'

function tmpLayout(t: { after: (fn: () => void) => void }): Layout {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return initLayout(root)
}

type Probe = Pick<Decision, 'id' | 'project' | 'title' | 'state' | 'author'> & Partial<Decision>

function node(overrides: Partial<Probe> & { id: number }): Decision {
  const now = new Date().toISOString()
  return {
    project: 'p',
    title: 't',
    author: 'owner',
    state: 'not_started',
    status: 'open',
    created: now,
    updatedAt: now,
    kind: 'task',
    tags: [],
    body: '',
    options: [],
    attachments: [],
    bodyAttachments: [],
    notes: [],
    approvals: [],
    file: `/x/${overrides.id}.md`,
    slug: 't',
    archived: false,
    ...overrides,
  } as Decision
}

const alwaysLive = () => true
const neverLive = () => false

// ---------------------------------------------------------------------------
// N188: tidyFindings — pure
// ---------------------------------------------------------------------------

test('tidyFindings: childrenDone — a non-terminal parent whose children are all terminal', () => {
  const parent = node({ id: 1, state: 'in_progress', children: [2, 3] })
  const kids = [node({ id: 2, parent: 1, state: 'completed' }), node({ id: 3, parent: 1, state: 'closed' })]
  const findings = tidyFindings([parent, ...kids], alwaysLive)
  assert.deepEqual(findings, [{ ref: 'X1', id: 1, project: 'p', kind: 'childrenDone', count: 2 }])
})

test('tidyFindings: childrenDone does not fire while any child is still open', () => {
  const parent = node({ id: 1, state: 'in_progress', children: [2, 3] })
  const kids = [node({ id: 2, parent: 1, state: 'completed' }), node({ id: 3, parent: 1, state: 'in_progress' })]
  assert.deepEqual(tidyFindings([parent, ...kids], alwaysLive), [])
})

test('tidyFindings: childrenDone ignores a childless node', () => {
  const lone = node({ id: 1, state: 'in_progress' })
  assert.deepEqual(tidyFindings([lone], alwaysLive), [])
})

test('tidyFindings: openChildren — a closed/completed parent with a still-open child', () => {
  const parent = node({ id: 1, state: 'completed', children: [2, 3] })
  const kids = [node({ id: 2, parent: 1, state: 'in_progress' }), node({ id: 3, parent: 1, state: 'closed' })]
  const findings = tidyFindings([parent, ...kids], alwaysLive)
  assert.deepEqual(findings, [{ ref: 'X1', id: 1, project: 'p', kind: 'openChildren', count: 1 }])
})

test('tidyFindings: a deferred subject is skipped for childrenDone — but a stale deferredAt left on a terminal node does not suppress openChildren', () => {
  const deferredParent = node({ id: 1, state: 'in_progress', deferredAt: new Date().toISOString(), children: [2] })
  const closedKid = node({ id: 2, parent: 1, state: 'completed' })
  assert.deepEqual(tidyFindings([deferredParent, closedKid], alwaysLive), [])

  // `isDeferred` (core/status.ts) never applies to a terminal state — a leftover
  // deferredAt on an already-closed node means nothing, so openChildren still fires.
  const deferredClosed = node({ id: 3, state: 'completed', deferredAt: new Date().toISOString(), children: [4] })
  const openKid = node({ id: 4, parent: 3, state: 'in_progress' })
  assert.deepEqual(tidyFindings([deferredClosed, openKid], alwaysLive), [
    { ref: 'X3', id: 3, project: 'p', kind: 'openChildren', count: 1 },
  ])
})

test('tidyFindings: an owner to-do (assignee human) is never the subject', () => {
  const parent = node({ id: 1, state: 'in_progress', assignee: 'human', children: [2] })
  const kid = node({ id: 2, parent: 1, state: 'completed' })
  assert.deepEqual(tidyFindings([parent, kid], alwaysLive), [])
})

test('tidyFindings: orphanedAuthor — in-progress, author is a lane/agent, no live monitor', () => {
  const d = node({ id: 5, state: 'in_progress', author: 'lane-x · doing work' })
  assert.deepEqual(tidyFindings([d], neverLive), [{ ref: 'X5', id: 5, project: 'p', kind: 'orphanedAuthor', author: 'lane-x' }])
  assert.deepEqual(tidyFindings([d], alwaysLive), [], 'a live monitor for that author clears it')
})

test('tidyFindings: orphanedAuthor never fires for the owner, or outside in_progress', () => {
  const ownerNode = node({ id: 6, state: 'in_progress', author: 'owner' })
  assert.deepEqual(tidyFindings([ownerNode], neverLive), [])
  const notStarted = node({ id: 7, state: 'not_started', author: 'lane-x · idle' })
  assert.deepEqual(tidyFindings([notStarted], neverLive), [])
})

test('tidyFindings: orphanedAuthor skips a deferred or human-assigned node even with a dead author', () => {
  const deferred = node({ id: 8, state: 'in_progress', author: 'lane-x · work', deferredAt: new Date().toISOString() })
  assert.deepEqual(tidyFindings([deferred], neverLive), [])
  const human = node({ id: 9, state: 'in_progress', author: 'lane-x · work', assignee: 'human' })
  assert.deepEqual(tidyFindings([human], neverLive), [])
})

test('tidyFindings: a node can carry more than one finding at once', () => {
  const d = node({ id: 10, state: 'in_progress', author: 'lane-x · work', children: [11] })
  const kid = node({ id: 11, parent: 10, state: 'completed' })
  const findings = tidyFindings([d, kid], neverLive)
  assert.equal(findings.length, 2)
  assert.ok(findings.some((f) => f.kind === 'childrenDone'))
  assert.ok(findings.some((f) => f.kind === 'orphanedAuthor'))
})

test('tidyFindings: findings are scoped per project — ids only collide within the same one', () => {
  const a = node({ id: 1, project: 'a', state: 'completed', children: [2] })
  const aKid = node({ id: 2, project: 'a', parent: 1, state: 'in_progress' })
  const b = node({ id: 1, project: 'b', state: 'in_progress' })
  const findings = tidyFindings([a, aKid, b], alwaysLive)
  assert.deepEqual(findings, [{ ref: 'X1', id: 1, project: 'a', kind: 'openChildren', count: 1 }])
})

// ---------------------------------------------------------------------------
// N189: per-session ack clock
// ---------------------------------------------------------------------------

test('tidyDue: a session with no ack on record starts its clock instead of nagging at once', (t) => {
  const l = tmpLayout(t)
  assert.equal(tidyDue(l, 'lane-x', Date.now()), undefined)
  assert.ok(tidyAckOf(l, 'lane-x'))
  // Calling again right away must not reset the clock it just started.
  const first = tidyAckOf(l, 'lane-x')!.lastAckAt
  tidyDue(l, 'lane-x', Date.now() + 1000)
  assert.equal(tidyAckOf(l, 'lane-x')!.lastAckAt, first)
})

test('tidyDue: undefined under tidy-after, attach between the two spans, push past tidy-push-after', (t) => {
  const l = tmpLayout(t)
  const prevAfter = process.env.NODDIT_TIDY_AFTER
  const prevPush = process.env.NODDIT_TIDY_PUSH_AFTER
  process.env.NODDIT_TIDY_AFTER = '10m'
  process.env.NODDIT_TIDY_PUSH_AFTER = '20m'
  t.after(() => {
    if (prevAfter === undefined) delete process.env.NODDIT_TIDY_AFTER
    else process.env.NODDIT_TIDY_AFTER = prevAfter
    if (prevPush === undefined) delete process.env.NODDIT_TIDY_PUSH_AFTER
    else process.env.NODDIT_TIDY_PUSH_AFTER = prevPush
  })

  const start = Date.parse('2026-01-01T00:00:00.000Z')
  recordTidyAck(l, 'lane-x', start)
  const min = 60_000

  assert.equal(tidyDue(l, 'lane-x', start + 5 * min), undefined, 'under tidy-after')
  assert.equal(tidyDue(l, 'lane-x', start + 11 * min), 'attach', 'past tidy-after, under tidy-push-after')
  assert.equal(tidyDue(l, 'lane-x', start + 21 * min), 'push', 'past tidy-push-after')
})

test('tidyDue: once sent, spaced by tidy-after before it is due again', (t) => {
  const l = tmpLayout(t)
  process.env.NODDIT_TIDY_AFTER = '10m'
  process.env.NODDIT_TIDY_PUSH_AFTER = '20m'
  t.after(() => {
    delete process.env.NODDIT_TIDY_AFTER
    delete process.env.NODDIT_TIDY_PUSH_AFTER
  })
  const start = Date.parse('2026-01-01T00:00:00.000Z')
  recordTidyAck(l, 'lane-x', start)
  const min = 60_000

  assert.equal(tidyDue(l, 'lane-x', start + 25 * min), 'push')
  recordTidySent(l, 'lane-x', start + 25 * min)
  assert.equal(tidyDue(l, 'lane-x', start + 30 * min), undefined, 'spaced — only 5m since the last send')
  assert.equal(tidyDue(l, 'lane-x', start + 36 * min), 'push', 'past tidy-after since the last send, still past tidy-push-after since the ack')
})

test('nod tidy ack (recordTidyAck) resets the clock, including after a send', (t) => {
  const l = tmpLayout(t)
  process.env.NODDIT_TIDY_AFTER = '10m'
  process.env.NODDIT_TIDY_PUSH_AFTER = '20m'
  t.after(() => {
    delete process.env.NODDIT_TIDY_AFTER
    delete process.env.NODDIT_TIDY_PUSH_AFTER
  })
  const start = Date.parse('2026-01-01T00:00:00.000Z')
  recordTidyAck(l, 'lane-x', start)
  recordTidySent(l, 'lane-x', start + 25 * 60_000)
  assert.equal(tidyDue(l, 'lane-x', start + 26 * 60_000), undefined)

  recordTidyAck(l, 'lane-x', start + 26 * 60_000)
  const entry = tidyAckOf(l, 'lane-x')!
  assert.equal(entry.lastSentAt, undefined, 'a fresh ack clears the last-sent spacing too')
  assert.equal(tidyDue(l, 'lane-x', start + 30 * 60_000), undefined, 'freshly acked, well under tidy-after again')
})

test('tidyDue: the lead (no author) and a named lane each have their own clock', (t) => {
  const l = tmpLayout(t)
  process.env.NODDIT_TIDY_AFTER = '10m'
  process.env.NODDIT_TIDY_PUSH_AFTER = '20m'
  t.after(() => {
    delete process.env.NODDIT_TIDY_AFTER
    delete process.env.NODDIT_TIDY_PUSH_AFTER
  })
  const start = Date.parse('2026-01-01T00:00:00.000Z')
  recordTidyAck(l, undefined, start)
  recordTidyAck(l, 'lane-x', start)
  recordTidySent(l, undefined, start + 25 * 60_000)
  assert.equal(tidyDue(l, undefined, start + 26 * 60_000), undefined, 'lead just sent, spaced')
  assert.equal(tidyDue(l, 'lane-x', start + 26 * 60_000), 'push', 'lane-x never sent — unaffected by the lead')
})

test('tidy.json is gitignored the first time anything is actually recorded', (t) => {
  const l = tmpLayout(t)
  const ignore = join(l.root, '.gitignore')
  recordTidyAck(l, 'lane-x')
  assert.ok(readFileSync(ignore, 'utf8').includes('tidy.json'))
})

// ---------------------------------------------------------------------------
// N189 end to end: nod monitor actually emitting NODDIT-TIDY, and nod tidy acking it
// ---------------------------------------------------------------------------

function spawnMonitor(root: string, env: Record<string, string>) {
  const child = spawn(process.execPath, [BIN, 'monitor', '--json', '--no-sources', '--interval', '150'], {
    cwd: root,
    env: { ...process.env, NO_COLOR: '1', CLAUDECODE: '1', ...env },
  })
  let out = ''
  child.stdout.on('data', (b) => (out += b))
  return { child, lines: () => out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) }
}

const waitFor = async (ok: () => boolean, what: string, ms = 10_000) => {
  for (const end = Date.now() + ms; !ok(); await new Promise((r) => setTimeout(r, 50)))
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
}

test('nod monitor pushes a NODDIT-TIDY line on its own past tidy-push-after, even with nothing else happening', async (t) => {
  const root = scratch()
  decs(root, ['init', '--no-register'])
  const home = join(root, 'home')
  const { child, lines } = spawnMonitor(root, { DECS_HOME: home, NODDIT_TIDY_AFTER: '1s', NODDIT_TIDY_PUSH_AFTER: '1s' })
  t.after(() => killAndWait(child))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  await waitFor(() => lines().some((l) => l.event === 'tidy'), 'a push tidy event with nothing else happening')
  const tidy = lines().find((l) => l.event === 'tidy')!
  assert.deepEqual(tidy.refs, [], 'an empty project still gets the nudge — zero findings is not "nothing to report"')
  assert.equal(tidy.count, 0)
})

test('nod monitor: the attach tier never fires alone, only riding along another event', async (t) => {
  const root = scratch()
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 'pick one', '-o', '1=a', '2=b'])
  const home = join(root, 'home')
  const { child, lines } = spawnMonitor(root, { DECS_HOME: home, NODDIT_TIDY_AFTER: '1s', NODDIT_TIDY_PUSH_AFTER: '1h' })
  t.after(() => killAndWait(child))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  await waitFor(() => existsSync(join(home, 'monitor')) && readdirSync(join(home, 'monitor')).some((f) => f.endsWith('.json')), 'the monitor to start')
  // Well past tidy-after (1s), still nothing else has happened — must stay quiet.
  await new Promise((r) => setTimeout(r, 1600))
  assert.equal(lines().filter((l) => l.event === 'tidy').length, 0, 'attach is due, but nothing to ride along yet')

  // Now give it something to ride along.
  decs(root, ['push', '1', '1'], { CLAUDECODE: undefined, DECS_HOME: home })
  await waitFor(() => lines().some((l) => l.event === 'answered'), 'the answer event')
  await waitFor(() => lines().some((l) => l.event === 'tidy'), 'the attached tidy event riding along it')
})

test('nod tidy acks and resets nod monitor’s own clock', async (t) => {
  const root = scratch()
  decs(root, ['init', '--no-register'])
  const home = join(root, 'home')
  const { child, lines } = spawnMonitor(root, { DECS_HOME: home, NODDIT_TIDY_AFTER: '1s', NODDIT_TIDY_PUSH_AFTER: '1s' })
  t.after(() => killAndWait(child))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  await waitFor(() => lines().some((l) => l.event === 'tidy'), 'the first push')
  const firstCount = lines().filter((l) => l.event === 'tidy').length
  assert.equal(firstCount, 1, 'spaced — not one per poll while still overdue')

  decs(root, ['tidy'], { DECS_HOME: home, CLAUDECODE: undefined })
  // For a while right after the ack, the clock must not already be overdue again.
  await new Promise((r) => setTimeout(r, 600))
  assert.equal(lines().filter((l) => l.event === 'tidy').length, firstCount, 'acked — quiet until the span passes again')

  // But the ack does not silence it forever: once another full span has passed, it's due again.
  await waitFor(() => lines().filter((l) => l.event === 'tidy').length > firstCount, 'due again after another full tidy-push-after span')
})

// ---------------------------------------------------------------------------
// nod tidy — the CLI command itself
// ---------------------------------------------------------------------------

test('nod tidy: marks every finding on a node, not just the last one written (regression)', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  const A = ['--author', 'lane-a · shipping']
  decs(root, ['add', 'parent', '--task', ...A])
  decs(root, ['start', '1', ...A])
  decs(root, ['add', 'child', '--task', '--parent', '1', ...A])
  decs(root, ['done', '2', ...A])
  // X1 is now both childrenDone (its only child is done) and orphanedAuthor
  // (lane-a has no live monitor) at once.

  const out = decs(root, ['tidy'])
  assert.match(out, /X1/)
  assert.match(out, /children all done/)
  assert.match(out, /lane-a/)

  const json = JSON.parse(decs(root, ['tidy', '--json'])) as Array<Record<string, unknown>>
  const x1 = json.find((d) => d.ref === 'X1')!
  assert.deepEqual(new Set(x1.tidy as string[]), new Set(['childrenDone', 'orphanedAuthor']))
})

test('nod tidy --mine shows only the caller’s own nodes; a bare nod tidy (lead) shows everything but the owner’s to-dos', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 'mine', '--task', '--author', 'lane-a · work'])
  decs(root, ['start', '1', '--author', 'lane-a · work'])
  decs(root, ['add', 'add child done', '--task', '--parent', '1', '--author', 'lane-a · work'])
  decs(root, ['done', '2', '--author', 'lane-a · work'])
  decs(root, ['add', 'not mine', '--task', '--author', 'lane-b · other work'])
  decs(root, ['start', '3', '--author', 'lane-b · other work'])
  decs(root, ['add', 'add child done 2', '--task', '--parent', '3', '--author', 'lane-b · other work'])
  decs(root, ['done', '4', '--author', 'lane-b · other work'])
  decs(root, ['add', 'owners own todo', '--for', 'me'])

  const mine = decs(root, ['tidy', '--mine'], { DECS_AUTHOR: 'lane-a · work' })
  assert.match(mine, /X1/)
  assert.doesNotMatch(mine, /X3/)

  const lead = decs(root, ['tidy'])
  assert.match(lead, /X1/)
  assert.match(lead, /X3/)
  assert.doesNotMatch(lead, /X5/, 'the owner’s own to-do is never a tidy subject')
})

test('nod tidy with no findings says so, and still records the ack', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])

  const l = layoutFor(root)
  assert.equal(tidyAckOf(l, undefined), undefined)
  const out = decs(root, ['tidy'])
  assert.match(out, /No nodes\./)
  const ack = tidyAckOf(l, undefined)
  assert.ok(ack)
  assert.ok(Date.now() - Date.parse(ack!.lastAckAt) < 5000)
})
