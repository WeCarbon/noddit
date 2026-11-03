import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clipCols, cols } from '../app/src/cols.ts'

test('columns count CJK as two, and clipping never goes past the limit', () => {
  assert.equal(cols('追 Mubadala 回复'), 16)
  assert.equal(clipCols('一二三四五', 5), '一二')
  assert.equal(clipCols('abc一', 4), 'abc')
  assert.equal(clipCols('short', 32), 'short')
})
