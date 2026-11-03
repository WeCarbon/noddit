import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { decs, scratch } from './helpers.ts'

test('editing a note records which note it was — who wrote it, when, and how it starts', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', '--task', 'ship it'])
  decs(root, ['note', '1', 'first cut of the release notes', '--agent'])
  decs(root, ['edit', '1', '--note', '1'], {}, 'second cut of the release notes, with the fixes')
  const d = JSON.parse(decs(root, ['get', '1', '--json']))
  const record = d.notes[d.notes.length - 1].text as string
  assert.match(record, /^改了 cli-test · lane \d\d-\d\d \d\d:\d\d 的那条补充：「second cut of the re…」。$/)
  assert.doesNotMatch(record, /第 \d+ 条/)
})
