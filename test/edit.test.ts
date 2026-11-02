import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'

import { replaceDescription, replaceNoteText } from '../src/core/edit.ts'
import { decs, decsResult, scratch } from './helpers.ts'

const owner = { CLAUDECODE: undefined, DECS_ROLE: 'human' }

function project(t: { after: (fn: () => void) => void }): string {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 'Pick a store', '-o', '1=Cookies', '2=Redis', '--body', 'Old description.\n\n- one point'])
  decs(root, ['note', '1', 'first note by the owner', '--human'], owner)
  decs(root, ['note', '1', 'an agent note'])
  return root
}

test('edit --body replaces only the description; options, notes and headings stay byte for byte', (t) => {
  const root = project(t)
  const file = String(JSON.parse(decs(root, ['get', '1', '--json'])).file)
  const before = readFileSync(file, 'utf8')
  decs(root, ['edit', '1', '--body'], owner, '## Not a heading\n\nNew **description**, two lines\nhere.')
  const after = readFileSync(file, 'utf8')
  assert.match(after, /New \*\*description\*\*/)
  assert.match(after, /^### Not a heading$/m, 'a ## line in the text cannot start a new section')
  assert.doesNotMatch(after, /Old description/)
  // Everything from the options down is unchanged, then one note says what was edited.
  const tail = (s: string) => s.slice(s.indexOf('## 选项'))
  assert.ok(tail(after).startsWith(tail(before).trimEnd()), 'options, answers and notes untouched')
  assert.match(after, /## 补充（human · owner · [^）]+）\n\n改了描述。/)
})

test('edit --note n replaces that note\'s text only; someone else\'s note needs --force', (t) => {
  const root = project(t)
  decs(root, ['edit', '1', '--note', '1', '--text', 'first note, reworded'], owner)
  const d = JSON.parse(decs(root, ['get', '1', '--json'])) as { notes: { text: string; role: string }[] }
  assert.equal(d.notes[0].text, 'first note, reworded')
  assert.equal(d.notes[1].text, 'an agent note')
  const r = decsResult(root, ['edit', '1', '--note', '2', '--text', 'x'], owner)
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /written by someone else/)
})

test('--expect refuses when the node changed since it was opened', (t) => {
  const root = project(t)
  const opened = String(JSON.parse(decs(root, ['get', '1', '--json'])).updated_at)
  decs(root, ['note', '1', 'meanwhile, an agent wrote this'])
  const r = decsResult(root, ['edit', '1', '--body', '--expect', opened, '--text', 'mine'], owner)
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /changed since you opened it/)
})

test('the splice helpers leave every other byte alone', () => {
  const body = 'desc\n\n## 选项\n\n- **1** — a\n\n## 回复（human · owner · 2026-11-02 10:00:00）\n\nold\n\n## 附件\n\n- [a.png](a.png)\n'
  assert.equal(replaceDescription(body, 'new'), body.replace(/^desc/, 'new'))
  assert.equal(replaceNoteText(body, 1, 'newer'), body.replace('\nold\n', '\nnewer\n'))
  assert.equal(replaceNoteText(body, 3, 'x'), null)
})
