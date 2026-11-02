import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commandFor } from '../src/cli/index.ts'
import { decsResult, scratch } from './helpers.ts'

test('a bare decs opens the bench on a terminal and prints the usage when piped', () => {
  assert.equal(commandFor(undefined, true), 'bench')
  assert.equal(commandFor(undefined, false), 'help')
})

test('--help, -h and help print the usage on a terminal too; any other word is the command', () => {
  for (const word of ['--help', '-h', 'help']) assert.equal(commandFor(word, true), 'help')
  assert.equal(commandFor('show', true), 'show')
  assert.equal(commandFor('bench', false), 'bench')
})

test('a bare decs in a pipe prints the usage, which mentions it, and exits 0', () => {
  const r = decsResult(scratch(), [], { DECS_LANG: 'en' })
  assert.equal(r.code, 0)
  assert.match(r.stdout, /^nod — /)
  assert.match(r.stdout, /on a terminal, the same as nod bench; piped, prints this help/)
})

test('the plugin entry runs a command once and exits 0 — regression: it imported bin/decs.ts, which runs main itself and exports nothing', async () => {
  const { spawnSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const entry = fileURLToPath(new URL('../plugin/run-cli.mjs', import.meta.url))
  const r = spawnSync(process.execPath, [entry, '--version'], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim().split('\n').length, 1)
  assert.match(r.stdout, /^nod \d/)
})

test('nod --version and decs --version both work, and print the same thing — nod is the primary bin, decs stays an alias', async () => {
  const { execFileSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const env = { ...process.env, NO_COLOR: '1', DECS_LANG: 'en' }
  const run = (bin: string) => execFileSync(process.execPath, [fileURLToPath(new URL(bin, import.meta.url)), '--version'], { encoding: 'utf8', env })
  const fromNod = run('../bin/nod.ts')
  const fromDecs = run('../bin/decs.ts')
  assert.match(fromNod, /^nod \d/)
  assert.equal(fromNod, fromDecs)
})

test('a lane cannot finish, close, hold, ask on or reopen a node another agent filed without --force; its own and its children are fine', () => {
  const root = scratch()
  decsResult(root, ['init', '--no-register'], { DECS_LANG: 'en' })
  const as = (author: string, argv: string[]) => decsResult(root, argv, { DECS_LANG: 'en', DECS_AUTHOR: author })
  assert.equal(as('lead · x', ['add', 'lead node', '--task', '--author', 'lead · x']).code, 0)
  assert.equal(as('lane-a · x', ['add', 'lane a node', '--task', '--parent', '1', '--author', 'lane-a · x']).code, 0)
  assert.equal(as('lane-b · x', ['add', 'lane b node', '--task', '--author', 'lane-b · x']).code, 0)

  const wrong = as('lane-a · x', ['done', '3'])
  assert.notEqual(wrong.code, 0)
  assert.match(wrong.stderr, /filed by "lane-b", not you \(lane-a\)/)
  for (const argv of [['close', '3', '--reason', 'obsolete'], ['hold', '3', '--on', 'someone'], ['start', '3']])
    assert.notEqual(as('lane-a · x', argv).code, 0, argv.join(' '))

  assert.equal(as('lane-a · x', ['done', '2']).code, 0, 'its own node')
  assert.equal(as('lead · x', ['start', '2', '--force']).code, 0)
  assert.equal(as('lead · x', ['done', '2']).code, 0, 'the lead filed the parent')
  assert.equal(as('lane-a · x', ['done', '3', '--force']).code, 0, '--force goes through')
})

test('the owner\'s own terminal is never stopped by the other-author check', () => {
  const root = scratch()
  decsResult(root, ['init', '--no-register'], { DECS_LANG: 'en' })
  assert.equal(decsResult(root, ['add', 'lane node', '--task', '--author', 'lane-b · x'], { DECS_LANG: 'en' }).code, 0)
  const r = decsResult(root, ['done', '1'], { DECS_LANG: 'en', CLAUDECODE: '', DECS_ROLE: 'human', DECS_AUTHOR: 'owner' })
  assert.equal(r.code, 0, r.stderr)
})

test('the owner\'s words typed in the bench and relayed again by an agent are recorded once — regression: replies showed up twice', () => {
  const root = scratch()
  decsResult(root, ['init', '--no-register'], { DECS_LANG: 'en' })
  decsResult(root, ['add', 'colours', '--task', '--author', 'lane-o · mail'], { DECS_LANG: 'en' })
  const owner = { DECS_LANG: 'en', CLAUDECODE: '', DECS_ROLE: 'human' }
  assert.equal(decsResult(root, ['note', '1', 'not this red, use blue'], owner).code, 0)
  const relay = decsResult(root, ['note', '1', '--human', '--by', 'owner (said in chat, lane-o relayed)', 'not this red, use blue'], { DECS_LANG: 'en', DECS_AUTHOR: 'lane-o · mail' })
  assert.equal(relay.code, 0)
  assert.match(relay.stdout, /already has these exact words/)
  const body = decsResult(root, ['get', '1'], { DECS_LANG: 'en' }).stdout
  assert.equal(body.split('not this red, use blue').length - 1, 1)
  assert.equal(decsResult(root, ['note', '1', 'a different reply'], owner).code, 0)
  assert.equal(decsResult(root, ['get', '1'], { DECS_LANG: 'en' }).stdout.split('a different reply').length - 1, 1)
})
