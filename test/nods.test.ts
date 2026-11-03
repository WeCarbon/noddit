import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { computeNods } from '../src/core/nods.ts'
import { NOTE_KIND } from '../src/core/format.ts'
import { initLayout } from '../src/core/paths.ts'
import { Store } from '../src/core/store.ts'
import type { Decision, DecisionNote } from '../src/core/types.ts'

type NodItem = Pick<Decision, 'notes' | 'created' | 'author'>

const note = (over: Partial<DecisionNote> = {}): DecisionNote => ({
  kind: NOTE_KIND.reply,
  role: 'human',
  author: 'owner',
  at: '2026-11-03T10:00:00+08:00',
  text: 'ok',
  heading: '',
  attachments: [],
  ...over,
})

const item = (over: Partial<NodItem> = {}): NodItem => ({ created: '2026-11-03T09:00:00+08:00', author: 'agent-x', notes: [], ...over })

// Noon local time, 3 November 2026.
const NOW = new Date(2026, 10, 3, 12, 0, 0).getTime()

test('a human note is a Nod, an agent note is not', () => {
  const s = computeNods([item({ notes: [note({ role: 'human' })] })], NOW)
  assert.equal(s.today, 1)
  const agentOnly = computeNods([item({ notes: [note({ role: 'agent' })] })], NOW)
  assert.equal(agentOnly.today, 0)
})

test('a decision answer is one Nod, whatever shape — sub-questions settle in one note', () => {
  const answered = note({ kind: NOTE_KIND.answered, text: 'Q1: A\nQ2: B\nQ3: C' })
  const s = computeNods([item({ notes: [answered] })], NOW)
  assert.equal(s.today, 1, 'one submit, one Nod, not one per sub-question')
})

test('a node the owner created directly earns one Nod at its creation', () => {
  const s = computeNods([item({ author: 'owner', created: '2026-11-03T09:00:00+08:00' })], NOW)
  assert.equal(s.today, 1)
})

test('a node an agent created earns no Nod, even with other human notes on it', () => {
  const s = computeNods([item({ author: 'lane-x · doing a thing', notes: [note({ role: 'human' })] })], NOW)
  assert.equal(s.today, 1, 'the reply still counts — only the creation itself does not')
})

test('原话 is not double-counted on top of the brief it was created with', () => {
  const brief = item({
    author: 'owner',
    created: '2026-11-03T09:00:00+08:00',
    notes: [note({ kind: NOTE_KIND.original, role: 'human', at: '2026-11-03T09:00:00+08:00' })],
  })
  const s = computeNods([brief], NOW)
  assert.equal(s.today, 1, 'creation + 原话 is one action, one Nod')
})

test('原话 filed by an agent on the owner\'s behalf is not a human note either way', () => {
  // roleOf(author) only reads 'human' when author === 'owner'; anything else is 'agent' —
  // 原话 on a non-owner-authored node is never counted even if role were mis-tagged 'human'.
  const brief = item({
    author: 'lane-remind · relaying',
    created: '2026-11-03T09:00:00+08:00',
    notes: [note({ kind: NOTE_KIND.original, role: 'agent', at: '2026-11-03T09:00:00+08:00' })],
  })
  const s = computeNods([brief], NOW)
  assert.equal(s.today, 0)
})

test('a follow-up note after the brief is its own, separate Nod', () => {
  const brief = item({
    author: 'owner',
    created: '2026-11-03T09:00:00+08:00',
    notes: [
      note({ kind: NOTE_KIND.original, role: 'human', at: '2026-11-03T09:00:00+08:00' }),
      note({ kind: NOTE_KIND.followUp, role: 'human', at: '2026-11-03T11:00:00+08:00' }),
    ],
  })
  const s = computeNods([brief], NOW)
  assert.equal(s.today, 2, 'the creation and the later follow-up are two separate owner actions')
})

test('re-asked rounds each answered separately are each their own Nod', () => {
  const d = item({
    notes: [
      note({ kind: NOTE_KIND.answered, at: '2026-11-01T09:00:00+08:00' }),
      note({ kind: NOTE_KIND.answered, at: '2026-11-02T09:00:00+08:00' }),
    ],
  })
  const s = computeNods([d], NOW)
  assert.equal(s.days.find((x) => x.date === '2026-11-01')!.count, 1)
  assert.equal(s.days.find((x) => x.date === '2026-11-02')!.count, 1)
})

test('day boundaries are local time, not UTC: 23:59 and 00:01 land on different days', () => {
  const lateNight = item({ notes: [note({ at: '2026-11-02T23:59:59+08:00' })] })
  const earlyMorning = item({ notes: [note({ at: '2026-11-03T00:00:01+08:00' })] })
  const s = computeNods([lateNight, earlyMorning], NOW)
  assert.equal(s.yesterday, 1)
  assert.equal(s.today, 1)
})

test('today, yesterday and the 7-day window line up against `now`', () => {
  const items = [
    item({ notes: [note({ at: '2026-11-03T08:00:00+08:00' })] }),
    item({ notes: [note({ at: '2026-11-03T20:00:00+08:00' })] }),
    item({ notes: [note({ at: '2026-11-02T08:00:00+08:00' })] }),
    item({ notes: [note({ at: '2026-10-27T08:00:00+08:00' })] }), // 7 days back — just inside the window
    item({ notes: [note({ at: '2026-10-26T08:00:00+08:00' })] }), // 8 days back — outside the window
  ]
  const s = computeNods(items, NOW)
  assert.equal(s.today, 2)
  assert.equal(s.yesterday, 1)
  assert.equal(s.days.length, 7)
  assert.deepEqual(s.days.map((d) => d.date), ['2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03'])
  assert.equal(s.days[0].count, 0, 'the entry 8 days back falls outside the 7-day window')
  assert.equal(s.avg7, (2 + 1 + 0 + 0 + 0 + 0 + 0) / 7)
})

test('a malformed timestamp is skipped rather than throwing or miscounting', () => {
  const s = computeNods([item({ notes: [note({ at: 'not-a-date' })] })], NOW)
  assert.equal(s.today, 0)
  assert.equal(s.days.reduce((sum, d) => sum + d.count, 0), 0)
})

function tmpStore(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'decs-nods-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return new Store([initLayout(root)])
}

test('wired through the Store: a brief the owner filed and a decision the owner answered both show up as Nods today', (t) => {
  const store = tmpStore(t)
  const brief = store.create({ title: 'make onboarding faster', author: 'owner', task: true, intake: true })
  const decision = store.create({ title: 'which cdn', author: 'lane-x · test', options: [{ key: '1', label: 'keep' }, { key: '2', label: 'switch' }] })
  store.answer(decision, { choice: '1' })
  const now = Date.now()
  const s = computeNods(store.all(), now)
  assert.equal(s.today, 2, `brief creation + decision answer: ${JSON.stringify(s)}`)
  assert.equal(brief.intake, true)
})
