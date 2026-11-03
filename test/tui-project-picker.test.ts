import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initLayout } from '../src/core/paths.ts'
import { Store } from '../src/core/store.ts'
import { bench, has } from './tui-harness.ts'

const A = 'lead · project picker test'

function twoProjectStore(t: { after: (fn: () => void) => void }): Store {
  const roots = [mkdtempSync(join(tmpdir(), 'decs-proj-a-')), mkdtempSync(join(tmpdir(), 'decs-proj-b-'))]
  t.after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })))
  return new Store(roots.map((r) => initLayout(r)))
}

test('App: P with one project open goes straight to the brief prompt, no project picker', async (t) => {
  const roots = [mkdtempSync(join(tmpdir(), 'decs-proj-solo-'))]
  t.after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })))
  const store = new Store(roots.map((r) => initLayout(r)))
  store.create({ title: 'existing', author: A, task: true })
  const b = bench(t, store, { view: 'all' })
  await b.until(has(b, /existing/))
  await b.press('P')
  await b.until(has(b, /New brief for an AI/))
  assert.ok(!has(b, /Which project/)())
})

test('App: P with more than one project open asks which project first; the new node lands there', async (t) => {
  const store = twoProjectStore(t)
  const b = bench(t, store, { view: 'all' })
  await b.until(has(b, /No nodes yet/)) // all empty: the viewEmpty hint shows, bench is up
  await b.press('P')
  await b.until(has(b, /Which project/))
  const second = store.layouts[1]
  const secondName = store.projectName(second)
  await b.until(has(b, new RegExp(secondName)))
  // digit 2 picks the second project and moves straight into the brief prompt
  await b.press('2')
  await b.until(has(b, /New brief for an AI/))
  await b.press('Write the onboarding doc', '\r')
  await b.until(has(b, /listening in/))
  const d = store.all().find((x) => x.title === 'Write the onboarding doc')!
  assert.equal(d.project, secondName)
})

test('App: in the project picker, ↑↓ then ⏎ also picks', async (t) => {
  const store = twoProjectStore(t)
  const b = bench(t, store, { view: 'all' })
  await b.until(has(b, /No nodes yet/))
  await b.press('P')
  await b.until(has(b, /Which project/))
  const second = store.projectName(store.layouts[1])
  await b.press('\x1b[B', '\r') // down, enter: the second row
  await b.until(has(b, /New brief for an AI/))
  await b.press('Second project task', '\r')
  await b.until(has(b, /listening in/))
  const d = store.all().find((x) => x.title === 'Second project task')!
  assert.equal(d.project, second)
})

test('App: Esc in the project picker cancels back to browse', async (t) => {
  const store = twoProjectStore(t)
  const b = bench(t, store, { view: 'all' })
  await b.until(has(b, /No nodes yet/))
  await b.press('P')
  await b.until(has(b, /Which project/))
  await b.press('\x1b')
  await b.until(() => !has(b, /Which project/)())
})
