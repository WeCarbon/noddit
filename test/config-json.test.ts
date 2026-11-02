import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

import { decs, scratch } from './helpers.ts'

type Item = { key: string; label: string; value: string; source: string; choices: { value: string; label: string }[] }

test('nod config --json lists every setting with its label, value, source and choices; a set answers with the new one', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const env = { DECS_HOME: join(root, 'home'), NODDIT_HOME: join(root, 'home'), DECS_LANG: undefined, NODDIT_LANG: undefined }
  const all = JSON.parse(decs(root, ['config', '--json'], env)) as { settings: Item[] }
  const keys = all.settings.map((s) => s.key)
  assert.ok(keys.includes('lang') && keys.includes('bidi') && keys.includes('mouse'))
  const mouse = all.settings.find((s) => s.key === 'mouse')!
  assert.equal(mouse.label, 'Mouse')
  assert.equal(mouse.source, 'default')
  assert.deepEqual(mouse.choices.map((c) => c.value), ['on', 'off'])
  const set = JSON.parse(decs(root, ['config', 'mouse', 'off', '--json'], env)) as Item
  assert.equal(set.value, 'off')
  assert.equal(set.source, 'config')
  const back = JSON.parse(decs(root, ['config', 'mouse', '--off', '--json'], env)) as Item
  assert.equal(back.source, 'default')
})
