import { test } from 'node:test'
import assert from 'node:assert/strict'

import { NONE, batchActions, between, boxHits, boxed, extend, listed, range, toggle, type Actionable } from '../app/src/selection.ts'

const order = ['a', 'b', 'c', 'd', 'e']

test('between: inclusive, in list order whichever end comes first; nothing for an unlisted end', () => {
  assert.deepEqual(between(order, 'b', 'd'), ['b', 'c', 'd'])
  assert.deepEqual(between(order, 'd', 'b'), ['b', 'c', 'd'])
  assert.deepEqual(between(order, 'c', 'c'), ['c'])
  assert.deepEqual(between(order, 'c', 'zz'), [])
})

test('toggle: the first ⌘-click keeps the cursor row too; later ones add and remove, kept in list order', () => {
  const one = toggle(NONE, order, 'd', 'b')
  assert.deepEqual(one, { keys: ['b', 'd'], anchor: 'd' })
  const two = toggle(one, order, 'a', 'b')
  assert.deepEqual(two.keys, ['a', 'b', 'd'])
  const three = toggle(two, order, 'b', 'b')
  assert.deepEqual(three.keys, ['a', 'd'])
  assert.deepEqual(toggle(NONE, order, 'c', 'c').keys, ['c'], '⌘-click on the cursor row itself selects just it')
  assert.deepEqual(toggle(NONE, order, 'c', null).keys, ['c'])
})

test('range: ⇧-click runs from the anchor, or the cursor when there is none, and keeps the anchor', () => {
  const first = range(NONE, order, 'd', 'b')
  assert.deepEqual(first, { keys: ['b', 'c', 'd'], anchor: 'b' })
  const back = range(first, order, 'a', 'e')
  assert.deepEqual(back, { keys: ['a', 'b'], anchor: 'b' }, 'a second ⇧-click re-draws from the same anchor')
  const afterToggle = range(toggle(NONE, order, 'e', 'a'), order, 'c', 'a')
  assert.deepEqual(afterToggle.keys, ['c', 'd', 'e'], 'the last ⌘-clicked row is the anchor')
})

test('extend: ⇧↓ / ⇧↑ move the cursor and select from the anchor to it, shrinking back past it', () => {
  let s = extend(NONE, order, 'b', 1)
  assert.deepEqual(s, { sel: { keys: ['b', 'c'], anchor: 'b' }, cursor: 'c' })
  s = extend(s.sel, order, s.cursor, 1)
  assert.deepEqual(s.sel.keys, ['b', 'c', 'd'])
  s = extend(s.sel, order, s.cursor, -1)
  s = extend(s.sel, order, s.cursor, -1)
  s = extend(s.sel, order, s.cursor, -1)
  assert.deepEqual(s, { sel: { keys: ['a', 'b'], anchor: 'b' }, cursor: 'a' })
  s = extend(s.sel, order, s.cursor, -1)
  assert.equal(s.cursor, 'a', 'stops at the top')
  assert.deepEqual(extend(NONE, order, null, 1).cursor, 'a', 'with no cursor ⇧↓ starts at the first row')
})

test('boxHits: the rows a box overlaps, whichever way it was dragged; touching an edge is not overlapping', () => {
  const bands = order.map((key, i) => ({ key, top: i * 32, bottom: (i + 1) * 32 }))
  assert.deepEqual(boxHits(bands, 40, 100), ['b', 'c', 'd'])
  assert.deepEqual(boxHits(bands, 100, 40), ['b', 'c', 'd'])
  assert.deepEqual(boxHits(bands, 64, 64), [])
  assert.deepEqual(boxHits(bands, 200, 400), [])
})

test('boxed: a box replaces the selection, or adds to it with ⌘', () => {
  const base = { keys: ['a'], anchor: 'a' }
  assert.deepEqual(boxed(base, order, ['d', 'c'], false).keys, ['c', 'd'])
  assert.deepEqual(boxed(base, order, ['d', 'c'], true).keys, ['a', 'c', 'd'])
})

test('listed: rows that left the list drop out of the selection', () => {
  assert.deepEqual(listed({ keys: ['a', 'x', 'c'], anchor: 'a' }, order), ['a', 'c'])
})

const node = (over: Partial<Actionable> = {}): Actionable => ({ terminal: false, status: 'not_started', urgency: 'normal', every: null, assignee: 'ai', project: 'web', ...over })

test('batchActions: only what fits every selected node', () => {
  const two = batchActions([node(), node({ status: 'in_progress', urgency: 'high' })])
  assert.equal(two.important, true, 'not all important yet: 重要')
  assert.equal(batchActions([node({ urgency: 'high' }), node({ urgency: 'high' })]).important, false, 'all important: 取消重要')
  assert.equal(two.start, false, 'one is already running')
  assert.equal(batchActions([node(), node()]).start, true)
  assert.equal(two.delay && two.archive, true)
  assert.equal(two.every, null, 'no R on either')
  assert.deepEqual(batchActions([node({ every: '3d' }), node({ every: '3d' })]).every, { same: '3d' })
  assert.deepEqual(batchActions([node({ every: '3d' }), node({ every: '1w' })]).every, { same: null })
  assert.equal(batchActions([node({ every: '3d' }), node()]).every, null, 'one has no R')
  assert.deepEqual(two.assign, ['me'])
  assert.deepEqual(batchActions([node({ assignee: 'human' }), node()]).assign, ['ai', 'me'])
  assert.equal(two.move, true)
  assert.equal(batchActions([node(), node({ project: 'api' })]).move, false, 'two projects: no one parent fits')

  const withDone = batchActions([node(), node({ terminal: true, status: 'completed' })])
  assert.deepEqual(
    [withDone.important, withDone.every, withDone.delay, withDone.assign, withDone.start, withDone.archive, withDone.move],
    [null, null, false, [], false, false, true],
    'a finished node in the selection leaves only moving (and copying)',
  )
})
