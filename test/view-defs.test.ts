import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initLayout } from '../src/core/paths.ts'
import { Store } from '../src/core/store.ts'
import { BUILTIN_VIEWS, filterText, loadViews, parseFilter, resetViews, saveViews, validateView, type ViewDef } from '../src/core/view-defs.ts'
import { benchJson } from '../src/tui/json.ts'
import { inView, ownerRows, recentRows, rowsFor, viewCount, viewFromArg, viewIds, viewLabel, waitingRows } from '../src/tui/views.ts'
import { bench, has } from './tui-harness.ts'
import { decs, decsResult, scratch } from './helpers.ts'

const A = 'lead · views test'
const owner = { CLAUDECODE: undefined, DECS_ROLE: 'human' }

/** Points this test's views at a file of its own, gone afterwards. */
function viewsFile(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'nod-views-'))
  const prev = process.env.NODDIT_VIEWS
  const file = join(dir, 'views.json')
  process.env.NODDIT_VIEWS = file
  t.after(() => {
    process.env.NODDIT_VIEWS = prev
    rmSync(dir, { recursive: true, force: true })
  })
  return file
}

function tmpStore(t: { after: (fn: () => void) => void }): Store {
  const root = mkdtempSync(join(tmpdir(), 'decs-views-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return new Store([initLayout(root)])
}

/** A small mixed project: AI work, the owner's to-dos, a decision, something waiting, something finished. */
function seed(store: Store) {
  const root = store.create({ title: 'Launch', author: A, task: true })
  const todo = store.create({ title: 'Call the vendor', author: 'owner', task: true, assignee: 'human', parent: String(root.id) })
  const ask = store.create({ title: 'Pick a CDN', author: A, options: [{ key: '1', label: 'keep' }, { key: '2', label: 'switch' }], parent: String(root.id) })
  const run = store.start(store.create({ title: 'Write release notes', author: A, task: true, parent: String(root.id) }))
  const held = store.hold(store.create({ title: 'Wait for legal', author: A, task: true }), 'legal', A, { until: '2099-01-01T00:00:00+00:00' })
  const done = store.complete(store.create({ title: 'Old chore', author: A, task: true, parent: String(root.id) }))
  store.flag(todo, { important: true })
  return { root, todo, ask, run, held, done }
}

test('the filter text form reads and writes back the same', () => {
  for (const text of [
    'state:waiting',
    'state:in_progress,waiting,needs_decision,decided or state:not_started is:startable',
    'assignee:human -is:finished',
    'flag:flagged or due:2d',
    'title:"release notes" project:web',
  ]) assert.equal(filterText(parseFilter(text)), text)
  assert.equal(parseFilter('  '), undefined)
  assert.throws(() => parseFilter('colour:blue'), /not a filter field/)
  assert.throws(() => parseFilter('is:sleepy'), /not something a node can be/)
  assert.throws(() => parseFilter('or state:waiting'), /filter term/)
  assert.throws(() => parseFilter('waiting'), /filter term/)
})

test('a definition is checked: id, layout, group, sort, finished/deferred values', () => {
  assert.deepEqual(validateView({ id: 'mine', filter: 'assignee:human', sort: 'flag,-due' }), {
    id: 'mine', layout: 'list', filter: { field: 'assignee', value: ['human'] }, sort: ['flag', '-due'],
  })
  assert.throws(() => validateView({ id: 'Bad Id' }), /view id/)
  assert.throws(() => validateView({ id: 'x', layout: 'grid' }), /layout/)
  assert.throws(() => validateView({ id: 'x', group: 'colour' }), /group/)
  assert.throws(() => validateView({ id: 'x', sort: ['height'] }), /sort/)
  assert.throws(() => validateView({ id: 'x', finished: 'maybe' }), /finished/)
  for (const v of BUILTIN_VIEWS) assert.deepEqual(validateView(JSON.parse(JSON.stringify(v))), v, `${v.id} survives a round trip through views.json`)
})

test('the built-in views, run from their definitions, list exactly what the hand-written ones did', (t) => {
  viewsFile(t)
  const store = tmpStore(t)
  seed(store)
  store.note(store.all()[0], { text: 'looks good', role: 'human', author: 'owner', kind: '回复' })
  const items = store.all()
  const open = { openGroups: new Set(['fold:deferred', 'fold:recent-older']) }
  // `scope` (what a row can be moved among by hand) came after the hand-written lists.
  const unscoped = rowsFor('decide', items).map(({ scope: _, ...r }) => r)
  assert.deepEqual(unscoped, ownerRows(items))
  assert.deepEqual(rowsFor('waiting', items, open), waitingRows(items, open))
  assert.deepEqual(rowsFor('recent', items, open), recentRows(items, open))
  assert.deepEqual(viewIds(), ['available', 'active', 'decide', 'all', 'waiting', 'recent'])
})

test('a list view groups by state or assignee, sorts by its keys, and leaves finished nodes out unless asked', (t) => {
  viewsFile(t)
  const store = tmpStore(t)
  const s = seed(store)
  const items = store.all()
  const byWho: ViewDef = validateView({ id: 'who', group: 'assignee', sort: ['flag', 'id'] })
  const rows = rowsFor(byWho, items)
  assert.deepEqual(rows.filter((r) => r.kind === 'header').map((r) => r.text), ['For you 1', 'AI 4'])
  assert.equal(rows[1].node?.id, s.todo.id)
  assert.ok(!rows.some((r) => r.node?.id === s.done.id), 'finished left out by default')
  const withDone = rowsFor(validateView({ id: 'x', finished: 'show', sort: ['-id'] }), items)
  assert.equal(withDone[0].node?.id, s.done.id, '-id: newest first')
  const byState = rowsFor(validateView({ id: 's', group: 'state', filter: '-assignee:human' }), items)
  assert.deepEqual(byState.filter((r) => r.kind === 'header').map((r) => r.text), ['To do 1', 'In progress 1', 'Waiting 1', 'Needs decision 1'])
  const titled = validateView({ id: 't', filter: 'title:"release"' })
  assert.deepEqual(items.filter((d) => inView(titled, d, items)).map((d) => d.id), [s.run.id])
  assert.equal(viewCount(validateView({ id: 'n', count: false }), items), undefined)
})

test('a tree view with a filter keeps the matches and their ancestors; finished folded when asked', (t) => {
  viewsFile(t)
  const store = tmpStore(t)
  const s = seed(store)
  const items = store.all()
  const mine = rowsFor(validateView({ id: 'm', layout: 'tree', filter: 'assignee:human' }), items)
  assert.deepEqual(mine.map((r) => [r.node?.id, Boolean(r.context)]), [[s.root.id, true], [s.todo.id, false]])
  const folded = rowsFor(validateView({ id: 'f', layout: 'tree', finished: 'fold', filter: '-state:waiting' }), items)
  assert.ok(folded.some((r) => r.kind === 'fold' && /Completed 1/.test(r.text ?? '')))
  assert.ok(!folded.some((r) => r.node?.id === s.held.id))
})

test('views.json: saved in order, read back, a broken file means the built-ins, reset brings them back', (t) => {
  const file = viewsFile(t)
  assert.deepEqual(loadViews(), [...BUILTIN_VIEWS])
  const mine = validateView({ id: 'mine', name: { en: 'Mine', 'zh-Hans': '我的' }, filter: 'assignee:human' })
  saveViews([mine, ...BUILTIN_VIEWS.filter((v) => v.id !== 'recent')])
  assert.deepEqual(viewIds(), ['mine', 'available', 'active', 'decide', 'all', 'waiting'])
  assert.equal(viewLabel('mine'), 'Mine')
  assert.equal(viewFromArg('mine'), 'mine')
  resetViews('recent')
  assert.deepEqual(viewIds(), ['mine', 'available', 'active', 'decide', 'all', 'waiting', 'recent'], 'a restored built-in goes back after the one before it')
  assert.throws(() => resetViews('mine'), /not a built-in/)
  writeFileSync(file, '{ not json')
  assert.deepEqual(loadViews(), [...BUILTIN_VIEWS])
  resetViews()
  assert.equal(existsSync(file), false)
  assert.throws(() => saveViews([]), /at least one view/)
})

test('nod view add / edit / move / rm / reset, and nod views --json for a window', (t) => {
  const file = viewsFile(t)
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  const env = { NODDIT_VIEWS: file, ...owner }
  const added = JSON.parse(decs(root, ['view', 'add', 'mine', '--name', 'Mine', '--filter', 'assignee:human', '--sort', 'flag,due', '--icon', 'user', '--json'], env))
  assert.equal(added.id, 'mine')
  assert.equal(added.label, 'Mine')
  assert.equal(added.filter_text, 'assignee:human')
  assert.equal(added.builtin, false)
  assert.notEqual(decsResult(root, ['view', 'add', 'mine'], env).code, 0, 'ids are unique')
  assert.notEqual(decsResult(root, ['view', 'add', 'bad', '--filter', 'colour:red'], env).code, 0)
  decs(root, ['view', 'edit', 'mine', '--group', 'project', '--layout', 'list'], env)
  decs(root, ['view', 'edit', 'decide', '--name', 'Inbox'], env)
  decs(root, ['view', 'move', 'mine', '1'], env)
  const listed = JSON.parse(decs(root, ['views', '--json'], env))
  assert.equal(listed.file, file)
  assert.deepEqual(listed.views.map((v: { id: string }) => v.id), ['mine', 'available', 'active', 'decide', 'all', 'waiting', 'recent'])
  assert.equal(listed.views.find((v: { id: string }) => v.id === 'decide').label, 'Inbox')
  assert.equal(listed.views.find((v: { id: string }) => v.id === 'decide').pristine, false)
  assert.ok(listed.schema.sort.includes('waiting_since'))
  assert.ok(listed.schema.filter_fields.includes('assignee'))
  decs(root, ['view', 'rm', 'mine', 'recent'], env)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).views.map((v: { id: string }) => v.id), ['available', 'active', 'decide', 'all', 'waiting'])
  decs(root, ['view', 'reset', 'decide'], env)
  assert.equal(JSON.parse(decs(root, ['view', 'show', 'decide', '--json'], env)).pristine, true)
  decs(root, ['view', 'reset'], env)
  assert.equal(existsSync(file), false)
})

test('nod bench --json renders the user\'s views, each with its definition', (t) => {
  viewsFile(t)
  const store = tmpStore(t)
  seed(store)
  saveViews([validateView({ id: 'mine', name: 'Mine', filter: 'assignee:human', icon: 'user' }), ...BUILTIN_VIEWS])
  const out = benchJson(store) as { views: { view: string; label: string; icon: string; def: ViewDef; filter_text: string; count: number; rows: { title?: string }[] }[] }
  const mine = out.views[0]
  assert.equal(mine.view, 'mine')
  assert.equal(mine.label, 'Mine')
  assert.equal(mine.icon, 'user')
  assert.equal(mine.filter_text, 'assignee:human')
  assert.equal(mine.count, 1)
  assert.deepEqual(mine.rows.map((r) => r.title), ['Call the vendor'])
  assert.equal(out.views.length, 7)
  const preview = benchJson(store, { views: [validateView({ id: 'draft', filter: 'state:waiting' })] }) as typeof out
  assert.deepEqual(preview.views.map((v) => [v.view, v.rows.map((r) => r.title)]), [['draft', ['Wait for legal']]], 'an unsaved definition renders on its own')
})

test('bench: the tabs are the user\'s views, and Tab walks them', async (t) => {
  viewsFile(t)
  const store = tmpStore(t)
  seed(store)
  saveViews([validateView({ id: 'mine', name: 'Mine', filter: 'assignee:human' }), ...BUILTIN_VIEWS.filter((v) => v.id !== 'recent' && v.id !== 'all')])
  const b = bench(t, store, { view: 'available' })
  await b.until(has(b, /Write release notes/))
  assert.match(b.frame()[0], /^decs +Mine 1 +Available \d+ +Active \d+ +Needs you \d+ +Waiting 1 *$/)
  await b.press('\t', '\t', '\t', '\t')
  await b.until(() => /Call the vendor/.test(b.frame().join('\n')) && !/Write release notes/.test(b.frame().slice(2).map((l) => l.split('│')[0]).join('\n')))
})
