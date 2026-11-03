import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'

import { checkSummary, displayWidth, plainTextOf, SUMMARY_MAX_WIDTH } from '../src/core/summary.ts'
import { appendSection } from '../src/core/serialize.ts'
import { parseNotes } from '../src/core/parse.ts'
import { initLayout } from '../src/core/paths.ts'
import { Store } from '../src/core/store.ts'
import { decs, decsResult, scratch } from './helpers.ts'

// ---------------------------------------------------------------------------
// core/summary.ts — the pure functions
// ---------------------------------------------------------------------------

test('displayWidth counts CJK as two columns, Latin as one, matching the 60/120 character budget', () => {
  assert.equal(displayWidth('x'.repeat(120)), 120)
  assert.equal(displayWidth('字'.repeat(60)), 120)
  assert.equal(displayWidth('ab字字'), 6)
  assert.equal(SUMMARY_MAX_WIDTH, 120)
})

test('plainTextOf strips markdown, images, link targets and the writer/summary markers, onto one line', () => {
  const text = [
    '# Heading',
    '',
    '**bold** and _em_ and `code`',
    '- a list item',
    '> a quote',
    '[link text](https://example.com/x)',
    '![alt](img.png)',
    '<!-- nod:by=lane-x -->',
  ].join('\n')
  assert.equal(plainTextOf(text), 'Heading bold and em and code a list item a quote link text')
})

test('checkSummary: a short reply needs nothing, a long one needs --summary, --human is exempt', () => {
  const short = 'short reply'
  const long = 'x'.repeat(SUMMARY_MAX_WIDTH + 1)
  assert.equal(checkSummary(short, undefined, 'agent'), undefined)
  assert.throws(() => checkSummary(long, undefined, 'agent'), /summary/i)
  assert.equal(checkSummary(long, undefined, 'human'), undefined, '--human is never rejected')
  assert.equal(checkSummary(long, 'a fine short summary', 'human'), 'a fine short summary')
})

test('checkSummary: the summary itself is checked against the same budget, and against stray markers', () => {
  const long = 'x'.repeat(SUMMARY_MAX_WIDTH + 1)
  assert.equal(checkSummary(long, 'a fine short summary', 'agent'), 'a fine short summary')
  assert.throws(() => checkSummary(long, 'y'.repeat(SUMMARY_MAX_WIDTH + 1), 'agent'), /summary/i)
  assert.throws(() => checkSummary(long, 'has a\nline break', 'agent'), /line break|-->/i)
  assert.throws(() => checkSummary(long, 'ends the marker early --> like this', 'agent'), /line break|-->/i)
})

// ---------------------------------------------------------------------------
// The marker: invisible in the body, round-trips through parseNotes
// ---------------------------------------------------------------------------

test('appendSection with a summary writes an invisible <!-- nod:summary=… --> marker; parseNotes reads it back and strips it', () => {
  const before = '**这是什么。** 门。\n'
  const after = appendSection(before, '补充（agent · lane-x · 2026-09-11 00:30）', 'the full long reply text', '一句摘要')
  assert.ok(after.includes('<!-- nod:summary=一句摘要 -->'))
  assert.ok(!after.includes('一句摘要\n\n'), 'the marker sits on its own trailing line, not inline with the text')

  const notes = parseNotes(after)
  assert.equal(notes.length, 1)
  assert.equal(notes[0].text, 'the full long reply text', 'the marker never leaks into the visible text')
  assert.equal(notes[0].summary, '一句摘要')
})

test('a note with no summary parses with summary left undefined — old files are unaffected', () => {
  const after = appendSection('', '补充（agent · lane-x · 2026-09-11 00:30）', 'just a plain note')
  const notes = parseNotes(after)
  assert.equal(notes[0].text, 'just a plain note')
  assert.equal(notes[0].summary, undefined)
})

// ---------------------------------------------------------------------------
// nod note --summary
// ---------------------------------------------------------------------------

function tmpRoot(t: { after: (fn: () => void) => void }): string {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

const LONG = 'This reply goes on for quite a while explaining lots of detail about what was done, why it was done, and how it was checked across the whole system end to end, well past the budget.'

test('nod note: a long agent reply without --summary is refused with a copy-pasteable hint; a short one needs nothing', (t) => {
  const root = tmpRoot(t)
  const store = new Store([initLayout(root)])
  store.create({ title: 't', author: 'lane · x' })

  const refused = decsResult(root, ['note', '1', LONG, '--agent'], { CLAUDECODE: undefined })
  assert.equal(refused.code, 1)
  assert.match(refused.stderr, /--summary/)
  assert.equal(store.get(1)!.notes.length, 0, 'the refused write left nothing behind')

  decs(root, ['note', '1', 'short reply, no summary needed', '--agent'], { CLAUDECODE: undefined })
  assert.equal(store.get(1)!.notes.length, 1)
})

test('nod note --summary: stored invisibly, read back on the note, and the summary itself has the same budget', (t) => {
  const root = tmpRoot(t)
  const store = new Store([initLayout(root)])
  store.create({ title: 't', author: 'lane · x' })

  decs(root, ['note', '1', LONG, '--agent', '--summary', 'checked the whole system end to end'], { CLAUDECODE: undefined })
  const note = store.get(1)!.notes.at(-1)!
  assert.equal(note.summary, 'checked the whole system end to end')
  assert.equal(note.text, LONG)
  assert.ok(!note.text.includes('nod:summary'))

  const tooLong = decsResult(root, ['note', '1', LONG, '--agent', '--summary', 'y'.repeat(130)], { CLAUDECODE: undefined })
  assert.equal(tooLong.code, 1)
  assert.match(tooLong.stderr, /summary/i)
})

test('nod note --human is exempt from the summary requirement, whatever its length', (t) => {
  const root = tmpRoot(t)
  const store = new Store([initLayout(root)])
  store.create({ title: 't', author: 'lane · x' })
  decs(root, ['note', '1', LONG, '--human'], { CLAUDECODE: undefined })
  assert.equal(store.get(1)!.notes.at(-1)!.role, 'human')
})

test('nod run writing its own failure note (role agent, no --summary of its own) is never rejected by the summary rule', (t) => {
  const root = tmpRoot(t)
  const store = new Store([initLayout(root)])
  store.create({ title: 't', author: 'lane · x' })
  // Same shape as run.ts's internal write: a long agent note with no `summary`.
  const next = store.note(store.get(1)!, { text: LONG, role: 'agent', author: 'lane · x' })
  assert.equal(next.notes.at(-1)!.text, LONG)
})

// ---------------------------------------------------------------------------
// nod ask --summary
// ---------------------------------------------------------------------------

test('nod ask: a long question text without --summary is refused; --summary is stored and read back', (t) => {
  const root = tmpRoot(t)
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 'needs a decision', '-o', '1=a', '2=b'])

  const refused = decsResult(root, ['ask', '1', '--text', LONG])
  assert.equal(refused.code, 1)
  assert.match(refused.stderr, /--summary/)

  decs(root, ['ask', '1', '--text', LONG, '--summary', 'asking again, something changed'])
  const d = JSON.parse(decs(root, ['get', '1', '--json']))
  const asked = d.notes.find((n: { kind: string }) => n.kind !== '选项')
  assert.equal(asked?.summary, 'asking again, something changed')
})

test('nod ask: a --text that already carries its own ## 选项 block is exempt (a full document, not a reply to condense)', (t) => {
  const root = tmpRoot(t)
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 'needs a decision', '-o', '1=a', '2=b'])
  const textWithOptions = `${LONG}\n\n## 选项\n\n### 1 · a\n\n### 2 · b\n`
  decs(root, ['ask', '1', '--text', textWithOptions])
})

// ---------------------------------------------------------------------------
// nod read --ack --summary
// ---------------------------------------------------------------------------

function askedAndAnswered(root: string): void {
  decs(root, ['add', 'ship v2.4', '-o', '1=ship', '2=hold', '--default', '1'])
  decs(root, ['push', '1', '1'], { CLAUDECODE: undefined, DECS_AUTHOR: undefined })
}

test('nod read --ack: a long ack without --summary is refused and leaves the item queued (not silently delivered)', (t) => {
  const root = tmpRoot(t)
  decs(root, ['init', '--no-register'])
  askedAndAnswered(root)

  const refused = decsResult(root, ['read', '1', '--ack', LONG])
  assert.equal(refused.code, 1)
  assert.match(refused.stderr, /--summary/)
  const q = decs(root, ['queue'])
  assert.match(q, /X1/, 'the refused --ack must not have delivered the item off the queue')
})

test('nod read --ack --summary: delivers and writes the note with its summary', (t) => {
  const root = tmpRoot(t)
  decs(root, ['init', '--no-register'])
  askedAndAnswered(root)

  decs(root, ['read', '1', '--ack', LONG, '--summary', 'shipping now, will report back'])
  const d = JSON.parse(decs(root, ['get', '1', '--json']))
  assert.equal(d.notes.at(-1).summary, 'shipping now, will report back')
})
