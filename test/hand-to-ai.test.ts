import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

import { BIN, decs, decsResult, killAndWait, scratch } from './helpers.ts'

const owner = { CLAUDECODE: undefined, DECS_AUTHOR: undefined }

test('the owner starts their own to-do, then hands it to an AI: a reply from the owner, queued, and the AI picks it up', async (t) => {
  const root = scratch()
  const home = join(root, 'home')
  decs(root, ['init', '--no-register'])
  decs(root, ['add', '--task', 'research the DPP skill', '--for', 'me', '--author', 'lane-dpp · research'])
  decs(root, ['start', '1'], owner)
  const child = spawn(process.execPath, [BIN, 'monitor', '--mine', '--no-sources', '--interval', '150'], {
    cwd: root,
    env: { ...process.env, NO_COLOR: '1', CLAUDECODE: '1', DECS_AUTHOR: 'lane-dpp · research', DECS_HOME: home },
  })
  t.after(() => killAndWait(child))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  let out = ''
  let err = ''
  child.stdout.on('data', (b) => (out += b))
  child.stderr.on('data', (b) => (err += b))
  const until = async (ok: () => boolean, what: string) => {
    for (const end = Date.now() + 10_000; !ok(); await new Promise((r) => setTimeout(r, 50)))
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${out}${err}`)
  }
  await until(() => err.includes('nod monitor: watching'), 'the monitor to start')

  assert.match(decs(root, ['assign', '1', 'ai', '--note', 'draft the skill outline from my notes'], owner), /handed to an AI/)
  const d = JSON.parse(decs(root, ['get', '1', '--json']))
  assert.equal(d.assignee, 'ai')
  assert.equal(d.status, 'decided', 'waiting for the AI to collect, like any reply')
  assert.match(decs(root, ['get', '1']), /交给 AI 了[\s\S]*draft the skill outline from my notes/)
  assert.match(decs(root, ['queue']), /X1/)
  await until(() => /X1/.test(out), 'the AI hearing it')
  assert.match(out, /draft the skill outline/)
})

test('an agent still needs --force to take the owner\'s to-do, and that is a plain reassignment', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', '--task', 'call the vendor', '--for', 'me'])
  assert.notEqual(decsResult(root, ['assign', '1', 'ai']).code, 0)
  decs(root, ['assign', '1', 'ai', '--force'])
  const d = JSON.parse(decs(root, ['get', '1', '--json']))
  assert.equal(d.assignee, 'ai')
  assert.equal(d.status, 'not_started')
})
