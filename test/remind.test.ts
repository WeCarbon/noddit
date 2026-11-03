import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { staleNagDue, staleTasksOf } from '../src/core/checkins.ts'
import { initLayout, type Layout } from '../src/core/paths.ts'
import { Store } from '../src/core/store.ts'
import { remindMark } from '../src/tui/views.ts'
import type { Decision } from '../src/core/types.ts'
import { BIN, decs, decsResult, killAndWait, scratch } from './helpers.ts'

function project(t: { after: (fn: () => void) => void }): string {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  return root
}

function tmpLayout(t: { after: (fn: () => void) => void }): Layout {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return initLayout(root)
}

const get = (root: string, id: number) => JSON.parse(decs(root, ['get', String(id), '--json'])) as Record<string, any>

test('nod add --remind takes a loose day/time; nod edit --remind moves or clears it; nod show remind lists what is live', (t) => {
  const root = project(t)
  decs(root, ['add', '--remind', '11-07 09:00', 'tell the owner about the demo'])
  decs(root, ['add', '--task', 'no reminder'])
  const d = get(root, 1)
  assert.match(String(d.remind_at), /^2026-11-07T09:00:00/)
  assert.equal(d.kind, 'task')
  assert.equal(d.assignee, 'ai')
  assert.equal(d.human_task, false)
  assert.deepEqual(JSON.parse(decs(root, ['show', 'remind', '--json'])).map((x: { id: number }) => x.id), [1])

  decs(root, ['edit', '1', '--remind', '2026-12-01T08:00'])
  assert.match(String(get(root, 1).remind_at), /^2026-12-01T08:00:00/)
  decs(root, ['edit', '1', '--remind', 'off'])
  assert.equal(get(root, 1).remind_at, null)
  assert.notEqual(decsResult(root, ['edit', '1', '--remind', 'whenever']).code, 0)
  assert.deepEqual(JSON.parse(decs(root, ['show', 'remind', '--json'])), [])
})

test('--remind never mixes with --for (reminding the owner is an AI\'s job), options, --brief or --fyi', (t) => {
  const root = project(t)
  const forMe = decsResult(root, ['add', '--remind', 'fri', 'x', '--for', 'me'])
  assert.notEqual(forMe.code, 0)
  assert.match(forMe.stderr, /AI's job/)
  assert.notEqual(decsResult(root, ['add', '--remind', 'fri', 'x', '-o', '1=a', '2=b']).code, 0)
  assert.notEqual(decsResult(root, ['add', '--remind', 'fri', 'x', '--fyi']).code, 0)
  assert.notEqual(decsResult(root, ['add', '--remind', 'whenever', 'x']).code, 0)
})

test('remindMark: a live reminder shows on the row like a due date; nothing once it has fired, is cleared, or the node is done', () => {
  const now = new Date(2026, 10, 3, 10, 0).getTime()
  const tomorrow = new Date(2026, 10, 4, 9, 0).toISOString()
  const node = (remindAt: string | undefined, extra: Partial<Decision> = {}) => ({ id: 1, state: 'not_started', notes: [], remindAt, ...extra }) as Decision
  assert.match(remindMark(node(tomorrow), now)!.text, /Remind/)
  assert.equal(remindMark(node(undefined), now), null)
  assert.equal(remindMark(node(tomorrow, { state: 'completed' }), now), null)
  const past = new Date(2026, 10, 3, 8, 0).toISOString()
  assert.match(remindMark(node(past), now)!.text, /now/i)
  assert.equal(remindMark(node(past, { notes: [{ kind: '已提醒' } as never] }), now), null, 'already told the owner; nothing more to show')
})

test('Store.fireDueReminders: writes one 已提醒 note the first time anything looks past remind_at, never twice for the same remind_at', (t) => {
  const l = tmpLayout(t)
  const store = new Store([l])
  const past = new Date(Date.now() - 60_000).toISOString()
  const future = new Date(Date.now() + 3_600_000).toISOString()
  const due = store.create({ title: 'tell the owner', author: 'lead · remind', task: true, remindAt: past })
  const notYet = store.create({ title: 'not yet', author: 'lead · remind', task: true, remindAt: future })

  const fired = store.fireDueReminders()
  assert.deepEqual(fired.map((d) => d.id), [due.id])
  const reread = store.get(due.id)!
  assert.ok(reread.notes.some((n) => n.kind === '已提醒' && n.author === 'nod'))

  assert.deepEqual(store.fireDueReminders(), [], 'already told; not again')
  assert.equal(store.get(notYet.id)!.notes.length, 0, 'not due yet')

  // Moving it to a time later than the fired note starts over; `fireDueReminders(now)` takes an
  // explicit clock so this needs no real waiting — only the note's own write uses the real one.
  const firedAt = Date.parse(reread.notes.find((n) => n.kind === '已提醒')!.at)
  const movedLater = store.setFields(reread, { remindAt: new Date(firedAt + 5000).toISOString() })
  assert.deepEqual(store.fireDueReminders(firedAt + 1000), [], 'not due until its new, later time')
  assert.deepEqual(store.fireDueReminders(firedAt + 6000).map((d) => d.id), [movedLater.id], 'past its new time now; fires again')
})

test('staleTasksOf / staleNagDue: a reminder not yet due is not a stale task; past its clock it can be', (t) => {
  const l = tmpLayout(t)
  const store = new Store([l])
  const write = Date.parse('2026-01-01T00:00:00.000Z')
  const min = 60_000
  const future = new Date(write + 10 * min).toISOString()
  const past = new Date(write - min).toISOString()
  const items = [
    { id: 1, project: 'p', state: 'not_started', created: new Date(write).toISOString(), remindAt: future } as Decision,
    { id: 2, project: 'p', state: 'not_started', created: new Date(write).toISOString(), remindAt: past } as Decision,
  ]
  assert.deepEqual(staleTasksOf(items, write).map((d) => d.id), [2])
  assert.equal(staleNagDue(l, { id: 1, state: 'not_started', updatedAt: items[0].created, created: items[0].created, remindAt: future }, write + 11 * min), undefined)
})

test('a reminder fires once as NODDIT-REMIND, with its next step, then nod done closes it', async (t) => {
  const root = scratch()
  decs(root, ['init', '--no-register'])
  const soon = new Date(Date.now() + 1500)
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${soon.getFullYear()}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())}T${pad(soon.getHours())}:${pad(soon.getMinutes())}:${pad(soon.getSeconds())}`
  decs(root, ['add', '--remind', stamp, 'tell the owner it is ready'])
  const { spawn } = await import('node:child_process')
  const home = join(root, 'home')
  const child = spawn(process.execPath, [BIN, 'monitor', '--with-parent', String(process.pid), '--interval', '150', '--json'], {
    cwd: root,
    env: { ...process.env, NO_COLOR: '1', CLAUDECODE: '1', DECS_HOME: home },
  })
  let out = ''
  child.stdout.on('data', (b) => (out += b))
  t.after(() => killAndWait(child))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const lines = () => out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const until = async (ok: () => boolean, what: string) => {
    for (const end = Date.now() + 10_000; !ok(); await new Promise((r) => setTimeout(r, 50)))
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${out}`)
  }
  await until(() => existsSync(join(home, 'monitor')) && readdirSync(join(home, 'monitor')).some((f) => f.endsWith('.json')), 'the monitor to start')
  await until(() => lines().some((l) => l.event === 'remind' && l.ref === 'X1'), 'the reminder to fire')
  await new Promise((r) => setTimeout(r, 400))
  assert.equal(lines().filter((l) => l.event === 'remind').length, 1, 'once, not once per poll')
  decs(root, ['done', '1'])
  assert.equal(get(root, 1).status, 'completed')
})
