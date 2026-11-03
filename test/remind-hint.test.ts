import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'

import { BIN, decs, scratch } from './helpers.ts'

/** Like `decs`, but keeps stderr even on a successful (exit 0) run — a hint rides there. */
function run(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', DECS_AUTHOR: 'cli-test · lane', DECS_LANG: 'en', CLAUDECODE: '1' } })
}

function project(t: { after: (fn: () => void) => void }): string {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  return root
}

const get = (root: string, id: number) => JSON.parse(decs(root, ['get', String(id), '--json'])) as Record<string, any>

test('`nod add --for me` / `nod assign <id> me` hint when the words say remind/notify/tell me, but still file it', (t) => {
  const root = project(t)
  const hinted = run(root, ['add', 'remind me to call the vendor', '--for', 'me'])
  assert.equal(hinted.status, 0)
  assert.match(hinted.stderr, /nod add --remind/)
  assert.equal(get(root, 1).assignee, 'human', 'still filed, as asked')

  const plain = run(root, ['add', 'call the vendor', '--for', 'me'])
  assert.equal(plain.status, 0)
  assert.equal(plain.stderr, '', 'nothing to hint about: this really is the owner\'s own to-do')

  decs(root, ['add', '--task', 'notify owner: outage'])
  const assigned = run(root, ['assign', '3', 'me'])
  assert.equal(assigned.status, 0)
  assert.match(assigned.stderr, /nod add --remind/)
  assert.equal(get(root, 3).assignee, 'human')
})
