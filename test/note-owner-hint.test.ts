import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { BIN, decs, scratch } from './helpers.ts'

const stderrOf = (cwd: string, args: string[]) =>
  spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', DECS_AUTHOR: 'cli-test · lane', DECS_LANG: 'en', CLAUDECODE: '1' } }).stderr

test('a note that leaves something for the owner points at --for me', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', '--task', 'set up the proxy'])
  decs(root, ['start', '1'])
  assert.match(stderrOf(root, ['note', '1', 'DNS record: owner must add an A record for the proxy host', '--agent']), /--for me/)
  assert.match(stderrOf(root, ['note', '1', '仓库推送留给后续 session', '--agent']), /--for me/)
  assert.doesNotMatch(stderrOf(root, ['note', '1', 'proxy answers on 443 now', '--agent']), /--for me/)
})
