import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initLayout } from '../src/core/paths.ts'
import { Store } from '../src/core/store.ts'
import { readPreview } from '../src/tui/preview.ts'
import { bench, has, KEY } from './tui-harness.ts'

function scratchStore(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'noddit-preview-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, store: new Store([initLayout(root)]) }
}

test('o on a markdown attachment reads it in the bench; ←→ goes to the next one; q comes back', async (t) => {
  const { root, store } = scratchStore(t)
  const md = join(root, 'schema.md')
  writeFileSync(md, '# Schema notes\n\n- users: id, email\n')
  const log = join(root, 'migrate.log')
  writeFileSync(log, 'migration 1 ok\nmigration 2 ok\n')
  const d = store.create({ title: 'Write the schema', author: 'lane · test', task: true })
  store.attach(d, [md, log])
  const b = bench(t, store, { view: 'all' })
  await b.until(has(b, /Write the schema/))
  await b.press('o')
  await b.until(has(b, /Press a digit/))
  await b.press('1')
  await b.until(has(b, /schema\.md/))
  assert.ok(b.frame().some((l) => /^Schema notes/.test(l.trim())), 'the heading, without its #')
  assert.ok(b.frame().some((l) => /users: id, email/.test(l)))
  await b.press(KEY.right)
  await b.until(has(b, /migration 2 ok/))
  await b.press('q')
  await b.until(has(b, /Write the schema/))
})

test('a big file is cut at the first megabyte, and says so', (t) => {
  const { root } = scratchStore(t)
  const big = join(root, 'big.log')
  writeFileSync(big, 'x'.repeat(1_048_576 + 10))
  const r = readPreview(big)
  assert.equal(r.text.length, 1_048_576)
  assert.equal(r.truncated, true)
  assert.equal(readPreview(big, 2_000_000).truncated, false)
})
