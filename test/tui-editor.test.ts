import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { descriptionOf } from '../src/core/edit.ts'
import { initLayout } from '../src/core/paths.ts'
import { Store } from '../src/core/store.ts'
import { bench, has } from './tui-harness.ts'
import { BIN } from './helpers.ts'

const A = 'lead · tui editor test'

/**
 * `E`/`e` shell out to $VISUAL/$EDITOR for real (spawnSync, inherited stdio) — no code-level
 * seam, the way NODDIT_LAUNCH_RECORD is for `nod session start`. Driving a real interactive
 * editor isn't possible here, so these tests point EDITOR at a tiny Node script that rewrites
 * the file non-interactively — the same thing a real editor does to the same temp file, so the
 * whole path (spawn, read back, store.edit, the conflict check) is exercised for real.
 */
function fakeEditorScript(dir: string, lines: string[]): string {
  const script = join(dir, 'editor.js')
  writeFileSync(script, lines.join('\n'))
  return `${process.execPath} ${script}`
}

function withEditor(t: { after: (fn: () => void) => void }, command: string) {
  const prev = process.env.EDITOR
  process.env.EDITOR = command
  t.after(() => {
    if (prev === undefined) delete process.env.EDITOR
    else process.env.EDITOR = prev
  })
}

function tmpStore(t: { after: (fn: () => void) => void }): { store: Store; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'decs-editor-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { store: new Store([initLayout(root)]), root }
}

test('App: E opens the description in $EDITOR and saves it through store.edit', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'nod-fake-editor-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  withEditor(
    t,
    fakeEditorScript(dir, [
      'const fs = require("node:fs")',
      'const file = process.argv[2]',
      'fs.writeFileSync(file, fs.readFileSync(file, "utf8") + "\\n\\nedited by the fake editor")',
    ]),
  )
  const { store } = tmpStore(t)
  const d = store.create({ title: 'write the migration', author: A, task: true, body: 'original description' })

  const b = bench(t, store, { view: 'all' })
  await b.until(has(b, /write the migration/))
  await b.press('E')
  await b.until(has(b, /edited/))
  const after = store.get(d.id)!
  assert.match(descriptionOf(after.body), /original description/)
  assert.match(descriptionOf(after.body), /edited by the fake editor/)
})

test("App: e opens the owner's own latest reply; there must be one, or it says so", async (t) => {
  const { store } = tmpStore(t)
  const d = store.create({ title: 'a task with no replies yet', author: A, task: true })
  const b = bench(t, store, { view: 'all' })
  await b.until(has(b, /a task with no replies yet/))
  await b.press('e')
  await b.until(has(b, /no reply of yours to edit/))

  const dir = mkdtempSync(join(tmpdir(), 'nod-fake-editor-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  withEditor(
    t,
    fakeEditorScript(dir, [
      'const fs = require("node:fs")',
      'fs.writeFileSync(process.argv[2], "the corrected reply text")',
    ]),
  )
  store.note(store.get(d.id)!, { text: 'the original reply', role: 'human', author: 'owner' })
  const b2 = bench(t, store, { view: 'all' })
  await b2.until(has(b2, /a task with no replies yet/))
  await b2.press('e')
  await b2.until(has(b2, /edited/))
  const after = store.get(d.id)!
  // store.edit replaces the note's text in place and appends its own audit entry after it —
  // the edited note stays at its original position, not at the end; its own wording is
  // core/store.ts's concern, not this test's.
  assert.equal(after.notes[0].text, 'the corrected reply text')
  assert.equal(after.notes.length, 2, 'the audit entry landed as a note of its own')
  assert.notEqual(after.notes[1].text, 'the corrected reply text')
})

test('App: a file the editor left unchanged is never written', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'nod-fake-editor-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  withEditor(t, fakeEditorScript(dir, ['// leaves the file exactly as it was']))
  const { store } = tmpStore(t)
  const d = store.create({ title: 'untouched', author: A, task: true, body: 'same as it ever was' })
  const b = bench(t, store, { view: 'all' })
  await b.until(has(b, /untouched/))
  const before = store.get(d.id)!.updatedAt
  await b.press('E')
  await b.quiet()
  assert.ok(!has(b, /edited/)())
  assert.equal(store.get(d.id)!.updatedAt, before)
})

test("App: a node changed by someone else while the editor was open asks to overwrite or drop — Esc drops the editor's text, o keeps it", async (t) => {
  const { store, root } = tmpStore(t)
  const d = store.create({ title: 'racing edit', author: A, task: true, body: 'base text' })
  const dir = mkdtempSync(join(tmpdir(), 'nod-fake-editor-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // The "editor" also stands in for whoever else writes to the node while it's open — the only
  // point in this whole synchronous flow where another process gets to run at all.
  withEditor(
    t,
    fakeEditorScript(dir, [
      'const { execFileSync } = require("node:child_process")',
      'const fs = require("node:fs")',
      `execFileSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(BIN)}, "note", "${d.id}", "a concurrent reply landed first", "--dir", ${JSON.stringify(root)}, "--human"])`,
      'fs.writeFileSync(process.argv[2], fs.readFileSync(process.argv[2], "utf8") + "\\n\\nmy careful rewrite")',
    ]),
  )
  const b = bench(t, store, { view: 'all' })
  await b.until(has(b, /racing edit/))
  await b.press('E')
  await b.until(has(b, /changed since the editor opened/))

  await b.press('\x1b') // drop the editor's text
  await b.until(() => !has(b, /changed since the editor opened/)())
  let fresh = store.get(d.id)!
  assert.doesNotMatch(descriptionOf(fresh.body), /my careful rewrite/)
  assert.match(fresh.body, /a concurrent reply landed first/)

  await b.press('E')
  await b.until(has(b, /changed since the editor opened/))
  await b.press('o') // overwrite anyway
  await b.until(has(b, /edited/))
  fresh = store.get(d.id)!
  assert.match(descriptionOf(fresh.body), /my careful rewrite/)
  assert.match(fresh.body, /a concurrent reply landed first/, 'the concurrent reply is still there — only the description was replaced')
})
