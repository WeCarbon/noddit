import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseArgs } from '../src/cli/args.ts'
import { initLayout } from '../src/core/paths.ts'
import { parsePreviousRounds } from '../src/core/parse.ts'
import { OTHER_KEY, parseAnswerTokens, parseQuestions, renderAnswerLines, renderQuestionsBlock } from '../src/core/questions.ts'
import { Store } from '../src/core/store.ts'
import { decs, decsResult, scratch } from './helpers.ts'

const ADD = [
  'add', '3 open items in the PR review',
  '--question', 'Q1', 'asterisk in the header', '-o', 'Q1:A=keep the original', 'Q1:B=change it back to Amount [%]', '--default', 'Q1:A',
  '--question', 'Q2', 'exchange-rate case', '-o', 'Q2:1=switch', 'Q2:2=keep the skip', '--default', 'Q2:1',
  '--question', 'Q3=line items on the bill', '-o', "default:Q3:1=don't do it", 'Q3:2=do it',
]

test('args: --question takes two tokens or one, and Q1:A= is an option token', () => {
  const a = parseArgs(['--question', 'Q1', 'header', '-o', 'Q1:A=keep the original', 'Q1:B=change it', 'title'])
  assert.deepEqual(a.flags.question, ['Q1=header'])
  assert.deepEqual(a.flags.o, ['Q1:A=keep the original', 'Q1:B=change it'])
  assert.deepEqual(a._, ['title'])
})

test('add --question writes a readable 子问题 block that parses back; push Q1=B Q2=1 Q3=2', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ADD)

  const d = JSON.parse(decs(root, ['get', '1', '--json']))
  assert.deepEqual(d.questions.map((q: { key: string; default: string }) => [q.key, q.default]), [['Q1', 'A'], ['Q2', '1'], ['Q3', '1']])
  assert.deepEqual(d.options.map((o: { label: string }) => o.label), ['全部按默认（Q1=A Q2=1 Q3=1）', '逐条回复（Q1=… Q2=… Q3=…）'])
  assert.equal(d.default, '1')
  const text = readFileSync(d.file, 'utf8')
  assert.match(text, /## 子问题\n\n### Q1 · asterisk in the header\n\n#### A · keep the original/)
  assert.match(text, /question_defaults:\n  Q1: A/)

  assert.equal(decsResult(root, ['push', '1', 'Q1=B']).code, 1, 'strict: Q2 and Q3 not answered')
  assert.equal(decsResult(root, ['push', '1', 'Q1=Z', 'Q2=1', 'Q3=1']).code, 1, 'no option Z')
  decs(root, ['push', '1', 'Q1=B', 'Q2=1', 'Q3=2'])
  const answered = JSON.parse(decs(root, ['get', '1', '--json']))
  assert.deepEqual(answered.answers, { Q1: 'B', Q2: '1', Q3: '2' })
  assert.equal(answered.answer.choice, '2')
  assert.match(answered.body, /- Q1 = B —— change it back to Amount \[%\]\n- Q2 = 1 —— switch（默认）/)
})

test('push --defaults fills the rest; bench key 1 means all defaults; key 2 + note parses Qn=K', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ADD)
  decs(root, ADD)
  decs(root, ADD)

  decs(root, ['push', '1', '--defaults', 'Q2=2'])
  assert.deepEqual(JSON.parse(decs(root, ['get', '1', '--json'])).answers, { Q1: 'A', Q2: '2', Q3: '1' })

  const store = new Store([initLayout(root)])
  const viaBench = store.answer(store.get(2)!, { choice: '1', by: 'owner' })
  assert.deepEqual(viaBench.answer?.answers, { Q1: 'A', Q2: '1', Q3: '1' })
  assert.equal(viaBench.answer?.choice, '1')

  const byNote = store.answer(store.get(3)!, { choice: '2', note: 'Q1=B, Q3=2, rest unchanged', by: 'owner' })
  assert.deepEqual(byNote.answer?.answers, { Q1: 'B', Q2: '1', Q3: '2' })
})

test('--review-item: 通过 / 不通过 / 改 with the change text carried per item', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 'batch review of draft replies', '--review-item', 'R1', 'reply to Dave', '--review-item', 'R2', 'reply to Carol', '--default', 'R1:1'])
  const d = JSON.parse(decs(root, ['get', '1', '--json']))
  assert.deepEqual(d.questions[0].options.map((o: { label: string }) => o.label), ['通过', '不通过', '改（答复里写改法）'])
  assert.equal(d.questions[1].default, '2', 'not sending is the default for an unreviewed draft')

  decs(root, ['push', '1', 'R1=1', 'R2=3:delete the second paragraph'])
  const a = JSON.parse(decs(root, ['get', '1', '--json']))
  assert.deepEqual(a.answers, { R1: '1', R2: '3' })
  assert.deepEqual(a.answer_notes, { R2: 'delete the second paragraph' })
  assert.match(a.body, /R2 = 3 —— 改（答复里写改法）：delete the second paragraph/)
})

test('answer tokens only count when the key and option exist', () => {
  const qs = parseQuestions(['## 子问题', '', '### Q1 · x', '', '#### A · a', '#### B · b', ''].join('\n'))
  assert.deepEqual(parseAnswerTokens("F1=A doesn't count; Q1=C doesn't count; Q1=B is what counts", qs).answers, { Q1: 'B' })
})

test('a body with questions as prose ## Q1： headings is left alone', () => {
  const body = ["## Q1：the bill header's Amount*", '', 'body text', '', '## 选项', '', '### 1 · all per the recommendation', '', '### 2 · reply item by item'].join('\n')
  assert.deepEqual(parseQuestions(body), [])
})

/**
 * N161 (the T364 shape): round 1 asks Q1–Q3; the owner answers all
 * defaults; `nod ask` opens round 2 with plain options (no --question) —
 * its answer must carry none of round 1's sub-questions, even reset to
 * their defaults. A later round 3 asks its own, unrelated Q1 — its answer
 * must carry only that one.
 */
test('N161: a later ask round without --question has none; one with --question has only its own', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, [
    'add', 'harden the deploy keys',
    '--question', 'Q1', 'deploy via a RAM user', '-o', 'Q1:A=ram user', 'Q1:B=root key', '--default', 'Q1:A',
    '--question', 'Q2', 'secrets stay out of plaintext', '-o', 'Q2:A=use KMS', 'Q2:B=plaintext env', '--default', 'Q2:A',
    '--question', 'Q3', 'rotate the exposed keys', '-o', 'Q3:A=rotate all', 'Q3:B=AI key only', 'Q3:C=not now', '--default', 'Q3:A',
  ])
  decs(root, ['push', '1', '--defaults'])

  // Round 2: a plain re-ask, no --question — the main choice is new, nothing about Q1-Q3.
  decs(root, ['ask', '1', '-o', '1=do R1-R5 now, window later', '2=one maintenance window for everything', '3=not now'])
  const round2 = JSON.parse(decs(root, ['get', '1', '--json']))
  assert.deepEqual(round2.questions, [], 'round 2 asked no sub-questions, so it has none — not round 1\'s, not even defaulted')
  assert.equal(round2.default, null, 'no --question this round: the node default is whatever -o/--default said (none given)')

  decs(root, ['push', '1', '2'])
  const answered2 = JSON.parse(decs(root, ['get', '1', '--json']))
  assert.equal(answered2.answer.choice, '2')
  assert.equal(answered2.answers, null, 'round 2\'s answer has no Q entries at all')
  assert.equal(answered2.answer_notes, null)
  assert.match(answered2.body, /## 选项（第 2 轮）[\s\S]*## 已答[^#]*2 —— one maintenance window for everything\s*$/m)

  // Round 3: --question asks a brand new, unrelated Q1 — nothing to do with round 1's Q1.
  decs(root, ['ask', '1', '--question', 'Q1', 'when to cut over the AI key', '-o', 'Q1:A=with the 10-31 deploy', 'Q1:B=tonight', '--default', 'Q1:A'])
  const round3 = JSON.parse(decs(root, ['get', '1', '--json']))
  assert.deepEqual(round3.questions.map((q: { key: string }) => q.key), ['Q1'], 'only this round\'s own Q1 — round 1 also had a Q1, but it does not leak in')
  assert.equal(round3.questions[0].label, 'when to cut over the AI key')

  decs(root, ['push', '1', 'Q1=B'])
  const answered3 = JSON.parse(decs(root, ['get', '1', '--json']))
  assert.deepEqual(answered3.answers, { Q1: 'B' }, 'round 3\'s answer has only its own Q1 — no Q2/Q3 from round 1')
  assert.equal(answered3.answer.choice, '2')

  // Previous rounds stay visible as history, each labelled by its own round.
  assert.equal(answered3.previous_rounds.length, 2)
  const [r1, r2] = answered3.previous_rounds
  assert.equal(r1.round, 1)
  assert.deepEqual(r1.sub_answers, { Q1: 'A', Q2: 'A', Q3: 'A' })
  assert.match(r1.answer, /^1 ——/)
  assert.deepEqual(r1.options.map((o: { key: string }) => o.key), ['1', '2'])
  assert.equal(r2.round, 2)
  assert.equal(r2.sub_answers, null, 'round 2 asked no sub-questions, so it has no history of any either')
  assert.match(r2.answer, /^2 ——/)
  assert.deepEqual(r2.options.map((o: { key: string }) => o.key), ['1', '2', '3'])
})

test('N161: "all defaults" on a later round applies only to that round\'s own sub-questions', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 'batch of small fixes', '--question', 'Q1', 'fix A', '-o', 'Q1:A=yes', 'Q1:B=no', '--default', 'Q1:A'])
  decs(root, ['push', '1', '--defaults'])
  decs(root, ['ask', '1', '--question', 'Q2', 'fix B', '-o', 'Q2:A=yes', 'Q2:B=no', '--default', 'Q2:B'])
  // Key "1" (全部按默认) on round 2 must only resolve Q2 — Q1 isn't part of this round at all.
  decs(root, ['push', '1', '1'])
  const d = JSON.parse(decs(root, ['get', '1', '--json']))
  assert.deepEqual(d.answers, { Q2: 'B' })
  assert.equal(d.answer.choice, '1')
})

test('N161 migration: an old file with a later round\'s answer carrying a stale Q1-Q3 breakdown still parses with no live sub-questions, and is never rewritten just by reading it', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const layout = initLayout(root)
  mkdirSync(layout.activeDir, { recursive: true })
  const file = join(layout.activeDir, '1-legacy.md')
  // Shaped exactly like the bug produced before this fix: round 1 asked Q1-Q3;
  // round 2 is a plain re-ask, but its `## 已答` still carries Q1-Q3 reset to
  // their defaults (the leak), and `question_defaults` is still in front matter.
  const legacy = `---
id: 1
title: legacy multi-round node
author: lead · security
status: decided
created: 2026-10-28T10:00:00+08:00
default: "1"
question_defaults:
  Q1: A
  Q2: A
  Q3: A
answer:
  choice: "2"
  answers:
    Q1: A
    Q2: A
    Q3: A
  by: owner
  at: 2026-11-02T10:00:00+08:00
---

## 子问题

### Q1 · deploy via a RAM user

#### A · ram user

#### B · root key

### Q2 · secrets stay out of plaintext

#### A · use KMS

#### B · plaintext env

### Q3 · rotate the exposed keys

#### A · rotate all

#### B · not now

## 选项

### 1 · 全部按默认（Q1=A Q2=A Q3=A）

### 2 · 逐条回复（Q1=… Q2=… Q3=…）

## 已答（human · owner · 2026-10-28 10:05:00）

1 —— 全部按默认（Q1=A Q2=A Q3=A）

- Q1 = A —— ram user（默认）
- Q2 = A —— use KMS（默认）
- Q3 = A —— rotate all（默认）

## 选项（第 2 轮）

### 1 · do it now

### 2 · one maintenance window

### 3 · not now

## 已答（human · owner · 2026-11-02 10:00:00）

2 —— one maintenance window

- Q1 = A —— ram user（默认）
- Q2 = A —— use KMS（默认）
- Q3 = A —— rotate all（默认）
`
  writeFileSync(file, legacy)
  const before = readFileSync(file, 'utf8')

  const d = JSON.parse(decs(root, ['get', '1', '--json']))
  assert.deepEqual(d.questions, [], 'round 2 is current; its own 子问题 block does not exist, so it has none, whatever question_defaults still says')
  assert.equal(d.previous_rounds.length, 1)
  assert.equal(d.previous_rounds[0].round, 1)
  assert.deepEqual(d.previous_rounds[0].sub_answers, { Q1: 'A', Q2: 'A', Q3: 'A' }, 'round 1\'s own history, read straight off its already-written 已答')
  assert.equal(readFileSync(file, 'utf8'), before, 'a read never rewrites the file')

  // Touching it again self-heals: the next write carries this round's real
  // (empty) sub-questions, so the stale question_defaults don't come back.
  decs(root, ['note', '1', 'picked this up', '--agent'])
  const after = readFileSync(file, 'utf8')
  assert.doesNotMatch(after, /question_defaults/, 'the next write drops the now-stale question_defaults')
})

test('parseQuestions: a round number picks exactly that round\'s own 子问题 block, ignoring every other round', () => {
  const body = [
    '## 子问题',
    '',
    '### Q1 · round 1 only',
    '',
    '#### A · a',
    '#### B · b',
    '',
    '## 选项',
    '',
    '### 1 · x',
    '',
    '## 子问题（第 3 轮）',
    '',
    '### Q1 · round 3 only, unrelated to round 1\'s Q1',
    '',
    '#### C · c',
  ].join('\n')
  assert.deepEqual(parseQuestions(body, {}, 1).map((q) => q.label), ['round 1 only'])
  assert.deepEqual(parseQuestions(body, {}, 3).map((q) => q.label), ['round 3 only, unrelated to round 1\'s Q1'])
  assert.deepEqual(parseQuestions(body, {}, 2), [], 'round 2 asked none of its own, however many rounds 1 and 3 had')
})

test('renderQuestionsBlock writes a round suffix once past round 1, and parses back the same way', () => {
  const qs = parseQuestions(['## 子问题', '', '### Q1 · x', '', '#### A · a', '#### B · b', ''].join('\n'))
  const block = renderQuestionsBlock(qs, 3)
  assert.match(block, /^## 子问题（第 3 轮）/)
  assert.deepEqual(parseQuestions(block, {}, 3).map((q) => q.key), ['Q1'])
  assert.deepEqual(parseQuestions(block, {}, 1), [], 'round 1 is not this block\'s round')
})

test('parsePreviousRounds: no earlier round means no history', () => {
  assert.deepEqual(parsePreviousRounds(['## 选项', '', '### 1 · only round'].join('\n')), [])
  assert.deepEqual(parsePreviousRounds(''), [])
})

// N184: a sub-question answered free-text ("other") instead of picking an option.

test('parseAnswerTokens: Qn=*:text keeps spaces, commas and Chinese punctuation, stopping at the next Qn= token', () => {
  const qs = parseQuestions(['## 子问题', '', '### Q1 · x', '', '#### A · a', '#### B · b', '', '### Q2 · y', '', '#### A · a', '#### B · b'].join('\n'))
  const r = parseAnswerTokens('Q1=B Q2=*:两个都不选，等下周决定, 先放一放 Q3=ignored-unknown-key', qs)
  assert.deepEqual(r.answers, { Q1: 'B', Q2: OTHER_KEY })
  assert.deepEqual(r.notes, { Q2: '两个都不选，等下周决定, 先放一放' })
})

test('parseAnswerTokens: Qn=* with no typed text is not an answer', () => {
  const qs = parseQuestions(['## 子问题', '', '### Q1 · x', '', '#### A · a', '#### B · b'].join('\n'))
  assert.deepEqual(parseAnswerTokens('Q1=*', qs).answers, {})
  assert.deepEqual(parseAnswerTokens('Q1=* Q1=B', qs).answers, { Q1: 'B' }, 'the bare Q1=* match is dropped, Q1=B still counts')
})

test('renderAnswerLines: an other pick writes 其他 and the typed text; a normal pick is unchanged', () => {
  const qs = parseQuestions(['## 子问题', '', '### Q1 · x', '', '#### A · a', '#### B · b', '', '### Q2 · y', '', '#### A · a', '#### B · b'].join('\n'), { Q1: 'A', Q2: 'A' })
  const text = renderAnswerLines(qs, { Q1: 'A', Q2: OTHER_KEY }, { Q2: '两个都不要' })
  assert.equal(text, '- Q1 = A —— a（默认）\n- Q2 = * —— 其他：两个都不要')
})

test('push Q2=*:<text with spaces/commas/Chinese punctuation> answers free-text; nod get shows it verbatim; nod read carries it to the AI', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ADD)

  const typed = '两个都不选，再等一等；下周决定, thanks!'
  decs(root, ['push', '1', 'Q1=B', `Q2=*:${typed}`, 'Q3=2'])
  const answered = JSON.parse(decs(root, ['get', '1', '--json']))
  assert.deepEqual(answered.answers, { Q1: 'B', Q2: OTHER_KEY, Q3: '2' })
  assert.deepEqual(answered.answer_notes, { Q2: typed })
  assert.equal(answered.answer.choice, '2')
  assert.match(answered.body, /- Q1 = B —— change it back to Amount \[%\]\n- Q2 = \* —— 其他：两个都不选，再等一等；下周决定, thanks!\n- Q3 = 2/)

  // The on-disk heading itself stays the file format untouched — only the line inside 已答 is new.
  const text = readFileSync(answered.file, 'utf8')
  assert.match(text, /## 已答（agent · cli-test · lane · /)

  const read = decs(root, ['read', '1', '--peek'])
  assert.match(read, /Q2 = \* —— 其他：两个都不选，再等一等；下周决定, thanks!/, 'the same text an AI reads via nod read')
})

test('push Qn=* without typed text is refused: 「其他」needs the content', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ADD)
  const r = decsResult(root, ['push', '1', 'Q1=*', 'Q2=1', 'Q3=1'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /"other" needs the text you typed/)
})

test('an answered other pick survives a later round as history, same as a normal pick', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 'one question', '--question', 'Q1', 'x', '-o', 'Q1:A=a', 'Q1:B=b', '--default', 'Q1:A'])
  decs(root, ['push', '1', 'Q1=*:free text from round 1'])
  decs(root, ['ask', '1', '-o', '1=go', '2=wait'])
  decs(root, ['push', '1', '1'])
  const d = JSON.parse(decs(root, ['get', '1', '--json']))
  assert.equal(d.previous_rounds.length, 1)
  assert.deepEqual(d.previous_rounds[0].sub_answers, { Q1: OTHER_KEY })
})
