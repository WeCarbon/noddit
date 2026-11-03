import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clampPan, FIT, zoomTo, ZOOM_MAX } from '../app/src/zoom.ts'

const W = 800
const H = 600

test('zoom keeps the point under the cursor in place', () => {
  const z = zoomTo(FIT, 2, 600, 300)
  assert.deepEqual(z, { scale: 2, x: -600, y: -300 })
  assert.deepEqual(clampPan(z, W, H, W, H), z)
})

test('zoom stays between fit and the maximum', () => {
  assert.deepEqual(zoomTo(FIT, 0.5, 100, 100), FIT)
  assert.equal(zoomTo(FIT, 100, 0, 0).scale, ZOOM_MAX)
})

test('a zoomed image pans to either edge and no further', () => {
  const at = (x: number) => clampPan({ scale: 2, x, y: 0 }, W, H, W, H).x
  assert.equal(at(0), 0, 'left edge reachable')
  assert.equal(at(-W), -W, 'right edge reachable')
  assert.equal(at(200), 0, 'no blank past the left edge')
  assert.equal(at(-W - 200), -W, 'no blank past the right edge')
})

test('an image still smaller than the window stays centred', () => {
  const z = clampPan({ scale: 2, x: 0, y: 0 }, 200, 100, W, H)
  assert.deepEqual(z, { scale: 2, x: -100, y: -50 })
})

test('no pan at fit', () => {
  assert.deepEqual(clampPan({ scale: 1, x: 40, y: 40 }, W, H, W, H), FIT)
})
