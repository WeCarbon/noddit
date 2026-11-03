import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseNoteHeading, parseNotes } from '../src/core/parse.ts'
import { noteHeading, serializeDecision } from '../src/core/serialize.ts'
import { initLayout } from '../src/core/paths.ts'
import { Store, lastHumanAt, reopenedAfterArchive } from '../src/core/store.ts'
import { parseDuration, parseSince } from '../src/core/duration.ts'
import { setLang } from '../src/i18n/index.ts'
import { BIN, decs, decsResult, killAndWait, scratch } from './helpers.ts'
import { spawnSync } from 'node:child_process'

test('note headings: old owner-only shape reads as human, new shape carries the role', () => {
  const old = parseNoteHeading('## 追问（owner · 2026-10-27 13:08）')
  assert.equal(old?.role, 'human')
  assert.equal(old?.author, 'owner')
  assert.equal(old?.kind, '追问')
  assert.equal(old?.precisionMs, 60_000)
  assert.ok(old?.at.startsWith('2026-10-27T13:08:00'))

  const lead = parseNoteHeading('## 已答（lead · 2026-10-01 09:00）')
  assert.equal(lead?.role, 'agent', 'before roles, anyone not signing as owner was not the owner')

  const fresh = parseNoteHeading(`## ${noteHeading('补充', 'agent', 'lead · ship-v2', '2026-10-28T10:51:30.123+08:00')}`)
  assert.deepEqual(
    { kind: fresh?.kind, role: fresh?.role, author: fresh?.author, precisionMs: fresh?.precisionMs },
    { kind: '补充', role: 'agent', author: 'lead · ship-v2', precisionMs: 1000 },
  )

  // Hand-written headings in real entries that happen to have parentheses.
  assert.equal(parseNoteHeading('## Recommendation (go with option 1)'), null)
  assert.equal(parseNoteHeading('## Facts (image-read lane, 2026-10-26, see items_data.py F7 block)'), null)
  assert.equal(parseNoteHeading('## Draft reply for Carol (revise before sending; just the facts)'), null)
})

test('parseNotes returns each section with its text', () => {
  const body = [
    'body text',
    '',
    '## 已答（owner · 2026-10-27 13:07）',
    '',
    '2 —— item by item',
    '',
    '## 追问（human · owner · 2026-10-27 13:08:10）',
    '',
    'one more thing',
    '',
    '## 附件',
    '',
    '- [a](b)',
  ].join('\n')
  const notes = parseNotes(body)
  assert.deepEqual(
    notes.map((n) => [n.kind, n.role, n.text]),
    [
      ['已答', 'human', '2 —— item by item'],
      ['追问', 'human', 'one more thing'],
    ],
  )
})

test('decs note from an agent shell (CLAUDECODE set) defaults to agent: not queued, archive left alone', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  const d = store.create({ title: 't', author: 'lane · x' })
  store.archive(store.deliver(store.answer(d, { choice: '1' })))

  decs(root, ['note', '1', 'done, deployed at 10:40'], { CLAUDECODE: '1' })
  const after = store.get(1)!
  assert.ok(after.archived, "an agent's note must not pull the entry out of the archive")
  assert.ok(!after.queued)
  const last = after.notes[after.notes.length - 1]
  assert.equal(last.role, 'agent')
  assert.equal(last.kind, '补充')
  assert.equal(last.author, 'cli-test · lane', 'signed with DECS_AUTHOR')
  assert.ok(!reopenedAfterArchive(after))
})

test("decs note --human reopens an archived entry and flags 'new reply after archiving'", (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  const d = store.create({ title: 't', author: 'lane · x' })
  const filed = store.archive(store.deliver(store.answer(d, { choice: '1' })))
  assert.ok(filed.archivedAt)

  decs(root, ['note', '1', '--human', "I didn't see that prompt at step 3"])
  const back = store.get(1)!
  assert.ok(!back.archived)
  assert.ok(back.queued)
  assert.ok(reopenedAfterArchive(back))
  assert.ok(readFileSync(back.file, 'utf8').includes('## 回复（human · owner · '))

  const json = JSON.parse(decs(root, ['get', '1', '--json']))
  assert.equal(json.reopened_after_archive, true)
  assert.deepEqual(
    json.notes.map((n: { kind: string; role: string; author: string }) => [n.kind, n.role, n.author]),
    [
      ['已答', 'human', 'owner'],
      ['回复', 'human', 'owner'],
    ],
  )
  assert.ok(json.notes[1].text.includes('step 3'))
  assert.match(decs(root, ['show', 'answered']), /new reply after archiving/)

  // Filing it again clears the flag without erasing the history.
  const again = store.archive(store.deliver(back))
  assert.ok(!reopenedAfterArchive({ ...again, archived: false }))
})

test('--by owner still means human, for scripts written before roles', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  store.create({ title: 't', author: 'lane · x' })
  decs(root, ['note', '1', '--by', 'owner', 'leave this one alone for now'])
  assert.ok(store.get(1)!.queued)
})

test('the bench-style append with an old owner heading still queues', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  const d = store.create({ title: 't', author: 'lane · x' })
  const asked = store.append(d, '追问（owner · 2026-10-28 10:00）', 'why?')
  assert.ok(asked.queued)
  const lane = store.append(asked, '补充（agent · lead · 2026-10-28 10:01:00）', 'because…', 'owner')
  assert.equal(lane.notes[lane.notes.length - 1].role, 'agent', 'the heading says agent, so it is agent')
})

test('durations', () => {
  assert.equal(parseDuration('90s'), 90_000)
  assert.equal(parseDuration('30m'), 1_800_000)
  assert.equal(parseDuration('1h30m'), 5_400_000)
  assert.equal(parseDuration('2d'), 172_800_000)
  assert.equal(parseDuration('15'), 900_000)
  // parseDuration's message is English in the source; this call is in-process, not through the CLI's --lang.
  setLang('en')
  assert.throws(() => parseDuration('soon'), /not a duration/)
  setLang('en')
  assert.equal(parseSince('2026-10-28T10:00:00+08:00'), '2026-10-28T10:00:00+08:00')
  assert.equal(parseSince('1h', Date.parse('2026-10-28T10:00:00Z')), '2026-10-28T09:00:00.000Z')
})

test('decs queue --stale lists answers nobody collected for longer than that', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  const old = store.answer(store.create({ title: 'left hanging', author: 'lane · x' }), { choice: '1' })
  store.answer(store.create({ title: 'just answered', author: 'lane · x' }), { choice: '1' })

  // Backdate the first answer by two hours, the way time would have.
  const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString()
  const text = readFileSync(old.file, 'utf8').replace(/^  at: .*$/m, `  at: ${twoHoursAgo}`)
  writeFileSync(old.file, text.replace(/已答（human · owner · [^）]+）/, '已答（human · owner · 2000-01-01 00:00:00）'))
  assert.ok(Date.now() - Date.parse(lastHumanAt(store.get(old.id)!)!) > 3_600_000)

  const stale = JSON.parse(decs(root, ['queue', '--stale', '1h', '--json']))
  assert.deepEqual(stale.map((d: { id: number }) => d.id), [old.id])
  assert.match(decs(root, ['queue', '--stale', '1h']), /answered 2 hours ago, not collected/)
  assert.equal(JSON.parse(decs(root, ['queue', '--json'])).length, 2)
})

test('decs changes --since returns answers, notes and moves after the cut', async (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  const a = store.create({ title: 'the early one', author: 'lane-a · x', options: [{ key: '1', label: 'a' }, { key: '2', label: 'b' }] })
  store.create({ title: "someone else's", author: 'lane-b · y' })

  await new Promise((r) => setTimeout(r, 1100))
  const cut = new Date().toISOString()
  await new Promise((r) => setTimeout(r, 1100))

  store.answer(store.get(a.id)!, { choice: '2', note: 'go with 2' })
  store.note(store.get(a.id)!, { text: 'already started work', role: 'agent', author: 'lane-a · x' })
  store.note(store.get(2)!, { text: 'why this one?', role: 'human', author: 'owner' })
  store.archive(store.deliver(store.get(a.id)!))
  // headings are second-precision: anything in next_since's second repeats next time on purpose, so step past it
  await new Promise((r) => setTimeout(r, 1100))

  const out = JSON.parse(decs(root, ['changes', '--since', cut, '--json']))
  assert.ok(out.next_since)
  // everything here lands inside one second, so same-second events across entries are ordered by id
  const of = (id: number) =>
    out.events.filter((e: { id: number }) => e.id === id).map((e: { event: string; role: string }) => [e.event, e.role])
  assert.deepEqual(of(a.id), [['answered', 'human'], ['note', 'agent'], ['completed', 'agent']], 'creations before the cut are not repeated')
  assert.deepEqual(of(2), [['note', 'human']])
  assert.equal(out.events[0].choice, '2')

  const mine = JSON.parse(decs(root, ['changes', '--since', cut, '--json', '--author', 'lane-b']))
  assert.deepEqual(mine.events.map((e: { id: number }) => e.id), [2])
  const human = JSON.parse(decs(root, ['changes', '--since', cut, '--json', '--role', 'human']))
  assert.equal(human.events.length, 2)

  const later = JSON.parse(decs(root, ['changes', '--since', out.next_since, '--json']))
  assert.equal(later.events.length, 0, 'next_since picks up where this one stopped')
})

test('decs changes counts a minute-precision heading as long as any of its minute is after the cut', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  const d = store.create({ title: 't', author: 'lane · x' })
  writeFileSync(d.file, serializeDecision({ ...d, created: '2020-01-01T00:00:00+08:00', body: `${d.body}\n## 追问（owner · 2020-10-28 10:51）\n\nold format\n` }))
  const local = (hms: string) => new Date(`2020-10-28T${hms}`).toISOString()
  assert.equal(store.changes(local('10:51:30')).length, 1, 'inside the minute: kept, never dropped')
  assert.equal(store.changes(local('10:52:00')).length, 0)
})

test('decs wait prints the --since to resume from', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  store.answer(store.create({ title: 't', author: 'lane · x' }), { choice: '1' })
  assert.match(decs(root, ['wait']), /nod changes --since \d{4}-\d{2}-\d{2}T/)
  assert.ok(JSON.parse(decs(root, ['wait', '--json'])).since)

  store.deliver(store.get(1)!)
  const timedOut = decsResult(root, ['wait', '--timeout', '1'])
  assert.equal(timedOut.code, 2)
  assert.match(timedOut.stderr, /nod changes --since/)
})

test('decs read --done collects and archives in one call; refuses a bare follow-up', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  store.answer(store.create({ title: 'answered', author: 'lane · x' }), { choice: '1' })
  store.note(store.create({ title: 'just a follow-up', author: 'lane · x' }), { text: '?', role: 'human', author: 'owner' })

  decs(root, ['read', '1', '--done'])
  const one = store.get(1)!
  assert.ok(one.archived && !one.queued)

  const refused = decsResult(root, ['read', '2', '--done'])
  assert.equal(refused.code, 1)
  assert.ok(store.get(2)!.queued, 'a refusal leaves the queue untouched')
})

test("decs note from the owner's own shell (no CLAUDECODE) defaults to human and queues", (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  const d = store.create({ title: 't', author: 'lane · x' })
  store.archive(store.deliver(store.answer(d, { choice: '1' })))

  decs(root, ['note', '1', "I didn't see that prompt at step 3"], { CLAUDECODE: undefined })
  const after = store.get(1)!
  const last = after.notes[after.notes.length - 1]
  assert.deepEqual([last.role, last.kind, last.author], ['human', '回复', 'owner'])
  assert.ok(after.queued, 'the owner asking wakes the lane')
  assert.ok(!after.archived)
})

test('decs note: DECS_ROLE and --agent/--human override the shell default', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  store.create({ title: 't', author: 'lane · x' })
  const lastRole = () => store.get(1)!.notes.at(-1)!.role

  decs(root, ['note', '1', 'a'], { CLAUDECODE: undefined, DECS_ROLE: 'agent' })
  assert.equal(lastRole(), 'agent', 'DECS_ROLE=agent outside Claude Code')
  decs(root, ['note', '1', 'b'], { CLAUDECODE: undefined })
  assert.equal(lastRole(), 'human')
  decs(root, ['note', '1', '--agent', 'c'], { CLAUDECODE: undefined })
  assert.equal(lastRole(), 'agent', '--agent wins over the owner-shell default')
  decs(root, ['note', '1', '--human', 'd'], { CLAUDECODE: '1' })
  assert.equal(lastRole(), 'human', '--human wins over the agent-shell default')
  decs(root, ['note', '1', 'e'], { CLAUDECODE: '1', DECS_ROLE: 'human' })
  assert.equal(lastRole(), 'human', 'DECS_ROLE=human wins over CLAUDECODE')
})

test("owner feedback on a node waiting for them hands the turn to the AI; decs ask hands it back", (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  const d = store.create({ title: 'please review', author: 'lane · x' })
  assert.equal(d.state, 'needs_decision')

  // The owner's feedback is their turn taken: no longer "the AI stuck waiting on you".
  const fed = store.note(d, { text: 'the big image is wrong', role: 'human', author: 'owner' })
  assert.equal(fed.state, 'decided')
  assert.ok(fed.queued)
  assert.ok(!fed.answer, 'feedback is not an answer')

  // Collecting it means the AI is now working on the feedback.
  const working = store.deliver(fed)
  assert.equal(working.state, 'in_progress')

  // An agent's own record does not change whose turn it is.
  assert.equal(store.note(working, { text: 'fixed it', role: 'agent', author: 'lane' }).state, 'in_progress')

  // Ready for another look: ask the same question again, same options and default.
  const again = store.ask(store.get(d.id)!, { options: [], text: 'fixed it, take another look', author: 'lane' })
  assert.equal(again.state, 'needs_decision')
  assert.deepEqual(again.options.map((o) => o.label), ['验收通过'])
})

test('a node the owner replied to before the turn rule existed reads as the AI\'s turn', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  const d = store.create({ title: 'sign-off', author: 'lane · x' })
  // What an older decs left on disk: the reply queued, the file still needs_decision.
  store.note(d, { text: 'this icon looks wrong', role: 'human', author: 'owner' })
  const f = store.get(d.id)!.file
  writeFileSync(f, readFileSync(f, 'utf8').replace(/^status: decided$/m, 'status: needs_decision'))
  const read = store.get(d.id)!
  assert.equal(read.state, 'decided', 'on the queue = the AI owes the next move')
  assert.equal(store.deliver(read).state, 'in_progress')
})

/** Polls until `ok`, failing the test after `ms` — load decides how long a spawned monitor takes, not the test. */
async function waitFor(ok: () => boolean, what: string, ms = 15_000): Promise<void> {
  for (const start = Date.now(); Date.now() - start < ms; ) {
    if (ok()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  assert.fail(`timed out waiting for ${what}`)
}

/** A monitor has finished a poll once it has saved its cursor under DECS_HOME. */
const monitorReady = (home: string) => () => existsSync(join(home, 'monitor')) && readdirSync(join(home, 'monitor')).some((f) => f.endsWith('.json'))

/** Time for a line that should NOT appear to have shown up if it were going to: a few polls. */
const settle = () => new Promise((r) => setTimeout(r, 800))

test('decs monitor prints one line per owner reply or answer, never an agent record, and resumes with since=', async (t) => {
  const root = scratch()
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 'should we ship', '-o', '1=ship', '2=hold off', '--default', '1'])
  const { spawn } = await import('node:child_process')
  const home = join(root, 'home')
  const child = spawn(process.execPath, [BIN, 'monitor', '--with-parent', String(process.pid), '--interval', '200'], {
    cwd: root,
    env: { ...process.env, NO_COLOR: '1', DECS_AUTHOR: 'cli-test · lane', CLAUDECODE: '1', DECS_HOME: home },
  })
  let out = ''
  child.stdout.on('data', (b) => (out += b))
  t.after(() => killAndWait(child))
  await waitFor(monitorReady(home), 'the monitor to start')
  // No DECS_AUTHOR on the owner's reply: a real owner's own terminal has none — the
  // monitor's write-marker self-filter (core/identity.ts) must not mistake this for
  // the lane's own write just because the test suite's default author name matches.
  decs(root, ['note', '1', '--human', "wait for Carol's reply first"], { DECS_AUTHOR: undefined })
  decs(root, ['note', '1', '--agent', "lane's own note"])
  await waitFor(() => out.includes("Carol's reply"), 'the reply line')
  await settle()
  const lines = out.trim().split('\n').filter(Boolean)
  assert.equal(lines.length, 1, out)
  assert.match(lines[0], /^X1 owner Reply: should we ship —— wait for Carol's reply first → nod read X1 --ack "<what you'll do>"  since=\S+$/)

  // re-arming with the last since= replays nothing already seen, but picks up what happened while no monitor ran
  const since = lines[0].split('since=')[1]
  await killAndWait(child)
  decs(root, ['note', '1', '--human', 'ship it after all'], { DECS_AUTHOR: undefined })
  const replay = spawn(process.execPath, [BIN, 'monitor', '--with-parent', String(process.pid), '--since', since, '--interval', '200'], {
    cwd: root,
    env: { ...process.env, NO_COLOR: '1', DECS_AUTHOR: 'cli-test · lane', CLAUDECODE: '1', DECS_HOME: home },
  })
  let out2 = ''
  replay.stdout.on('data', (b) => (out2 += b))
  t.after(() => killAndWait(replay))
  await waitFor(() => /ship it after all/.test(out2), 'the reply made while no monitor ran')
  // Registered last, so it runs last — after both monitors above are confirmed
  // dead. Windows won't remove a directory that's still a live process's cwd.
  t.after(() => rmSync(root, { recursive: true, force: true }))
})

test('decs monitor --mine still reports an answer nobody collected on a node filed under another name', async (t) => {
  const root = scratch()
  decs(root, ['init', '--no-register'])
  // A lead files for a lane: the node is signed by the lane, not by the lead.
  decs(root, ['add', 'check the mail', '--author', 'mail-deliv · check delivery', '-o', '1=check', '2=skip it'])
  decs(root, ['push', '1', '1'], { CLAUDECODE: undefined })
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, [BIN, 'monitor', '--with-parent', String(process.pid), '--mine', '--unclaimed-after', '0s', '--interval', '200'], {
    cwd: root,
    env: { ...process.env, NO_COLOR: '1', DECS_AUTHOR: 'lead · collect the answer', CLAUDECODE: '1', DECS_HOME: join(root, 'home') },
  })
  let out = ''
  child.stdout.on('data', (b) => (out += b))
  // Before the rmSync below: Windows won't remove a directory that's still a
  // live process's cwd.
  t.after(() => killAndWait(child))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  await waitFor(() => out.includes('DECS-UNCLAIMED'), 'the unclaimed-answer line')
  await settle()
  const lines = out.trim().split('\n').filter((l) => l.startsWith('DECS-UNCLAIMED'))
  assert.equal(lines.length, 1, out)
  // The exact span (dayjs-formatted, "a few seconds" for anything under a minute) isn't the point here.
  assert.match(lines[0], /^DECS-UNCLAIMED X1 answered .*ago, not collected: check the mail \(proposed by mail-deliv · check delivery\) → nod read X1 --ack "…", or hand it to whoever is on it$/)
})

test('decs add under another agent\'s name warns that --mine will not see it', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  const run = (argv: string[]) =>
    spawnSync(process.execPath, [BIN, ...argv], { cwd: root, input: '', encoding: 'utf8', env: { ...process.env, DECS_AUTHOR: 'lead · y', CLAUDECODE: '1' } })
  assert.match(run(['add', 't', '--task', '--author', 'mail-deliv · x']).stderr, /proposed by "mail-deliv".*monitor --mine` will not see/)
  assert.doesNotMatch(run(['add', 't2', '--task', '--author', 'lead · z']).stderr, /proposed by/)
})

test('a bare decs monitor re-armed after a gap picks up what happened in between, without since=', async (t) => {
  const root = scratch()
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 'should we ship', '-o', '1=ship', '2=hold off'])
  const { spawn } = await import('node:child_process')
  const env = { ...process.env, NO_COLOR: '1', DECS_AUTHOR: 'lead · x', CLAUDECODE: '1', DECS_HOME: join(root, 'home') }
  const start = () => {
    const c = spawn(process.execPath, [BIN, 'monitor', '--with-parent', String(process.pid), '--interval', '200', '--no-sources'], { cwd: root, env })
    let out = ''
    c.stdout.on('data', (b) => (out += b))
    t.after(() => killAndWait(c))
    return { c, out: () => out }
  }
  const first = start()
  await waitFor(monitorReady(join(root, 'home')), 'the first monitor to save where it got to')
  await killAndWait(first.c)
  // Happens while no monitor is running — the gap between expiry and re-arm.
  decs(root, ['note', '1', '--human', 'said in the gap'])
  decs(root, ['read', '1'])
  const second = start()
  await waitFor(() => /said in the gap/.test(second.out()), 'the reply made in the gap')
  // Registered last, after both monitors' own kill hooks above: Windows won't
  // remove a directory that's still a live process's cwd.
  t.after(() => rmSync(root, { recursive: true, force: true }))
})

test('decs monitor notices a file changed on disk (not through decs) well before the next --interval tick (N257)', async (t) => {
  const root = scratch()
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 'edited from outside', '--task'])
  const activeDir = join(root, 'decisions', 'active')
  const file = join(activeDir, readdirSync(activeDir).find((f) => /^1-/.test(f))!)

  const { spawn } = await import('node:child_process')
  // A long interval: if the update still shows up quickly, it can only be the
  // file-system watch — the poll fallback alone would not fire for 10s.
  const child = spawn(process.execPath, [BIN, 'monitor', '--with-parent', String(process.pid), '--updates', '--json', '--interval', '10000', '--no-sources', '--idle-exit', '0'], {
    cwd: root,
    env: { ...process.env, NO_COLOR: '1', DECS_AUTHOR: 'lead · x', CLAUDECODE: '1', DECS_HOME: join(root, 'home') },
  })
  let out = ''
  let err = ''
  child.stdout.on('data', (b) => (out += b))
  child.stderr.on('data', (b) => (err += b))
  // Registered before the rmSync below — t.after hooks run in the order they
  // were added, so the monitor (still writing under root/home while alive)
  // is dead before its directory is deleted out from under it. The other
  // order around is exactly how the ENOTEMPTY in N260 happened under load.
  t.after(() => killAndWait(child))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  await waitFor(() => err.includes('nod monitor: watching'), 'the monitor to start')
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(out, '', 'nothing on start: the first pass only takes stock')

  // A plain edit with no `decs` process involved — an editor saving the file,
  // another tool, a sync client.
  const text = readFileSync(file, 'utf8').replace(/^title: .*$/m, 'title: edited from outside, now')
  writeFileSync(file, text)

  await waitFor(() => out.includes('"updated"'), 'the updated line', 2_000)
  const line = JSON.parse(out.trim().split('\n')[0])
  assert.deepEqual(line.refs, ['X1'])
  assert.ok(Array.isArray(line.changed) && line.changed.some((c: { ref: string }) => c.ref === 'X1'), 'the structured `changed` entry the app patches a node from')
})

test('decs monitor goes offline by itself after --idle-exit with no events, saying so', async (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, [BIN, 'monitor', '--with-parent', String(process.pid), '--idle-exit', '1s', '--interval', '200', '--no-sources'], {
    cwd: root,
    env: { ...process.env, NO_COLOR: '1', DECS_AUTHOR: 'lead · x', CLAUDECODE: '1', DECS_HOME: join(root, 'home') },
  })
  let out = ''
  child.stdout.on('data', (b) => (out += b))
  t.after(() => killAndWait(child))
  const code = await new Promise<number | null>((r) => child.on('exit', r))
  assert.equal(code, 0)
  assert.match(out, /^DECS-IDLE .*monitor going offline/m)
  // The line carries the exact call to arm it again.
  assert.match(out, /Monitor\(\{ command: "nod monitor", description: "nod", timeout_ms: 1800000 \}\)/)

  const mine = spawn(process.execPath, [BIN, 'monitor', '--with-parent', String(process.pid), '--mine', '--idle-exit', '1s', '--interval', '200', '--no-sources'], {
    cwd: root,
    env: { ...process.env, NO_COLOR: '1', DECS_AUTHOR: 'lane-a · x', CLAUDECODE: '1', DECS_HOME: join(root, 'home') },
  })
  let mineOut = ''
  mine.stdout.on('data', (b) => (mineOut += b))
  t.after(() => killAndWait(mine))
  await new Promise<number | null>((r) => mine.on('exit', r))
  assert.match(mineOut, /command: "nod monitor --mine"/, 'a --mine monitor is re-armed with --mine')
})

test('a teammate session is recognised from its agent process arguments', async () => {
  const { teammateName } = await import('../src/cli/commands/monitor.ts')
  assert.equal(teammateName('/x/claude --agent-id lane-a@s1 --agent-name lane-a --team-name s1'), 'lane-a')
  assert.equal(teammateName('claude --agent-name=lane-b'), 'lane-b')
  assert.equal(teammateName('claude --resume'), undefined)
})

test('parsePsLine reads a `ps -o ppid=,comm=` line, including a multi-word comm', async () => {
  const { parsePsLine } = await import('../src/cli/commands/monitor.ts')
  assert.deepEqual(parsePsLine('  1234 node'), { ppid: 1234, comm: 'node' })
  assert.deepEqual(parsePsLine('1 /usr/local/bin/claude'), { ppid: 1, comm: '/usr/local/bin/claude' })
  assert.equal(parsePsLine(''), null)
  assert.equal(parsePsLine('not-a-pid node'), null)
})

test('parseWinProcessLine reads the `ppid|command line` a Windows CIM query prints', async () => {
  const { parseWinProcessLine } = await import('../src/cli/commands/monitor.ts')
  assert.deepEqual(parseWinProcessLine('4321|C:\\Program Files\\nodejs\\node.exe --agent-name lane-a'), {
    ppid: 4321,
    comm: 'C:\\Program Files\\nodejs\\node.exe --agent-name lane-a',
  })
  assert.equal(parseWinProcessLine('no pipe here'), null)
  assert.equal(parseWinProcessLine('notanumber|node.exe'), null)
})

test('parseWinAncestors reads the `pid|ppid|command line` lines of one PowerShell walk up the tree, nearest first', async () => {
  const { parseWinAncestors } = await import('../src/core/session-process.ts')
  const out = '200|150|C:\\nodejs\\node.exe bin\\nod.js monitor\r\n150|90|"C:\\Tools\\claude.exe" --agent-name lane-a\r\n\r\nnoise\r\n'
  assert.deepEqual(parseWinAncestors(out), [
    { pid: 200, ppid: 150, comm: 'C:\\nodejs\\node.exe bin\\nod.js monitor' },
    { pid: 150, ppid: 90, comm: '"C:\\Tools\\claude.exe" --agent-name lane-a' },
  ])
  assert.deepEqual(parseWinAncestors(''), [])
})

test('imageName strips the path and arguments off a command line, quoted or not', async () => {
  const { imageName } = await import('../src/cli/commands/monitor.ts')
  assert.equal(imageName('"C:\\Program Files\\Claude\\claude.exe" --agent-name lane-a'), 'C:\\Program Files\\Claude\\claude.exe')
  assert.equal(imageName('C:\\Users\\eve\\AppData\\Local\\Programs\\claude.exe --resume'), 'C:\\Users\\eve\\AppData\\Local\\Programs\\claude.exe')
  assert.equal(imageName('/usr/local/bin/claude --resume'), '/usr/local/bin/claude')
  // The regex that actually decides "is this claude" only cares about the trailing component.
  assert.match(imageName('"C:\\Program Files\\Claude\\claude.exe" --agent-name lane-a'), /claude\.exe$/i)
})

async function monitorAs(teammate: string, args: string[], act: (root: string) => void): Promise<string> {
  const root = scratch()
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 'mine', '--task', '--author', 'lane-a · x'])
  decs(root, ['add', 'theirs', '--task', '--author', 'lane-b · y'])
  decs(root, ['push', '2', '--note', 'answered long ago'], { CLAUDECODE: undefined })
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, [BIN, 'monitor', '--with-parent', String(process.pid), '--interval', '200', '--no-sources', '--unclaimed-after', '0s', ...args], {
    cwd: root,
    env: { ...process.env, NO_COLOR: '1', DECS_TEAMMATE: teammate, DECS_LANG: 'en', CLAUDECODE: '1', DECS_HOME: join(root, 'home') },
  })
  let out = ''
  child.stdout.on('data', (b) => (out += b))
  await waitFor(monitorReady(join(root, 'home')), 'the monitor to start')
  act(root)
  await waitFor(() => out.includes('for lane-a'), "lane-a's reply")
  await settle()
  // Windows won't remove a directory that's still a live process's cwd —
  // the monitor must actually be gone before the rmSync below runs.
  await killAndWait(child)
  rmSync(root, { recursive: true, force: true })
  return out
}

test("in a teammate session the monitor only reports that teammate's nodes, and leaves unclaimed answers to the lead", async () => {
  const out = await monitorAs('lane-a', [], (root) => {
    decs(root, ['note', '1', '--human', 'for lane-a'])
    decs(root, ['note', '2', '--human', 'for lane-b'])
  })
  assert.match(out, /for lane-a/)
  assert.doesNotMatch(out, /lane-b|theirs|DECS-UNCLAIMED/)
})

test('--all in a teammate session watches everything, as the lead does', async () => {
  const out = await monitorAs('lane-a', ['--all'], (root) => {
    decs(root, ['note', '1', '--human', 'for lane-a'])
    decs(root, ['note', '2', '--human', 'for lane-b'])
  })
  assert.match(out, /for lane-a/)
  assert.match(out, /for lane-b/)
})

// ---------------------------------------------------------------------------
// owner_facing (N47): an agent's first reply after a human post is an event
// worth notifying on, not just a record — for the desktop app.
// ---------------------------------------------------------------------------

test('store.changes: an agent note is ownerFacing only when it is the first reply after a human post', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  let d = store.start(store.create({ title: 't', author: 'lane · x', task: true }))
  const since = new Date(Date.now() - 1000).toISOString()

  // An agent's own note with no preceding human post: not owner-facing.
  d = store.note(d, { text: 'just working', role: 'agent', author: 'lane · x' })
  const notesOf = () => store.changes(since).filter((e) => e.event === 'note')
  assert.equal(notesOf().at(-1)?.ownerFacing, undefined)

  // The owner writes; the agent's first reply after it is owner-facing.
  d = store.note(d, { text: 'any update?', role: 'human', author: 'owner' })
  d = store.note(d, { text: 'almost done', role: 'agent', author: 'lane · x' })
  assert.equal(notesOf().at(-1)?.ownerFacing, true)

  // A second agent note before the owner writes again is not a fresh reply.
  d = store.note(d, { text: 'done now', role: 'agent', author: 'lane · x' })
  assert.equal(notesOf().at(-1)?.ownerFacing, undefined)

  // The owner never gets ownerFacing on their own note.
  store.note(d, { text: 'thanks', role: 'human', author: 'owner' })
  assert.equal(notesOf().at(-1)?.ownerFacing, undefined)
})

test('nod monitor --updates --json flags owner_facing refs for the desktop app', async (t) => {
  const root = scratch()
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 'ship it', '--task'])
  decs(root, ['start', '1'])
  const { spawn } = await import('node:child_process')
  const home = join(root, 'home')
  const child = spawn(process.execPath, [BIN, 'monitor', '--with-parent', String(process.pid), '--updates', '--json', '--interval', '150'], {
    cwd: root,
    env: { ...process.env, NO_COLOR: '1', DECS_AUTHOR: 'cli-test · lane', CLAUDECODE: '1', DECS_HOME: home },
  })
  let out = ''
  child.stdout.on('data', (b) => (out += b))
  t.after(() => killAndWait(child))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const lines = () => out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const until = async (ok: () => boolean, what: string) => {
    for (const end = Date.now() + 10_000; !ok(); await new Promise((r) => setTimeout(r, 50)))
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${out}`)
  }
  // reportUpdates' first pass only takes a silent baseline snapshot — nothing prints yet.
  await until(monitorReady(home), 'the monitor to start')

  // No DECS_AUTHOR: a real owner's own terminal has none.
  decs(root, ['note', '1', '--human', "how's it going?"], { DECS_AUTHOR: undefined })
  await until(() => lines().some((l) => l.event === 'updated' && l.refs.includes('X1') && !l.owner_facing?.length), 'the owner note update')

  decs(root, ['note', '1', '--agent', 'almost there'])
  await until(() => lines().some((l) => l.event === 'updated' && l.owner_facing?.includes('X1')), 'the owner-facing agent reply')
})
