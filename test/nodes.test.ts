import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initLayout } from '../src/core/paths.ts'
import { parseDecision, parseOptions, stateOf } from '../src/core/parse.ts'
import { serializeDecision } from '../src/core/serialize.ts'
import { Store } from '../src/core/store.ts'
import { canDecideEarly, isStartable, waitingOnOwner } from '../src/core/status.ts'
import { decs, decsResult, scratch } from './helpers.ts'
import { stalenessOf } from '../src/core/staleness.ts'

test('legacy status maps onto node statuses at read time, without rewriting', () => {
  assert.equal(stateOf('open', { archived: false, answered: false }), 'needs_decision')
  assert.equal(stateOf('open', { archived: false, answered: false, queued: true }), 'needs_decision', 'a follow-up on an open one is still needs_decision')
  assert.equal(stateOf('answered', { archived: false, answered: true, queued: true }), 'decided')
  assert.equal(stateOf('answered', { archived: false, answered: true, queued: false }), 'in_progress')
  assert.equal(stateOf('answered', { archived: true, answered: true }), 'completed')
  assert.equal(stateOf('open', { archived: true, answered: false }), 'completed')
  assert.equal(stateOf(undefined, { archived: false, answered: true }), 'in_progress')
  assert.equal(stateOf('in_progress', { archived: false, answered: false }), 'in_progress', 'new values pass through')

  const legacy = '---\nid: 7\ntitle: t\nauthor: a\nstatus: answered\nanswer:\n  choice: "1"\n  by: owner\n  at: x\n---\n\n## 选项\n\n### 1 · a\n'
  const d = parseDecision(legacy, '/x/active/D7-t.md', false)
  assert.equal(d.state, 'in_progress')
  assert.equal(d.status, 'answered', 'the bench still sees answered')
})

test('unknown front matter keys survive a write', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  const d = store.create({ title: 't', author: 'a' })
  writeFileSync(d.file, readFileSync(d.file, 'utf8').replace('---\n\n', 'future_field:\n  nested: 1\n---\n\n'))
  store.arrange([store.get(1)!])
  const text = readFileSync(store.get(1)!.file, 'utf8')
  assert.match(text, /future_field:\n  nested: 1/)
  assert.match(text, /updated_at: /)
})

test('a task: add --task → To do → start → In progress → done → Done in archived/', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 'run the full gate', '--task'])
  let d = JSON.parse(decs(root, ['get', '1', '--json']))
  assert.equal(d.status, 'not_started')
  assert.equal(d.status_label, 'To do')
  assert.deepEqual(d.options, [], 'a task has nothing to press')
  assert.equal(decs(root, ['show']).trim(), 'No nodes need a decision.', 'a task is not waiting on the owner')

  decs(root, ['start', '1'])
  assert.equal(JSON.parse(decs(root, ['get', '1', '--json'])).status, 'in_progress')
  decs(root, ['done', '1', '--note', 'gate 412/412'])
  d = JSON.parse(decs(root, ['get', '1', '--json']))
  assert.equal(d.status, 'completed')
  assert.equal(d.archived, true)
  assert.ok(d.notes.some((n: { kind: string; text: string }) => n.kind === '完成' && n.text.includes('412')))
})

test('a decision: answer → Answered, for AI → read → In progress; read --done → Done', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 'should we ship', '-o', '1=ship', '2=hold off'])
  assert.equal(JSON.parse(decs(root, ['get', '1', '--json'])).status, 'needs_decision')
  decs(root, ['push', '1', '1'])
  assert.equal(JSON.parse(decs(root, ['get', '1', '--json'])).status, 'decided')
  decs(root, ['read', '1'])
  assert.equal(JSON.parse(decs(root, ['get', '1', '--json'])).status, 'in_progress', 'collected = the AI is executing it')

  decs(root, ['add', 'another one', '-o', '1=a'])
  decs(root, ['push', '2', '1'])
  decs(root, ['read', '2', '--done'])
  assert.equal(JSON.parse(decs(root, ['get', '2', '--json'])).status, 'completed')
})

test('decs ask: a running node needs a decision again, in a new round', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 'which CDN to use', '-o', '1=switch to Cloudflare', '2=keep things as they are'])
  decs(root, ['push', '1', '1'])
  decs(root, ['read', '1'])

  decs(root, ['ask', '1', '-o', '1=use the new data', '2=ask the vendor', '3=park it for now', '--default', '2', '--text', "partway through, the vendor's data changed"])
  const d = JSON.parse(decs(root, ['get', '1', '--json']))
  assert.equal(d.status, 'needs_decision')
  assert.deepEqual(d.options.map((o: { label: string }) => o.label), ['use the new data', 'ask the vendor', 'park it for now'], 'only the new round counts')
  assert.equal(d.default, '2')
  assert.equal(d.answer, null, 'the old answer is history in the body, not the current answer')
  assert.match(d.body, /## 选项（第 2 轮）/)
  assert.match(d.body, /### 1 · switch to Cloudflare/, 'round 1 stays readable')
  assert.match(decs(root, ['show']), /which CDN to use/)

  decs(root, ['push', '1', '3'])
  assert.equal(JSON.parse(decs(root, ['get', '1', '--json'])).answer.choice, '3')
  assert.equal(decsResult(root, ['push', '1', '9']).code, 1)
})

test('several plain options blocks still add up, as in four real archived entries', () => {
  const body = ['## 选项', '', '### A · one', '', '## middle', '', '## 选项', '', '### B · two', ''].join('\n')
  assert.deepEqual(parseOptions(body).map((o) => o.key), ['A', 'B'])
  const rounds = `${body}\n## 选项（第 2 轮）\n\n### 1 · new\n`
  assert.deepEqual(parseOptions(rounds).map((o) => o.key), ['1'])
})

test('human reply on a completed node: decided + queued + back in active/; agent note leaves it', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  const d = store.create({ title: 't', author: 'lane · x', task: true })
  const done = store.complete(store.start(d))
  assert.equal(done.state, 'completed')

  assert.equal(store.note(done, { text: 'note it down', role: 'agent', author: 'lane' }).state, 'completed')
  const back = store.note(store.get(1)!, { text: 'this actually still needs one more step', role: 'human', author: 'owner' })
  assert.equal(back.state, 'decided')
  assert.ok(back.queued && !back.archived)
  assert.equal(store.deliver(back).state, 'in_progress')
})

test('close with a reason; supersede-style reasons are kept', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 'change the old process', '-o', '1=change it'])
  assert.equal(decsResult(root, ['close', '1']).code, 1, 'a reason is required')
  decs(root, ['close', '1', '--reason', 'obsolete'])
  const d = JSON.parse(decs(root, ['get', '1', '--json']))
  assert.equal(d.status, 'closed')
  assert.equal(d.close_reason, 'obsolete')
  assert.ok(d.archived)
  assert.equal(decsResult(root, ['done', '2']).code, 1)
})

test('sequence: 2 and 3 are after 1; the owner may answer them early', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 'prep the data', '--task'])
  decs(root, ['add', 'how to word the title', '-o', '1=a', '2=b', '3=c', '--after', '1'])
  decs(root, ['add', 'which region to use', '-o', '1=a', '2=b', '3=c', '4=d', '--after', '1'])
  decs(root, ['start', '1'])

  const store = new Store([initLayout(root)])
  const all = () => store.all()
  const [n1, n2, n3] = [1, 2, 3].map((id) => store.get(id)!)
  assert.ok(isStartable(n1, all()))
  assert.ok(!isStartable(n2, all()) && !isStartable(n3, all()))
  assert.ok(canDecideEarly(n2, all()), 'still answerable while 1 runs')
  assert.ok(!waitingOnOwner(n2, all()), 'the AI is not blocked on the owner yet')
  assert.match(decs(root, ['show']), /how to word the title/, 'needs_decision shows even though it is not startable')

  // The owner answers 2 early; the lane collects it — it waits, not runs.
  decs(root, ['push', '2', '2'])
  decs(root, ['read', '2'])
  assert.equal(store.get(2)!.state, 'not_started', 'decided, but parked until 1 is done')
  assert.equal(decsResult(root, ['start', '2']).code, 1, 'cannot start ahead of 1')

  // 1 finishes: 2 (answered and collected) starts; 3 (unanswered) is now blocking the AI.
  decs(root, ['done', '1'])
  assert.equal(store.get(2)!.state, 'in_progress')
  assert.ok(store.get(2)!.notes.some((n) => n.text.includes('已完成')))
  assert.ok(waitingOnOwner(store.get(3)!, all()), '3 is next and only the owner can unblock it')
  assert.equal(store.get(3)!.state, 'needs_decision')
})

test('new files have no D prefix; old D files are still read, and ids never collide across both', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const l = initLayout(root)
  const store = new Store([l])
  const legacy = store.create({ title: 'the old one', author: 'a' })
  const oldName = join(l.activeDir, `D${legacy.id}-the-old-one.md`)
  writeFileSync(oldName, serializeDecision(legacy))
  rmSync(legacy.file)
  assert.equal(store.get(1)!.title, 'the old one')
  const fresh = store.create({ title: 'the new one', author: 'a' })
  assert.equal(fresh.id, 2)
  assert.deepEqual(readdirSync(l.activeDir).sort(), ['2-the-new-one.md', 'D1-the-old-one.md'])
})

test("Waiting: a node held up outside is neither stale nor the owner's turn; start resumes it", (t) => {
  const root = mkdtempSync(join(tmpdir(), 'decs-hold-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  const d = store.start(store.create({ title: 'waiting on the customer', author: 'lane · x', task: true }))
  const held = store.hold(d, "waiting on Carol's reply", 'lane')
  assert.equal(held.state, 'waiting')
  assert.equal(store.get(d.id)!.waitingOn, "waiting on Carol's reply", 'survives a round trip through the file')
  assert.equal(stalenessOf({ ...held, updatedAt: '2000-01-01T00:00:00+08:00' }, Date.now()), 'fresh', 'waiting is not stale')
  assert.throws(() => store.hold(store.create({ title: 'q', author: 'lane · x' }), 'x', 'lane'), /owner/)
  const back = store.start(store.get(d.id)!)
  assert.equal(back.state, 'in_progress')
  assert.equal(back.waitingOn, undefined)
})
