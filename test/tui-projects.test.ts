import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { addProject, readProjects } from '../src/core/config.ts'
import { initLayout } from '../src/core/paths.ts'
import { configPath, readProjectConfig, writeProjectConfig } from '../src/core/project.ts'
import { Store } from '../src/core/store.ts'
import { bench, has, KEY } from './tui-harness.ts'

const A = 'lead · tui projects test'

/** A Windows path's backslashes would otherwise read as regex escapes. */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/*
 * Rename and the letter live in the project's own decisions/decs.json (core/project.ts).
 * Add/unlink go through core/config.ts's addProject/removeProject, which write the shared
 * $DECS_HOME/config.json registry — that path is bound once at import time, not re-read per
 * call, so pointing it at a temp dir only works if it happens before this process's first
 * import of core/config.ts. test/setup.ts now does exactly that (a throwaway DECS_HOME for
 * the whole suite), so this file can exercise the real functions; the registry is still one
 * shared file across every test below (and, in principle, every other file sharing this
 * process), so assertions key off each test's own root path rather than the registry's size.
 */

function twoProjects(t: { after: (fn: () => void) => void }): Store {
  const roots = [mkdtempSync(join(tmpdir(), 'decs-tui-proj-a-')), mkdtempSync(join(tmpdir(), 'decs-tui-proj-b-'))]
  t.after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })))
  return new Store(roots.map((r) => initLayout(r)))
}

test('App: ; opens Projects on the current node\'s own project; Esc closes it', async (t) => {
  const store = twoProjects(t)
  store.create({ title: 'second project task', author: A, task: true }, store.layouts[1])
  const b = bench(t, store, { view: 'all' })
  await b.until(has(b, /second project task/))
  await b.press(';')
  await b.until(has(b, /Projects:/))
  await b.until(has(b, new RegExp(store.displayName(store.layouts[1]))))
  await b.press('\x1b')
  await b.until(() => !has(b, /Projects:/)())
})

test('App: Enter on a project row renames it, written to its own decisions/decs.json', async (t) => {
  const store = twoProjects(t)
  const b = bench(t, store, { view: 'all' })
  await b.quiet()
  await b.press(';')
  await b.until(has(b, /Projects:/))
  await b.press('\r')
  await b.until(has(b, /Rename /))
  // The field starts pre-filled with the current name (cursor at the end), same as T retitle:
  // clear it before typing the new one.
  const current = store.displayName(store.layouts[0])
  await b.press(...Array.from({ length: current.length }, () => '\x7f'), 'Marketing site', '\r')
  await b.until(has(b, /Renamed to Marketing site/))
  assert.equal(readProjectConfig(store.layouts[0]).name, 'Marketing site')
  assert.equal(JSON.parse(readFileSync(configPath(store.layouts[0]), 'utf8')).name, 'Marketing site')
})

test('App: ←/→ on a project row cycles its letter; a clash with another registered project is refused, not applied', async (t) => {
  const store = twoProjects(t)
  writeProjectConfig(store.layouts[0], { letter: 'B' })
  writeProjectConfig(store.layouts[1], { letter: 'A' })
  const b = bench(t, store, { view: 'all' })
  await b.quiet()
  await b.press(';')
  await b.until(has(b, /Projects:/))
  await b.press(KEY.down) // row 1: the second project, currently A
  await b.until(has(b, new RegExp(store.displayName(store.layouts[1]))))

  // A -> B collides with the first project's letter: refused.
  await b.press(KEY.right)
  await b.until(has(b, /already .+’s/))
  assert.equal(readProjectConfig(store.layouts[1]).letter, 'A', 'the clash left the letter untouched')

  // A -> Z (wrapping left) does not collide: applied.
  await b.press(KEY.left)
  await b.until(has(b, /is now Z/))
  assert.equal(readProjectConfig(store.layouts[1]).letter, 'Z')
})

test('App: Enter on "+ Add project" opens the add prompt; Esc cancels without registering anything', async (t) => {
  const store = twoProjects(t)
  const b = bench(t, store, { view: 'all' })
  await b.quiet()
  await b.press(';')
  await b.until(has(b, /Projects:/))
  await b.press(KEY.down, KEY.down) // past both project rows, onto "+ Add project"
  await b.until(has(b, /\+ Add project/))
  await b.press('\r')
  await b.until(has(b, /Add a project/))
  const path = '/nonexistent/path/nobody/registers'
  await b.press(...path.split(''), '\x1b')
  await b.until(has(b, /Projects:/))
  assert.ok(!readProjects().some((p) => p.root === path), 'Esc never committed the add')
})

test('App: "+ Add project" registers a real folder (one with decisions/), same as nod projects add', async (t) => {
  const store = twoProjects(t)
  const toAdd = mkdtempSync(join(tmpdir(), 'decs-tui-proj-add-'))
  initLayout(toAdd) // creates decisions/active, the one thing addProject checks for
  t.after(() => rmSync(toAdd, { recursive: true, force: true }))
  const b = bench(t, store, { view: 'all' })
  await b.quiet()
  await b.press(';')
  await b.until(has(b, /Projects:/))
  await b.press(KEY.down, KEY.down)
  await b.until(has(b, /\+ Add project/))
  await b.press('\r')
  await b.until(has(b, /Add a project/))
  await b.press(...toAdd.split(''), '\r')
  await b.until(has(b, new RegExp(`added ${escapeRe(toAdd)}`)))
  assert.ok(readProjects().some((p) => p.root === toAdd))
})

test('App: "+ Add project" refuses a folder with no decisions/, same as nod projects add', async (t) => {
  const store = twoProjects(t)
  const bare = mkdtempSync(join(tmpdir(), 'decs-tui-proj-bare-'))
  t.after(() => rmSync(bare, { recursive: true, force: true }))
  const b = bench(t, store, { view: 'all' })
  await b.quiet()
  await b.press(';')
  await b.until(has(b, /Projects:/))
  await b.press(KEY.down, KEY.down)
  await b.until(has(b, /\+ Add project/))
  await b.press('\r')
  await b.until(has(b, /Add a project/))
  await b.press(...bare.split(''), '\r')
  await b.until(has(b, new RegExp(`${escapeRe(bare)} has no decisions/`)))
  assert.ok(!readProjects().some((p) => p.root === bare))
})

test('App: u on a project row unlinks it from the registry — its decisions/ folder is untouched', async (t) => {
  const toUnlink = mkdtempSync(join(tmpdir(), 'decs-tui-proj-unlink-'))
  const layout = initLayout(toUnlink)
  t.after(() => rmSync(toUnlink, { recursive: true, force: true }))
  addProject(toUnlink)
  assert.ok(readProjects().some((p) => p.root === toUnlink), 'set up registered')

  const store = new Store([layout])
  const b = bench(t, store, { view: 'all' })
  await b.quiet()
  await b.press(';')
  await b.until(has(b, /Projects:/))
  await b.press('u')
  await b.until(has(b, /unlinked/))
  assert.ok(!readProjects().some((p) => p.root === toUnlink), 'dropped from the registry')
  assert.ok(existsSync(layout.activeDir), 'its decisions/ is untouched')
})
