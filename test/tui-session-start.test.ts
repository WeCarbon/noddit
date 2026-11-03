import { test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { addProject, DECS_HOME, removeProject } from '../src/core/config.ts'
import { initLayout } from '../src/core/paths.ts'
import { Store } from '../src/core/store.ts'
import { bench, has } from './tui-harness.ts'

const A = 'lead · session start test'
const SESSIONS_DIR = join(DECS_HOME, 'sessions')
const CTRL_L = '\x0c'

function tmpStore(t: { after: (fn: () => void) => void }): Store {
  const root = mkdtempSync(join(tmpdir(), 'decs-session-start-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return new Store([initLayout(root)])
}

/**
 * A heartbeat this test's own pid stands behind, so `leadFor`/`mainListener` see it as live.
 * core/listeners.ts binds its sessions directory to $DECS_HOME once at import time — test/setup.ts's
 * throwaway, shared with every bench() in this file (and, in principle, any other file sharing
 * this process) — so each one is named for the test that wrote it and removed in `t.after()`,
 * the same discipline test/tui-projects.test.ts uses for the shared project registry.
 */
function fakeHeartbeat(t: { after: (fn: () => void) => void }, name: string, roots: string[], role: 'lead' | 'main') {
  mkdirSync(SESSIONS_DIR, { recursive: true })
  const file = join(SESSIONS_DIR, `${name}.json`)
  const now = new Date().toISOString()
  writeFileSync(file, JSON.stringify({ pid: process.pid, roots, author: `${name} · x`, harness: 'claude-code', role, started_at: now, last_seen: now }))
  t.after(() => rmSync(file, { force: true }))
}

/*
 * t and Ctrl-L wire straight into startSession/startMainSession/describeStart/describeGoto
 * (src/cli/commands/session.ts) — the same functions `nod session start [--main]` and
 * `nod session goto --main` run, already covered end to end (dry-run, a real plan handed to
 * the launcher, the already_listening refusal) in test/intake.test.ts and
 * test/main-session.test.ts. What's left to prove here is the TUI's own wiring: t reads the
 * cursor node's own project (or the primary project with nothing selected) and refuses the
 * same way the CLI does when a lead already listens there, saying who; Ctrl-L does the same for
 * the cross-project main session, and the header's own dot reflects whether it's live. Plain
 * m and M are already taken (toggle milestone, move mode), so the main agent gets a Ctrl
 * combination instead, next to the plain l/L it parallels.
 * test/setup.ts's NODDIT_LAUNCH_RECORD means a "started" outcome records its plan instead of
 * opening a real window.
 */

test('App: t refuses when the cursor node\'s own project already has a lead listening, saying who', async (t) => {
  const store = tmpStore(t)
  const d = store.create({ title: 'write the release notes', author: A, task: true })
  const root = store.layoutOf(d).projectRoot
  fakeHeartbeat(t, 'tui-session-start-lead', [root], 'lead')
  const b = bench(t, store, { view: 'all' })
  await b.until(has(b, /write the release notes/))
  await b.press('t')
  await b.until(has(b, /already has a session listening: tui-session-start-lead · x/))
})

test('App: t with nothing selected opens a session in the primary project (or says there is no terminal to open here)', async (t) => {
  const store = tmpStore(t)
  const b = bench(t, store, { view: 'all' })
  await b.quiet()
  await b.press('t')
  await b.until(has(b, /running claude|no terminal to open here/))
})

test('App: Ctrl-L refuses to start a second main agent, saying who', async (t) => {
  const store = tmpStore(t)
  fakeHeartbeat(t, 'tui-session-start-main', [], 'main')
  const b = bench(t, store, { view: 'all' })
  await b.quiet()
  await b.press(CTRL_L)
  await b.until(has(b, /already has a session listening: tui-session-start-main · x/))
})

test('App: Ctrl-L starts the main agent when it is not live yet (or says there is no terminal to open here)', async (t) => {
  const store = tmpStore(t)
  // `nod session start --main` with no --dir falls back to the registered projects' common
  // parent (core/main-session.ts); register this test's own root so that resolves, the way
  // `nod init` would for a real project rather than this test's bare tmpStore().
  const root = store.layouts[0].projectRoot
  addProject(root)
  t.after(() => removeProject(root))
  const b = bench(t, store, { view: 'all' })
  await b.quiet()
  await b.press(CTRL_L)
  await b.until(has(b, /as the main agent|no terminal to open here/))
})

test('App: the header\'s main agent dot is ○ offline, then ● once a main session is live (r re-reads)', async (t) => {
  const store = tmpStore(t)
  const b = bench(t, store, { view: 'all' })
  await b.until(has(b, /○ Main agent/))
  fakeHeartbeat(t, 'tui-session-start-dot', [], 'main')
  await b.press('r')
  await b.until(has(b, /● Main agent/))
})
