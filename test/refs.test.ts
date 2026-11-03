import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { initLayout } from '../src/core/paths.ts'
import { Store } from '../src/core/store.ts'
import { formatRef, parseBodyRefs, parseRef } from '../src/core/ref.ts'
import { configProblems, projectLetter, writeProjectConfig } from '../src/core/project.ts'
import { TITLE_MAX_COLS, titleProblem, titleWidth } from '../src/core/title.ts'
import { setLang } from '../src/i18n/index.ts'
import { decs, decsResult, scratch } from './helpers.ts'

test('parseRef: every shape people type', () => {
  assert.deepEqual(parseRef('305'), { id: 305 })
  assert.deepEqual(parseRef('T305'), { id: 305, letter: 'T' })
  assert.deepEqual(parseRef('t305'), { id: 305, letter: 'T' })
  assert.deepEqual(parseRef('D305'), { id: 305, letter: 'D' }, 'legacy D is just a letter here; Store.resolve gives it meaning')
  assert.deepEqual(parseRef('T:305'), { id: 305, letter: 'T' })
  assert.deepEqual(parseRef('T:D305'), { id: 305, letter: 'T' })
  assert.deepEqual(parseRef('web:305'), { id: 305, project: 'web' })
  assert.deepEqual(parseRef('web:D305'), { id: 305, project: 'web' })
  assert.throws(() => parseRef('D30x'), /is not a node number/)
  assert.throws(() => parseRef('TD305'), /is not a node number/, 'no type letter any more')
  assert.throws(() => parseRef('web:T305'), /project name and a project letter/)
  assert.equal(formatRef(305, 'T'), 'T305')
  assert.equal(formatRef(12, undefined), 'X12', 'no letter shows as X')
})

test('parseBodyRefs: legacy D, lettered refs, and sub-item labels that only look like refs', () => {
  const refs = parseBodyRefs('see D296 and T305; C12 is on that side. F1, T3, Q2 are subheadings. HD1080, ID301, D3011x are not. D296 again.', ['C', 'T'])
  assert.deepEqual(refs, [
    { id: 296, letter: 'D' },
    { id: 305, letter: 'T' },
    { id: 12, letter: 'C' },
  ])
})

test('project letter: decs.json, init --letter, config letter, check validation', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register', '--letter', 'T'])
  const l = initLayout(root)
  assert.equal(projectLetter(l), 'T')
  assert.deepEqual(JSON.parse(readFileSync(join(l.root, 'decs.json'), 'utf8')), { letter: 'T' })

  decs(root, ['add', 'short title'])
  assert.match(decs(root, ['show']), /^T1 · /m)
  assert.equal(JSON.parse(decs(root, ['get', 'T1', '--json'])).ref, 'T1')
  assert.equal(JSON.parse(decs(root, ['get', 'D1', '--json'])).ref, 'T1', 'legacy D1 still means "1, here"')
  assert.equal(JSON.parse(decs(root, ['get', 'T:1', '--json'])).id, 1)
  assert.ok(readdirSync(l.activeDir)[0].startsWith('1-'), 'new files carry no letter and no D')

  const wrong = decsResult(root, ['get', 'C1'])
  assert.equal(wrong.code, 1)
  assert.match(wrong.stderr, /no project is lettered C \(here: T=/)

  decs(root, ['config', 'letter', 'W'])
  assert.match(decs(root, ['show']), /^W1 · /m)
  assert.throws(() => writeProjectConfig(l, { letter: 'WW' }), /one capital letter/)

  writeFileSync(join(l.root, 'decs.json'), '{"letter": "ab"}')
  assert.equal(projectLetter(l), 'X', 'a broken letter falls back instead of failing')
  assert.match(configProblems(l)[0], /one A–Z letter/)
  assert.equal(decsResult(root, ['check']).code, 1)
})

test('two projects: letters disambiguate, a bare number in both is refused, clashes are flagged', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const a = join(root, 'web')
  const b = join(root, 'api')
  for (const p of [a, b]) mkdirSync(p, { recursive: true })
  const la = initLayout(a)
  const lb = initLayout(b)
  writeProjectConfig(la, { letter: 'W' })
  writeProjectConfig(lb, { letter: 'A' })
  new Store([la]).create({ title: "web's", author: 'x' })
  new Store([lb]).create({ title: "api's", author: 'x' })

  const store = new Store([la, lb])
  assert.equal(store.resolve('W1').title, "web's")
  assert.equal(store.resolve('A1').title, "api's")
  assert.equal(store.resolve('api:1').title, "api's")
  // Store.get's "exists in more than one project" message is English in the source.
  setLang('en')
  assert.throws(() => store.resolve('1'), /lettered form, e\.g\. W1/)
  assert.throws(() => store.resolve('D1'), /lettered form/, 'legacy D1 in a joined store is as ambiguous as 1')
  setLang('en')

  writeProjectConfig(lb, { letter: 'W' })
  const clashing = new Store([la, lb])
  assert.deepEqual(clashing.letterClashes(), [{ letter: 'W', projects: ['web', 'api'] }])
  assert.throws(() => clashing.resolve('W1'), /belongs to both web, api/)
  assert.equal(clashing.resolve('api:1').title, "api's", 'the project-name form still works')
  // decs check's own message for this is English in the source.
  const out = decsResult(root, ['check', '--dir', a, '--dir', b, '--json'], { DECS_LANG: 'en' })
  assert.ok(JSON.parse(out.stdout).some((p: { message: string }) => /project letter W is used by more than one/.test(p.message)))

  // A project actually lettered D: D1 is that project, not the legacy prefix.
  writeProjectConfig(lb, { letter: 'D' })
  assert.equal(new Store([la, lb]).resolve('D1').title, "api's")
})

test('titles: width limit on add, retitle to fix, check warns on old ones', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  // CJK glyphs are double-width, so these stay as CJK on purpose — they're exercising the
  // column-width math itself, not the language.
  assert.equal(titleWidth('部署守门规则'), 12)
  assert.equal(titleProblem('一'.repeat(TITLE_MAX_COLS / 2)), null, 'exactly at the limit is fine')
  assert.ok(titleProblem(`${'一'.repeat(TITLE_MAX_COLS / 2)}x`))

  const long = "Alice's CDN pick: switch straight to Cloudflare, or check with her first"
  const refused = decsResult(root, ['add', long])
  assert.equal(refused.code, 1)
  assert.match(refused.stderr, /title too long: \d+ columns, limit 32.*The title should only name what to decide; details go in the body/)
  assert.equal(readdirSync(join(root, 'decisions', 'active')).length, 0, 'nothing was written')

  // An old entry that predates the limit still reads fine, and check says so.
  // decs check's own message for this is English in the source.
  new Store([initLayout(root)]).create({ title: long, author: 'old · lane' })
  const json = JSON.parse(decsResult(root, ['check', '--json'], { DECS_LANG: 'en' }).stdout)
  assert.ok(json.some((p: { level: string; message: string }) => p.level === 'warn' && /wider than 32 columns/.test(p.message)))

  const file = readdirSync(join(root, 'decisions', 'active'))[0]
  decs(root, ['retitle', '1', 'how to pick the CDN'])
  assert.equal(JSON.parse(decs(root, ['get', '1', '--json'])).title, 'how to pick the CDN')
  assert.ok(existsSync(join(root, 'decisions', 'active', file)), 'the filename is unchanged')
  assert.equal(decsResult(root, ['retitle', '1', long]).code, 1, 'retitle obeys the same limit')
})

test('retitle: recorded as who changed it, refuses a stale --expect, --json, and a no-op says so', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 'first title', '--task'])
  const before = JSON.parse(decs(root, ['get', '1', '--json']))

  const asOwner = JSON.parse(decs(root, ['retitle', '1', 'second title', '--human', '--json'], { CLAUDECODE: undefined }))
  assert.equal(asOwner.title, 'second title')
  assert.match(decs(root, ['get', '1']), new RegExp(`## 补充（human · owner · `), 'a note says who retitled it')
  assert.match(decs(root, ['get', '1']), /原来是「first title」/, 'and what it was')

  // Stale --expect refuses, same as decs edit.
  const stale = decsResult(root, ['retitle', '1', 'third title', '--expect', before.updated_at])
  assert.equal(stale.code, 1)
  assert.match(stale.stderr, /changed since you opened it/)
  assert.equal(JSON.parse(decs(root, ['get', '1', '--json'])).title, 'second title', 'the stale attempt did not land')

  // A fresh --expect goes through.
  const fresh = JSON.parse(decs(root, ['get', '1', '--json'])).updated_at
  decs(root, ['retitle', '1', 'third title', '--expect', fresh])
  assert.equal(JSON.parse(decs(root, ['get', '1', '--json'])).title, 'third title')

  // Retitling to the same title is a no-op: no note, plain message.
  const notesBefore = JSON.parse(decs(root, ['get', '1', '--json'])).notes.length
  assert.match(decs(root, ['retitle', '1', 'third title']), /nothing changed/)
  assert.equal(JSON.parse(decs(root, ['get', '1', '--json'])).notes.length, notesBefore, 'no note for a no-op retitle')
})
