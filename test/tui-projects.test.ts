import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initLayout } from '../src/core/paths.ts'
import { configPath, readProjectConfig, writeProjectConfig } from '../src/core/project.ts'
import { Store } from '../src/core/store.ts'
import { bench, has, KEY } from './tui-harness.ts'

const A = 'lead · tui projects test'

/*
 * Rename and the letter live in the project's own decisions/decs.json (core/project.ts),
 * so bench() against a temp store exercises the real write, same as every other test here.
 * Add/unlink go through core/config.ts's addProject/removeProject, which write the shared
 * ~/.decs/config.json registry — that path is bound once at import time (not re-read per
 * call), so no in-process test can point it at a temp dir the way bench() redirects fold
 * state; every existing test for them (test/project-name.test.ts) goes through a spawned
 * `nod` subprocess with its own DECS_HOME instead. Calling the real functions here would
 * write into the machine's real registry, so this file only exercises the UI up to the
 * point where it would — the prompts, the mode switch, Esc cancelling — never the commit.
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
  await b.press(...'/nonexistent/path/nobody/registers'.split(''), '\x1b')
  await b.until(has(b, /Projects:/))
})
