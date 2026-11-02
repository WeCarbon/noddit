import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'

import { initLayout, listEntryFiles } from '../src/core/paths.ts'
import { Store } from '../src/core/store.ts'
import { rollup } from '../src/core/status.ts'
import { stalenessOf } from '../src/core/staleness.ts'
import { decs, decsAsync, decsResult, scratch } from './helpers.ts'

test('children live in the parent folder; get --json shows parent and children', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 'ship v2.4', '--task'])
  decs(root, ['add', 'merge the branch', '--task', '--parent', '1'])
  decs(root, ['add', 'whether to ship', '-o', '1=ship', '2=hold off', '--parent', 'X1'])
  decs(root, ['add', 'run the gate', '--task', '--parent', '2'])

  const l = initLayout(root)
  // `relative()` uses the host separator; the expectations below are written with `/`.
  const rel = (p: string) => relative(l.activeDir, p).split(sep).join('/')
  const files = listEntryFiles(l).map((f) => [f.id, rel(f.path), f.parent ?? null])
  assert.deepEqual(files, [
    [1, '1-ship-v2-4.md', null],
    [2, '1-ship-v2-4/2-merge-the-branch.md', 1],
    [3, '1-ship-v2-4/3-whether-to-ship.md', 1],
    [4, '1-ship-v2-4/2-merge-the-branch/4-run-the-gate.md', 2],
  ])

  const one = JSON.parse(decs(root, ['get', '1', '--json']))
  assert.deepEqual(one.children, [2, 3])
  assert.equal(one.parent, null)
  const four = JSON.parse(decs(root, ['get', '4', '--json']))
  assert.equal(four.parent, 2)
  assert.equal(four.parent_ref, 'X2')

  const store = new Store([l])
  const r = rollup(store.get(1)!, store.all())
  assert.equal(r.descendants, 3)
  assert.equal(r.needsOwner, true, 'a child that needs a decision surfaces on the root')
  assert.deepEqual(r.counts, { not_started: 2, needs_decision: 1 })

  const tree = decs(root, ['tree'])
  assert.match(tree, /^X1 · To do ◆ · ship v2\.4/m)
  assert.match(tree, /├─ X2 · To do · merge the branch/)
  assert.match(tree, /│  └─ X4 · To do · run the gate/)
  assert.match(tree, /└─ X3 · Needs decision · whether to ship/)
  const json = JSON.parse(decs(root, ['tree', '--json']))
  assert.equal(json[0].children[0].children[0].ref, 'X4')
  assert.match(decs(root, ['show']), /whether to ship/, 'a child that needs a decision is in the owner list like any other')
})

test('nod tree never shows "waiting on deps" for a completed/closed node, whatever its own after deps are doing (N47)', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 'still not started', '--task'])
  decs(root, ['add', 'done anyway', '--task', '--after', '1'])
  decs(root, ['start', '2', '--force'])
  decs(root, ['done', '2'])

  // X2's own dependency (X1) is still not_started — before the fix this alone made a
  // finished node read "waiting on deps", which makes no sense once it's done.
  assert.equal(JSON.parse(decs(root, ['get', '1', '--json'])).status, 'not_started')
  const tree = decs(root, ['tree', '--all'])
  const line2 = tree.split('\n').find((l) => l.includes('X2'))
  assert.ok(line2 && !line2.includes('waiting on deps'), tree)

  // Closed nodes too.
  decs(root, ['add', 'closed anyway', '--task', '--after', '1'])
  decs(root, ['close', '3', '--reason', 'obsolete'])
  const tree2 = decs(root, ['tree', '--all'])
  const line3 = tree2.split('\n').find((l) => l.includes('X3'))
  assert.ok(line3 && !line3.includes('waiting on deps'), tree2)
})

test('a child completing stays put; the root completing archives the whole tree; a reply on a child brings it back', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const l = initLayout(root)
  const store = new Store([l])
  const r = store.create({ title: 'root', author: 'lead', task: true })
  const c = store.create({ title: 'child', author: 'lane', task: true, parent: String(r.id) })

  const cDone = store.complete(c)
  assert.equal(cDone.state, 'completed')
  assert.ok(!cDone.archived && cDone.file.startsWith(l.activeDir), 'a finished child stays inside its open parent')

  const rDone = store.complete(store.get(r.id)!)
  assert.ok(rDone.archived)
  assert.ok(existsSync(join(l.archivedDir, '1-root', '2-child.md')), 'the subtree moved as one unit')
  assert.ok(!existsSync(join(l.activeDir, '1-root')))

  const back = store.note(store.get(c.id)!, { text: 'the child still needs one more step', role: 'human', author: 'owner' })
  assert.equal(back.state, 'decided')
  assert.ok(!back.archived)
  assert.ok(existsSync(join(l.activeDir, '1-root.md')) && existsSync(join(l.activeDir, '1-root', '2-child.md')), 'the whole tree is back in active/')
})

test('decs move re-parents a subtree, keeps ids, and fixes relative links', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const l = initLayout(root)
  const store = new Store([l])
  store.create({ title: 'A', author: 'x', task: true })
  store.create({ title: 'B', author: 'x', task: true })
  const c = store.create({ title: 'C', author: 'x', task: true, parent: '2' })
  store.create({ title: 'D', author: 'x', task: true, parent: '3' })

  // An attachment link written from where C sits now.
  mkdirSync(join(l.root, 'attachments', '3'), { recursive: true })
  writeFileSync(join(l.root, 'attachments', '3', 'a.png'), 'x')
  store.attach(store.get(c.id)!, [join(l.root, 'attachments', '3', 'a.png')], { link: false })
  const before = store.get(3)!.attachments[0].target
  assert.ok(!before.startsWith('/'))

  decs(root, ['move', '3', '--parent', '1'])
  const moved = store.get(3)!
  assert.equal(moved.parent, 1)
  assert.ok(moved.file.endsWith(join('1-a', '3-c.md')))
  assert.equal(store.get(4)!.parent, 3, 'the subtree came along')
  const target = moved.attachments[0].target
  assert.ok(existsSync(join(moved.file, '..', target)), `link still resolves: ${target}`)

  assert.equal(decsResult(root, ['move', '3', '--parent', '4']).code, 1, 'cannot hang a node under its own descendant')
  decs(root, ['move', '3', '--root'])
  assert.equal(store.get(3)!.parent, undefined)
  assert.ok(existsSync(join(l.activeDir, '3-c', '4-d.md')))
})

test('two lanes adding children under one parent at once both land', async (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 'parent', '--task'])
  await Promise.all(Array.from({ length: 10 }, (_, i) => decsAsync(root, ['add', `child ${i}`, '--task', '--parent', '1', '--author', 'race · lane'])))
  const kids = JSON.parse(decs(root, ['get', '1', '--json'])).children
  assert.equal(kids.length, 10)
  assert.equal(new Set(kids).size, 10)
})

test('an archived tree refuses new children until reopened', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  store.complete(store.create({ title: 'root', author: 'x', task: true }))
  assert.throws(() => store.create({ title: 'child', author: 'x', task: true, parent: '1' }), /already archived/)
  assert.ok(readFileSync(store.get(1)!.file, 'utf8').includes('status: completed'))
})

test('a parent whose child just moved is not stale, however old its own file is', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'decs-active-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  const parent = store.start(store.create({ title: 'p', author: 'lane · x', task: true }))
  const child = store.start(store.create({ title: 'c', author: 'lane · x', task: true, parent: String(parent.id) }))
  // The parent's own file is two hours old; the child was written just now.
  const f = store.get(parent.id)!.file
  writeFileSync(f, readFileSync(f, 'utf8').replace(/^updated_at: .*$/m, 'updated_at: 2000-01-01T00:00:00+08:00'))
  const p = store.all().find((d) => d.id === parent.id)!
  assert.equal(p.activeAt, store.all().find((d) => d.id === child.id)!.updatedAt)
  assert.equal(stalenessOf(p, Date.now()), 'fresh')
})
