import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'

import { decs, scratch } from './helpers.ts'

function tmpRoot(t: { after: (fn: () => void) => void }): string {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function askedAndAnswered(root: string): void {
  decs(root, ['add', 'ship v2.4', '-o', '1=ship', '2=hold', '--default', '1'])
  decs(root, ['push', '1', '1'], { CLAUDECODE: undefined, DECS_AUTHOR: undefined })
}

test('nod read --ack collects and writes a Received note in one step', (t) => {
  const root = tmpRoot(t)
  decs(root, ['init', '--no-register'])
  askedAndAnswered(root)

  decs(root, ['read', '1', '--ack', "shipping it now, will report back"])
  const d = JSON.parse(decs(root, ['get', '1', '--json']))
  assert.equal(d.status, 'in_progress')
  const last = d.notes.at(-1)
  assert.equal(last.role, 'agent')
  assert.equal(last.text, 'shipping it now, will report back')
})

test('nod read without --ack prints a reminder to reply; --ack suppresses it', (t) => {
  const root = tmpRoot(t)
  decs(root, ['init', '--no-register'])
  askedAndAnswered(root)

  const bare = decs(root, ['read', '1'])
  assert.match(bare, /--ack/)

  decs(root, ['add', 'another one', '-o', '1=ok'])
  decs(root, ['push', '2', '1'], { CLAUDECODE: undefined, DECS_AUTHOR: undefined })
  const acked = decs(root, ['read', '2', '--ack', 'on it'])
  assert.doesNotMatch(acked, /--ack <id>|nod read <id> --ack/)
})

test('nod read --ack with --json still returns the full node, note included', (t) => {
  const root = tmpRoot(t)
  decs(root, ['init', '--no-register'])
  askedAndAnswered(root)

  const out = JSON.parse(decs(root, ['read', '1', '--ack', 'got it', '--json']))
  assert.equal(out[0].notes.at(-1).text, 'got it')
})
