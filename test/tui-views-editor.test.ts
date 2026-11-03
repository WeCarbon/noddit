import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initLayout } from '../src/core/paths.ts'
import { Store } from '../src/core/store.ts'
import { loadViews } from '../src/core/view-defs.ts'
import { bench, has, KEY } from './tui-harness.ts'

function tmpStore(t: { after: (fn: () => void) => void }): Store {
  const root = mkdtempSync(join(tmpdir(), 'decs-tui-views-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return new Store([initLayout(root)])
}

/**
 * test/setup.ts pins NODDIT_VIEWS to one shared, nonexistent path for the whole suite (never the
 * owner's own views.json) — every test here edits that same file unless it points its own test
 * at a views.json of its own, the same way test/views.test.ts and the CLI's own view tests do.
 * Also hands `bench()` the matching `home` so `$DECS_HOME` and `$NODDIT_VIEWS` agree on where
 * this one test's state lives.
 */
function viewsTestHome(t: { after: (fn: () => void) => void }): string {
  const home = mkdtempSync(join(tmpdir(), 'decs-tui-views-home-'))
  const prev = process.env.NODDIT_VIEWS
  process.env.NODDIT_VIEWS = join(home, 'views.json')
  t.after(() => {
    process.env.NODDIT_VIEWS = prev
    if (prev === undefined) delete process.env.NODDIT_VIEWS
    rmSync(home, { recursive: true, force: true })
  })
  return home
}

test('App: v opens the views editor on the built-in list; Esc closes it without writing anything', async (t) => {
  const store = tmpStore(t)
  const home = viewsTestHome(t)
  const b = bench(t, store, { view: 'available', home })
  await b.quiet()
  await b.press('v')
  await b.until(has(b, /Views/))
  await b.until(has(b, /Available · tree/))
  await b.until(has(b, /All · tree/))
  await b.press('\x1b')
  await b.until(() => !has(b, /Available · tree/)())
  assert.equal(loadViews().length, 6, 'nothing was written just from opening and closing')
})

test('App: a adds a new view by id, straight into its own field editor; the id is saved in list order', async (t) => {
  const store = tmpStore(t)
  const home = viewsTestHome(t)
  const b = bench(t, store, { view: 'available', home })
  await b.quiet()
  await b.press('v')
  await b.until(has(b, /Views/))
  await b.press('a')
  await b.until(has(b, /New view/))
  await b.press(...'mine'.split(''), '\r')
  await b.until(has(b, /Added the view mine/))
  await b.until(has(b, /Name/))
  const views = loadViews()
  assert.equal(views.length, 7)
  assert.deepEqual(views.at(-1), { id: 'mine', layout: 'list', sort: ['bench'] })
})

test('App: a with an id that already exists (a built-in included) is refused, no duplicate written', async (t) => {
  const store = tmpStore(t)
  const home = viewsTestHome(t)
  const b = bench(t, store, { view: 'available', home })
  await b.quiet()
  await b.press('v')
  await b.until(has(b, /Views/))
  await b.press('a')
  await b.until(has(b, /New view/))
  await b.press(...'available'.split(''), '\r')
  await b.until(has(b, /already a view available/))
  await b.until(has(b, /Available · tree/)) // back on the list, not the field editor
  assert.equal(loadViews().length, 6, 'the clash never wrote a file')
})

test('App: x deletes the selected view; the last one left is refused, same as nod view rm', async (t) => {
  const store = tmpStore(t)
  const home = viewsTestHome(t)
  const b = bench(t, store, { view: 'available', home })
  await b.quiet()
  await b.press('v')
  await b.until(has(b, /Views/))
  // Delete row 0 five times: available, active, decide, waiting, live — one view (all) is left.
  for (let i = 0; i < 5; i++) {
    await b.press('x')
    await b.until(has(b, /Removed/))
  }
  assert.deepEqual(loadViews().map((v) => v.id), ['all'])
  await b.press('x')
  await b.until(has(b, /needs at least one view/))
  assert.deepEqual(loadViews().map((v) => v.id), ['all'], 'the last view was never removed')
})

test('App: in the field editor, ←/→ cycles an enum field and writes it to disk right away', async (t) => {
  const store = tmpStore(t)
  const home = viewsTestHome(t)
  const b = bench(t, store, { view: 'available', home })
  await b.quiet()
  await b.press('v')
  await b.until(has(b, /Views/))
  await b.press('\r') // row 0: available (tree) -> its own field editor
  await b.until(has(b, /Name/))
  await b.press(KEY.down, KEY.down) // name -> filter -> layout
  await b.until(has(b, /Layout/))
  await b.press(KEY.right) // tree -> list
  assert.equal(loadViews().find((v) => v.id === 'available')?.layout, 'list')
  await b.until(has(b, /‹ list ›/))
})

test('App: ⏎ on a text field opens the shared text prompt; typing a value and ⏎ saves it, back to the field list', async (t) => {
  const store = tmpStore(t)
  const home = viewsTestHome(t)
  const b = bench(t, store, { view: 'available', home })
  await b.quiet()
  await b.press('v')
  await b.until(has(b, /Views/))
  await b.press('\r') // row 0: available -> field editor, starts on name
  await b.until(has(b, /Name/))
  await b.press('\r') // open the name field's own text prompt
  await b.until(has(b, /available/))
  await b.press(...'My Available'.split(''), '\r')
  await b.until(has(b, /My Available/))
  assert.equal(loadViews().find((v) => v.id === 'available')?.name, 'My Available')
})

test('App: m enters move mode; ↑/↓ reorders the list, m again stops it and reports the new position', async (t) => {
  const store = tmpStore(t)
  const home = viewsTestHome(t)
  const b = bench(t, store, { view: 'available', home })
  await b.quiet()
  await b.press('v')
  await b.until(has(b, /Views/))
  await b.press('m')
  await b.until(has(b, /Moving available/))
  await b.press(KEY.down)
  await b.press('m')
  await b.until(has(b, /available is tab 2 now/))
  const ids = loadViews().map((v) => v.id)
  assert.equal(ids[0], 'active')
  assert.equal(ids[1], 'available')
})

test('App: a bad filter typed into the filter field is rejected, reporting why, without touching the saved view', async (t) => {
  const store = tmpStore(t)
  const home = viewsTestHome(t)
  const b = bench(t, store, { view: 'available', home })
  await b.quiet()
  await b.press('v')
  await b.until(has(b, /Views/))
  await b.press('\r') // row 0: available -> field editor, starts on name
  await b.until(has(b, /Name/))
  await b.press(KEY.down) // name -> filter
  await b.until(has(b, /Filter/))
  await b.press('\r') // open the filter field's own text prompt (pre-filled with the current filter)
  await b.until(has(b, /available/))
  const before = loadViews()
  // A leading space keeps this a separate term from whatever the field already holds.
  await b.press(...' bogus:nonsense'.split(''), '\r')
  await b.until(has(b, /not a filter field/))
  assert.deepEqual(loadViews(), before, 'the bad filter never got written')
})
