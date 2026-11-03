import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { BIN, decs, killAndWait, scratch } from './helpers.ts'

interface Seg { text: string; color?: string; bold?: boolean; dim?: boolean }
interface JsonRow { key: string; kind: string; depth: number; fold: string | null; node?: string; ref?: string; glyph?: Seg; badge?: Seg[]; collapsed?: boolean; text?: string; count?: number }
interface BenchJson {
  lang: string
  projects: { project: string; letter: string; root: string; stale_count: number }[]
  views: { view: string; count: number | null; rows: JsonRow[] }[]
  nodes: Record<string, { ref: string; options: { key: string; body: string }[]; parent_node: { ref: string }; after_nodes: { ref: string }[]; blocking_nodes: { ref: string }[]; status: string; status_line: Seg[]; meta: Seg[][]; body_rows: { text: string; image?: number; style?: Seg }[]; images: { name: string; path: string }[]; can_default: boolean; backlinks: string[]; checkin: { asked: number; last_asked_at: string; unanswered: boolean } | null; staleness: string }>
}

/** Retries past a lingering lock on Windows — a just-killed child can hold its cwd open
 *  a moment longer than its own 'exit' event. */
const rmScratch = (dir: string) => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })

function project(t: { after: (fn: () => void) => void }): string {
  const root = scratch()
  t.after(() => rmScratch(root))
  decs(root, ['init', '--no-register'])
  return root
}

const benchJson = (root: string): BenchJson => JSON.parse(decs(root, ['bench', '--json', '--dir', root]))
const view = (j: BenchJson, name: string) => j.views.find((v) => v.view === name)!

test('decs bench --json: every view with its rows, glyphs and badges, without a terminal', (t) => {
  const root = project(t)
  decs(root, ['add', 'ship the docs', '--task'])
  decs(root, ['start', '1'])
  decs(root, ['progress', '40', '--node', '1'])
  decs(root, ['add', 'which cdn', '-o', 'default:1=keep the current one', '2=switch', '--parent', '1'], {}, 'Why it matters.\n\n### 1 · keep the current one\nNo work, slower in Asia.\n\n### 2 · switch\nA day of work.\n')
  decs(root, ['add', 'later thing', '--task', '--after', '2'])

  const j = benchJson(root)
  assert.equal(j.lang, 'en')
  assert.equal(j.projects.length, 1)
  assert.deepEqual(j.views.map((v) => v.view), ['available', 'active', 'decide', 'waiting', 'live', 'all'])
  assert.equal(view(j, 'decide').count, 1)

  const rows = view(j, 'available').rows
  const parent = rows.find((r) => r.ref === 'X1')!
  const child = rows.find((r) => r.ref === 'X2')!
  assert.equal(parent.glyph!.text, '◐')
  assert.equal(child.glyph!.text, '◆')
  assert.equal(child.depth, parent.depth + 1)
  assert.ok(parent.badge!.some((s) => s.text.includes('40%')), JSON.stringify(parent.badge))
  assert.ok(child.badge!.some((s) => s.text === 'Decide'), JSON.stringify(child.badge))

  const d = j.nodes[child.node!]
  assert.equal(d.status, 'needs_decision')
  assert.equal(d.can_default, true)
  assert.equal(d.status_line[0].text, '◆')
  assert.deepEqual(d.options.map((o) => o.key), ['1', '2'])
  assert.ok(!d.body_rows.some((r) => r.text === 'Options'), 'the live options come as data, not as body text')
  assert.deepEqual(d.options.map((o) => o.body), ['No work, slower in Asia.', 'A day of work.'], "each option's cost moves onto its card")
  assert.ok(!d.body_rows.some((r) => /slower in Asia/.test(r.text)), 'and out of the body')
  assert.ok(d.body_rows.some((r) => r.text === 'Why it matters.'))
  assert.equal(d.parent_node.ref, 'X1')
  assert.deepEqual(d.blocking_nodes.map((n) => n.ref), ['X3'])
  assert.deepEqual(j.nodes[`${j.projects[0].project}#3`].after_nodes.map((n) => n.ref), ['X2'])
})

test('decs bench --json: stale_count is not_started/not-deferred nodes; a node\'s checkin is null until it has been asked', (t) => {
  const root = project(t)
  decs(root, ['add', 'not started yet', '--task'])
  decs(root, ['add', 'also not started', '--task'])
  decs(root, ['add', 'running', '--task'])
  decs(root, ['start', '3'])
  decs(root, ['defer', '1', '--human'])

  const j = benchJson(root)
  assert.equal(j.projects[0].stale_count, 1, 'node 1 is deferred, so only node 2 counts')
  assert.equal(j.nodes[`${j.projects[0].project}#3`].checkin, null, 'never asked yet')
  assert.equal(j.nodes[`${j.projects[0].project}#3`].staleness, 'fresh')
})

test('decs bench --json: finished children sit under their fold row in All; attachments come with an absolute path', (t) => {
  const root = project(t)
  decs(root, ['add', 'parent', '--task'])
  decs(root, ['add', 'done kid', '--task', '--parent', '1'])
  decs(root, ['add', 'open kid', '--task', '--parent', '1'])
  decs(root, ['start', '2'])
  decs(root, ['done', '2'])
  const png = join(root, 'shot.png')
  writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'))
  decs(root, ['attach', '3', png])
  decs(root, ['add', 'old work', '--task'])
  decs(root, ['start', '4'])
  decs(root, ['done', '4'])

  const j = benchJson(root)
  const all = view(j, 'all').rows
  const fold = all.find((r) => r.kind === 'fold')!
  assert.equal(fold.count, 1)
  assert.doesNotMatch(fold.text!, /expand/i)
  assert.equal(all.find((r) => r.ref === 'X2')!.fold, fold.key)
  assert.equal(all.find((r) => r.ref === 'X3')!.fold, null)

  const kid = j.nodes[all.find((r) => r.ref === 'X3')!.node!]
  assert.equal(kid.images.length, 1)
  assert.ok(isAbsolute(kid.images[0].path), kid.images[0].path)

  assert.ok(all.some((r) => r.ref === 'X4'))
  assert.equal(j.nodes[all.find((r) => r.ref === 'X4')!.node!], undefined, 'archived nodes are listed, not detailed')
  const done = JSON.parse(decs(root, ['bench', '--json', '--node', '4', '--dir', root]))
  assert.equal(done.ref, 'X4')
  assert.equal(done.status, 'completed')
  assert.ok(Array.isArray(done.body_rows))
})

test('decs monitor --with-parent: the monitor goes when the process that started it goes', async (t) => {
  const root = project(t)
  const home = scratch()
  t.after(() => rmScratch(home))
  const parent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'])
  t.after(() => killAndWait(parent))
  const child = spawn(process.execPath, [BIN, 'monitor', '--with-parent', String(parent.pid), '--interval', '200', '--idle-exit', '0'], {
    cwd: root,
    env: { ...process.env, NO_COLOR: '1', DECS_AUTHOR: 'cli-test · lane', CLAUDECODE: '1', DECS_HOME: home },
  })
  t.after(() => killAndWait(child))
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))
  await new Promise((r) => setTimeout(r, 600))
  assert.equal(child.exitCode, null, 'still running while the parent is')
  parent.kill()
  // A dead process can still answer `kill(pid, 0)` for a moment on Windows (a known, narrow
  // libuv race around TerminateProcess) — generous, since the monitor only polls every 200ms.
  const code = await Promise.race([exited, new Promise<string>((r) => setTimeout(() => r('timeout'), 15_000))])
  assert.equal(code, 0)
  // Dead before `project()`'s own cleanup runs — Windows won't remove a directory
  // that's still a live process's cwd.
  await killAndWait(parent)
})

test('decs monitor --updates: an agent writing progress is a line, which plain monitor never reports', async (t) => {
  const root = project(t)
  const home = scratch()
  t.after(() => rmScratch(home))
  decs(root, ['add', 'long job', '--task'])
  decs(root, ['start', '1'])
  const child = spawn(process.execPath, [BIN, 'monitor', '--with-parent', String(process.pid), '--updates', '--json', '--interval', '200', '--idle-exit', '0'], {
    cwd: root,
    env: { ...process.env, NO_COLOR: '1', DECS_AUTHOR: 'cli-test · lane', CLAUDECODE: '1', DECS_HOME: home },
  })
  let out = ''
  let err = ''
  child.stdout.on('data', (b) => (out += b))
  child.stderr.on('data', (b) => (err += b))
  t.after(() => killAndWait(child))
  const until = async (ok: () => boolean, what: string) => {
    for (const end = Date.now() + 10_000; !ok(); await new Promise((r) => setTimeout(r, 50)))
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${out}${err}`)
  }
  await until(() => err.includes('nod monitor: watching'), 'the monitor to start')
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(out, '', 'nothing on start: the first pass only takes stock')
  decs(root, ['progress', '50', '--node', '1'])
  await until(() => out.includes('"updated"'), 'the updated line')
  const line = JSON.parse(out.trim().split('\n')[0])
  assert.deepEqual(line.refs, ['X1'])
  assert.deepEqual(line.gone, [])
  // Dead before `project()`'s own cleanup runs — Windows won't remove a directory
  // that's still a live process's cwd.
  await killAndWait(child)
})
