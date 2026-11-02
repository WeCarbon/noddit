import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { decs, scratch } from './helpers.ts'

type Node = { body_attachments: { label: string }[]; notes: { kind: string; author: string; role: string; text: string; attachments: { label: string }[] }[]; approvals: { target: string }[] }

function project(t: { after: (fn: () => void) => void }): { root: string; file: (name: string) => string } {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 'Thank-you email', '-o', '1=Send it', '2=Change it'])
  const file = (name: string) => {
    const p = join(root, name)
    writeFileSync(p, `<p>${name}</p>`)
    return p
  }
  return { root, file }
}

const get = (root: string) => JSON.parse(decs(root, ['get', '1', '--json'])) as Node
const owner = { CLAUDECODE: undefined, DECS_ROLE: 'human' }

test('before anyone answers, a bare attach goes on the body, as when the node was filed', (t) => {
  const { root, file } = project(t)
  decs(root, ['attach', '1', file('first.html')])
  assert.deepEqual(get(root).body_attachments.map((a) => a.label), ['first.html'])
})

test('after the owner wrote, a bare attach starts the author\'s own short section, never the body', (t) => {
  const { root, file } = project(t)
  decs(root, ['note', '1', 'please draft a warmer one'], owner)
  decs(root, ['attach', '1', file('draft.html'), '--approval-content', '--approve-on', '1'])
  const d = get(root)
  assert.deepEqual(d.body_attachments, [])
  const mine = d.notes.at(-1)!
  assert.equal(mine.author, 'cli-test · lane')
  assert.equal(mine.text.split('\n')[0], '附件见下。')
  assert.deepEqual(mine.attachments.map((a) => a.label), ['draft.html'])
  assert.ok(d.approvals.some((a) => a.target.endsWith('draft.html')), 'the approval is kept')
  // The note that presents it, written right after, is the author's latest: a second attach joins it.
  decs(root, ['note', '1', 'Drafted — see above'])
  decs(root, ['attach', '1', file('draft-2.html')])
  assert.deepEqual(get(root).notes.at(-1)!.attachments.map((a) => a.label), ['draft-2.html'])
})

test('ask --attach writes the question and its draft in the same section', (t) => {
  const { root, file } = project(t)
  decs(root, ['note', '1', 'go ahead'], owner)
  decs(root, ['ask', '1', '-o', '1=Send it', '2=Change it', '--text', 'Draft ready — send?', '--attach', file('ask.html'), '--approval-content', '--approve-on', '1'])
  const d = get(root)
  const q = d.notes.at(-1)!
  assert.match(q.text, /Draft ready/)
  assert.deepEqual(q.attachments.map((a) => a.label), ['ask.html'])
})

test('attach --move lists a file under another section; the file and its approval stay', (t) => {
  const { root, file } = project(t)
  decs(root, ['attach', '1', file('moved.html'), '--approval-content', '--approve-on', '1'])
  decs(root, ['note', '1', 'Drafted the email — attached'])
  decs(root, ['attach', '1', '--move', 'moved.html', '--to', '1'])
  const d = get(root)
  assert.deepEqual(d.body_attachments, [])
  assert.deepEqual(d.notes[0].attachments.map((a) => a.label), ['moved.html'])
  assert.ok(d.approvals.some((a) => a.target.endsWith('moved.html')))
})
