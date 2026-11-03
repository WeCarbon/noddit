import { test } from 'node:test'
import assert from 'node:assert/strict'
import { snapshotWriter } from '../app/src/snapshot.ts'

test('the bench snapshot is written at most once per interval, only when it changed, and flushed on demand', () => {
  let t = 0
  const writes: string[] = []
  const w = snapshotWriter((j) => writes.push(j), 1000, () => t)
  w.offer('a')
  assert.deepEqual(writes, ['a'], 'the first one goes straight to disk')
  for (let i = 0; i < 100; i++) (t += 5, w.offer(`b${i}`))
  assert.deepEqual(writes, ['a'], 'a hundred refreshes inside the interval write nothing')
  t += 1000
  w.offer('c')
  assert.deepEqual(writes, ['a', 'c'], 'past the interval, the newest one is written')
  t += 2000
  w.offer('c')
  assert.deepEqual(writes, ['a', 'c'], 'unchanged: not rewritten')
  w.offer('d')
  w.flush()
  w.flush()
  assert.deepEqual(writes, ['a', 'c', 'd'], 'a flush writes what is newer, once')
})
