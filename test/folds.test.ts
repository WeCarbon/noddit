import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initLayout } from '../src/core/paths.ts'
import { Store } from '../src/core/store.ts'
import type { Decision } from '../src/core/types.ts'
import { benchStatePath, foldFor, foldKey, foldSets, loadFolds, saveFold } from '../src/tui/folds.ts'
import { bench, has } from './tui-harness.ts'

function tmp(t: { after: (fn: () => void) => void }, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// ---------------------------------------------------------------------------
// Pure / file
// ---------------------------------------------------------------------------

test('benchStatePath follows DECS_HOME, read when called', () => {
  // join() uses the host separator, so the expected value is built the same way
  // rather than hard-coded with `/` — on Windows that would never match.
  assert.equal(benchStatePath({ DECS_HOME: join('/x', 'y') }), join('/x', 'y', 'bench-state.json'))
  assert.match(benchStatePath({}), new RegExp(`\\.decs[/\\\\]bench-state\\.json$`))
})

test('foldFor stores only departures from the default', () => {
  assert.equal(foldFor({ state: 'in_progress' }, true), 'collapsed')
  assert.equal(foldFor({ state: 'in_progress' }, false), undefined, 'open and unfolded is the default')
  assert.equal(foldFor({ state: 'completed' }, false), 'expanded')
  assert.equal(foldFor({ state: 'closed' }, true), undefined, 'finished and folded is the default')
})

test('saveFold/loadFolds round-trip, keep other fields, drop defaults, leave no temp files', (t) => {
  const home = tmp(t, 'decs-home-')
  const path = join(home, 'nested', 'bench-state.json')
  assert.deepEqual(loadFolds(path), {}, 'missing file: defaults')
  saveFold(foldKey('/p/a', 5), 'collapsed', path)
  saveFold(foldKey('/p/b', 5), 'expanded', path)
  assert.deepEqual(loadFolds(path), { '/p/a#5': 'collapsed', '/p/b#5': 'expanded' }, 'same id in two projects does not collide')

  const raw = JSON.parse(readFileSync(path, 'utf8'))
  writeFileSync(path, JSON.stringify({ ...raw, somethingElse: 42 }))
  saveFold('/p/a#5', undefined, path)
  assert.deepEqual(loadFolds(path), { '/p/b#5': 'expanded' }, 'back to default removes the key')
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).somethingElse, 42, 'other fields survive')
  assert.deepEqual(readdirSync(join(home, 'nested')), ['bench-state.json'], 'atomic write leaves no temp file')
})

test('loadFolds tolerates a corrupt or odd file; saveFold then rewrites it cleanly', (t) => {
  const home = tmp(t, 'decs-home-')
  const path = join(home, 'bench-state.json')
  for (const junk of ['{not json', '[]', '"x"', JSON.stringify({ folds: ['a'] }), JSON.stringify({ folds: { a: 'sideways', b: 'collapsed' } })]) {
    writeFileSync(path, junk)
    const folds = loadFolds(path)
    assert.ok(typeof folds === 'object')
    for (const v of Object.values(folds)) assert.ok(v === 'collapsed' || v === 'expanded')
  }
  writeFileSync(path, '{not json')
  saveFold('k#1', 'collapsed', path)
  assert.deepEqual(loadFolds(path), { 'k#1': 'collapsed' })
})

test('foldSets maps stored folds onto the tree keys, per project root', () => {
  const items = [
    { id: 1, project: 'a', state: 'in_progress' },
    { id: 1, project: 'b', state: 'completed' },
  ] as Decision[]
  const root = (d: Decision) => `/r/${d.project}`
  const { collapsed, expanded } = foldSets(items, { '/r/a#1': 'collapsed', '/r/b#1': 'expanded', '/r/c#1': 'collapsed' }, root)
  assert.deepEqual([...collapsed], ['a#1'])
  assert.deepEqual([...expanded], ['b#1'])
})

// ---------------------------------------------------------------------------
// The real App: - folds, + unfolds, and a restart remembers.
// ---------------------------------------------------------------------------

function tree(t: { after: (fn: () => void) => void }) {
  const root = tmp(t, 'decs-fold-')
  const store = new Store([initLayout(root)])
  const parent = store.create({ title: 'do it later', author: 'a · x', task: true })
  for (const n of ['child one', 'child two', 'child three']) store.create({ title: n, author: 'a · x', task: true, parent: String(parent.id) })
  store.create({ title: 'another one', author: 'a · x', task: true })
  // Keyed by the store's resolved root (/private/var/… on macOS), stable across sessions.
  return { store, root: store.layoutOf(parent).projectRoot, parent }
}

test('App: - folds the node under the cursor (+3 shown), + unfolds, and both survive a restart', async (t) => {
  const { store, root, parent } = tree(t)
  const home = tmp(t, 'decs-home-')
  const statePath = join(home, 'bench-state.json')

  const b1 = bench(t, store, { home })
  await b1.until(has(b1, /child two/))
  await b1.press('-')
  await b1.until(() => !has(b1, /child two/)())
  assert.ok(!has(b1, /child one|child two|child three/)(), 'subtree hidden')
  assert.match(b1.frame().join('\n'), /▸.*do it later.*\+3/, 'the folded row stays, with +3')
  assert.deepEqual(loadFolds(statePath), { [foldKey(root, parent.id)]: 'collapsed' })
  b1.unmount()

  const b2 = bench(t, store, { home })
  await b2.until(has(b2, /do it later/))
  await b2.quiet()
  assert.ok(!has(b2, /child two/)(), 'still folded after a restart')
  assert.match(b2.frame().join('\n'), /\+3/)

  await b2.press('+')
  await b2.until(has(b2, /child two/))
  assert.ok(has(b2, /child one/)() && has(b2, /child three/)())
  assert.deepEqual(loadFolds(statePath), {}, 'unfolded is the default again: nothing stored')
  b2.unmount()

  const b3 = bench(t, store, { home })
  await b3.until(has(b3, /do it later/))
  await b3.quiet()
  assert.ok(has(b3, /child two/)(), 'stays unfolded after another restart')
})

test('App: ← folding is remembered too; - on a leaf or outside the tree views says why nothing happened', async (t) => {
  const { store, root, parent } = tree(t)
  const home = tmp(t, 'decs-home-')
  const b = bench(t, store, { home })
  await b.until(has(b, /child two/))
  await b.press('\x1b[D')
  await b.until(() => !has(b, /child two/)())
  assert.deepEqual(loadFolds(join(home, 'bench-state.json')), { [foldKey(root, parent.id)]: 'collapsed' }, '← writes the same state')

  await b.press('\x1b[B', '-')
  await b.until(has(b, /has no sub-nodes/))
  assert.match(b.frame().join('\n'), /has no sub-nodes/)
  // All (the default here) is now last in tab order, so it takes three Tabs to
  // reach a non-tree view (Available, Active, then Decide).
  await b.press('\t', '\t', '\t', '-')
  await b.until(has(b, /Collapsing only works in Available, Active, All/))
  assert.match(b.frame().join('\n'), /Collapsing only works in Available, Active, All/)
})

test('App: never touches the real ~/.decs (the harness pins DECS_HOME)', async (t) => {
  const { store } = tree(t)
  const b = bench(t, store)
  await b.until(has(b, /do it later/))
  await b.press('-')
  await b.until(() => !has(b, /child two/)())
  assert.ok(existsSync(join(b.home, 'bench-state.json')))
  assert.notEqual(b.home, join(process.env.HOME ?? '', '.decs'))
})
