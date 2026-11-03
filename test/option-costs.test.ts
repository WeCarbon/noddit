import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { BIN, decs, scratch } from './helpers.ts'
import { optionsWithoutCost } from '../src/core/option-costs.ts'

const opt = (key: string, label: string, body = '') => ({ key, label, body })

test('options with no word on what they cost are named; explained, single and plan-confirm ones are not', () => {
  assert.deepEqual(optionsWithoutCost({ options: [opt('1', 'Keep'), opt('2', 'Switch', 'Two days, Bob.')], body: '' }), ['1'])
  assert.deepEqual(optionsWithoutCost({ options: [opt('1', 'Keep'), opt('2', 'Switch')], body: '### 1 · Keep\nFree.\n\n### 2 · Switch\nTwo days.' }), [])
  assert.deepEqual(optionsWithoutCost({ options: [opt('1', 'Looks good')], body: '' }), [])
  assert.deepEqual(optionsWithoutCost({ options: [opt('1', '按计划开始'), opt('2', '要改（回复里写怎么改）')], body: '' }), [])
})

test('nod add says which options lack a cost, and still files the node', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  const r = spawnSync(process.execPath, [BIN, 'add', 'Which CDN', '-o', '1=Keep', '2=Switch'], { cwd: root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', DECS_AUTHOR: 'cli-test · lane', DECS_LANG: 'en', CLAUDECODE: '1' } })
  assert.equal(r.status, 0)
  assert.match(r.stderr, /options 1 2 don’t say what choosing them costs/)
})
