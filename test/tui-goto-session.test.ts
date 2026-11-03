import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initLayout } from '../src/core/paths.ts'
import { Store } from '../src/core/store.ts'
import { bench, has } from './tui-harness.ts'

const A = 'lead · goto session test'

/*
 * `l` / `L` wire straight into `gotoSession`/`describeGoto` (src/cli/commands/session.ts),
 * already covered end to end — a real iTerm2/Terminal heartbeat found, the AppleScript built
 * for its id, --dry-run never shelling out — in test/goto-session.test.ts, by spawning a real
 * `nod monitor` against an isolated DECS_HOME (the only way to get a heartbeat a fresh process
 * will see: `core/listeners.ts` binds its sessions directory from `DECS_HOME` at import time,
 * not read per call, so an in-process bench() test can't redirect it the way it redirects
 * NODDIT_HOME for fold state). What's left to prove here is the TUI's own wiring: the key reads
 * the right project (the node under the cursor, or the primary project with none selected) and
 * shows what `describeGoto` says — exercised below on the "nothing to switch to" path, which a
 * fresh temp project hits deterministically without fabricating a session.
 */

function tmpStore(t: { after: (fn: () => void) => void }): Store {
  const root = mkdtempSync(join(tmpdir(), 'decs-goto-session-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return new Store([initLayout(root)])
}

test('App: l/L with a node selected says there is nothing to switch to, for that node\'s own project', async (t) => {
  const store = tmpStore(t)
  store.create({ title: 'write the release notes', author: A, task: true })
  const b = bench(t, store, { view: 'all' })
  await b.until(has(b, /write the release notes/))
  const project = store.projectName(store.layouts[0])
  await b.press('l')
  await b.until(has(b, new RegExp(`no terminal session to switch to for ${project}`)))
})

test('App: l/L with nothing selected falls back to the primary project', async (t) => {
  const store = tmpStore(t)
  const b = bench(t, store, { view: 'all' })
  await b.quiet()
  const project = store.projectName(store.primary)
  await b.press('L')
  await b.until(has(b, new RegExp(`no terminal session to switch to for ${project}`)))
})
