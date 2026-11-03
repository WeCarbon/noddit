import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'

import { parseDecision } from '../src/core/parse.ts'
import { serializeDecision } from '../src/core/serialize.ts'
import { initLayout } from '../src/core/paths.ts'
import { Store } from '../src/core/store.ts'
import { nodeDetailJson } from '../src/tui/json.ts'
import { bodyRows } from '../src/tui/model.ts'
import { scratch } from './helpers.ts'

const opts = [
  { key: '1', label: 'Postgres' },
  { key: '2', label: 'SQLite' },
]

function tmpStore(t: { after: (fn: () => void) => void }): Store {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return new Store([initLayout(root)])
}

const answerBlocks = (body: string) => body.split('\n').filter((l) => l.startsWith('## 已答（'))

test('changing an answer appends a new 已答 block and leaves every earlier byte as it was', (t) => {
  const store = tmpStore(t)
  const d = store.create({ title: 'pick a db', author: 'lane · x', options: opts, default: '1' })
  const first = store.answer(d, { choice: '1', by: 'owner', role: 'human' })
  const before = readFileSync(first.file, 'utf8').split('\n---\n').slice(1).join('\n---\n')

  store.note(store.get(d.id)!, { text: 'starting on Postgres', role: 'agent', author: 'lane' })
  const second = store.answer(store.get(d.id)!, { choice: '2', note: 'changed my mind', by: 'owner', role: 'human' })
  const after = readFileSync(second.file, 'utf8').split('\n---\n').slice(1).join('\n---\n')

  assert.ok(after.startsWith(before.trimEnd()), 'what was written before is a byte-for-byte prefix of what is there now')
  assert.equal(answerBlocks(second.body).length, 2)
  const answers = second.notes.filter((n) => n.kind === '已答')
  assert.deepEqual(answers.map((n) => n.text), ['1 —— Postgres', '2 —— SQLite\n\nchanged my mind'])
  assert.deepEqual(answers.map((n) => Boolean(n.revises)), [false, true])
  assert.equal(second.answer?.choice, '2', 'front matter describes the newest answer')
})

test('a new round starts a fresh decision: its first answer is not a change of the old one', (t) => {
  const store = tmpStore(t)
  const d = store.create({ title: 'pick a db', author: 'lane · x', options: opts, default: '1' })
  store.answer(d, { choice: '1', by: 'owner', role: 'human' })
  store.answer(store.get(d.id)!, { choice: '2', by: 'owner', role: 'human' })
  const asked = store.ask(store.get(d.id)!, { options: [{ key: '1', label: 'ship' }, { key: '2', label: 'wait' }], default: '1', author: 'lane' })
  const done = store.answer(asked, { choice: '2', by: 'owner', role: 'human' })
  const answers = done.notes.filter((n) => n.kind === '已答')
  assert.deepEqual(answers.map((n) => Boolean(n.revises)), [false, true, false])
  assert.equal(answerBlocks(done.body).length, 3, 'every answer of every round is still there')
})

test('a file written before revises existed parses, keeps every answer, and serializes back byte-for-byte', () => {
  const text = [
    '---',
    'id: 7',
    'title: pick a db',
    'author: lane · x',
    'status: in_progress',
    'created: 2026-10-20T10:00:00+08:00',
    'updated_at: 2026-10-20T10:05:00.000+08:00',
    'answer:',
    '  choice: "2"',
    '  by: owner',
    '  at: 2026-10-20T10:05:00.000+08:00',
    '---',
    '',
    '## 选项',
    '',
    '### 1 · Postgres',
    '',
    '### 2 · SQLite',
    '',
    '## 已答（owner · 2026-10-20 10:01）',
    '',
    '1 —— Postgres',
    '',
    '## 补充（agent · lane · 2026-10-20 10:02:00）',
    '',
    'on it',
    '',
    '## 已答（human · owner · 2026-10-20 10:05:00）',
    '',
    '2 —— SQLite',
    '',
  ].join('\n')
  const d = parseDecision(text, '/x/7-pick-a-db.md', false)
  assert.equal(d.state, 'in_progress', 'answered: running is fine')
  assert.deepEqual(d.notes.filter((n) => n.kind === '已答').map((n) => [n.text, Boolean(n.revises)]), [['1 —— Postgres', false], ['2 —— SQLite', true]])
  assert.equal(serializeDecision(d).split('\n---\n').slice(1).join('\n---\n'), text.split('\n---\n').slice(1).join('\n---\n'), 'the body round-trips unchanged')
  assert.equal(parseDecision(serializeDecision(d), d.file, false).notes.length, d.notes.length)
})

test('an answer is a record: nod edit refuses to rewrite one unless forced', (t) => {
  const store = tmpStore(t)
  const d = store.create({ title: 'pick a db', author: 'lane · x', options: opts, default: '1' })
  const answered = store.answer(d, { choice: '1', note: 'go', by: 'owner', role: 'human' })
  const n = answered.notes.findIndex((x) => x.kind === '已答') + 1
  assert.throws(() => store.edit(answered, { text: 'something else', note: n, by: 'owner', role: 'human' }), /is an answer/)
  assert.match(store.get(d.id)!.body, /1 —— Postgres\n\ngo/)
})

test('the terminal labels each answer block; the window gets the same facts as fields, not in the heading text', (t) => {
  const store = tmpStore(t)
  const d = store.create({ title: 'pick a db', author: 'lane · x', options: opts, default: '1' })
  store.answer(d, { choice: '1', by: 'owner', role: 'human' })
  const two = store.answer(store.get(d.id)!, { choice: '2', by: 'owner', role: 'human' })

  const heads = bodyRows(two, 200, false).filter((r) => r.style?.color === 'magenta').map((r) => r.text)
  assert.equal(heads.length, 2)
  assert.match(heads[0], /^✓ Decided  ——  User \| /)
  assert.match(heads[1], /^✎ Answer changed  ——  User \| /)

  const j = nodeDetailJson(store, two) as { notes: { kind: string; revises: boolean }[]; body_rows: { text: string }[] }
  assert.deepEqual(j.notes.filter((n) => n.kind === '已答').map((n) => n.revises), [false, true])
  assert.ok(!j.body_rows.some((r) => /Decided|Answer changed/.test(r.text)), 'the app draws its own label')
})

test('options waiting on the owner keep a node 待决策: collecting a plain reply hands it back, start refuses even with --force', (t) => {
  const store = tmpStore(t)
  const d = store.create({ title: 'pick a db', author: 'lane · x', options: opts, default: '1' })
  const replied = store.note(d, { text: 'what does SQLite cost us?', role: 'human', author: 'owner' })
  assert.equal(replied.state, 'decided', 'the reply is the AI’s to collect')
  const collected = store.deliver(replied)
  assert.equal(collected.state, 'needs_decision')
  assert.throws(() => store.start(collected, { force: true }), /still has options waiting on the owner/)
  assert.equal(store.get(d.id)!.state, 'needs_decision')

  // Once answered it runs as usual.
  const answered = store.answer(store.get(d.id)!, { choice: '2', by: 'owner', role: 'human' })
  assert.equal(store.deliver(answered).state, 'in_progress')
})

test('a started node that is asked again is 待决策, and a claimed brief asked to confirm its plan cannot be started', (t) => {
  const store = tmpStore(t)
  const task = store.create({ title: 'migrate', author: 'lane · x', task: true })
  const running = store.start(task)
  assert.equal(running.state, 'in_progress')
  assert.equal(store.ask(running, { options: opts, default: '1', author: 'lane' }).state, 'needs_decision')

  const brief = store.create({ title: 'tidy the docs', author: 'owner', intake: true, task: true })
  const { node } = store.claim(brief, 'lane · docs')
  store.expand(node, { description: 'what / why / done when' })
  const asked = store.ask(store.get(brief.id)!, { options: [{ key: '1', label: 'start as planned' }, { key: '2', label: 'change it' }], default: '1', author: 'lane · docs' })
  assert.equal(asked.state, 'needs_decision')
  assert.throws(() => store.start(asked), /waiting on the owner/)
})

test('a file left 执行中 with unanswered options reads as 待决策, and the next write stores it that way', (t) => {
  const store = tmpStore(t)
  const d = store.create({ title: 'pick a db', author: 'lane · x', options: opts, default: '1' })
  writeFileSync(d.file, readFileSync(d.file, 'utf8').replace(/^status: needs_decision$/m, 'status: in_progress'))
  const read = store.get(d.id)!
  assert.equal(read.state, 'needs_decision')
  store.note(read, { text: 'still thinking about it', role: 'agent', author: 'lane' })
  assert.match(readFileSync(d.file, 'utf8'), /^status: needs_decision$/m)
})
