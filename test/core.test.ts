import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { parseArgs, parseOptionPairs, many, one, bool, oneLine } from '../src/cli/args.ts'
import { parseAttachments, parseDecision, parseOptions, splitFrontMatter } from '../src/core/parse.ts'
import { appendSection, renderAttachmentsBlock, serializeDecision, slugify } from '../src/core/serialize.ts'
import { findLayout, initLayout } from '../src/core/paths.ts'
import { Store, benchOrder, nowStamp, sha256File } from '../src/core/store.ts'
import { elapsed } from '../src/i18n/time.ts'
import { setLang } from '../src/i18n/index.ts'
import { isScratchPath } from '../src/core/config.ts'
import { openerFor } from '../src/core/opener.ts'
import type { Decision } from '../src/core/types.ts'

import { decs, decsResult } from './helpers.ts'
const BIN = fileURLToPath(new URL('../bin/decs.ts', import.meta.url))
const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** A few of store.ts's own error messages are English in the source (mixed in among the Chinese ones); run just those checks in English. */
function inEnglish<T>(fn: () => T): T {
  setLang('en')
  try {
    return fn()
  } finally {
    setLang('en')
  }
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'decs-test-'))
}

const SAMPLE = `---
id: 415
title: "部署守门规则要多严：一条会挡掉 4/6 的检查"
author: deploy-lane · lane
status: open
created: 2026-09-11T00:12:33+08:00
default: "1"
---

**这是什么。** 门。

## 选项

### 1 · 严格：树必须一致
挡掉最近 6 次里的 4 次。

### 2 · 只看会上线的文件
判断本身会错。

## 默认动作

保持 1。
`

test('front matter survives colons and full-width punctuation in the title', () => {
  const { data, body } = splitFrontMatter(SAMPLE)
  assert.equal(data.id, 415)
  assert.equal(data.title, '部署守门规则要多严：一条会挡掉 4/6 的检查')
  assert.ok(body.startsWith('\n**这是什么。**'))
})

test('options come from the body and nowhere else', () => {
  const d = parseDecision(SAMPLE, '/x/D415-a.md', false, 'web')
  assert.deepEqual(
    d.options.map((o) => [o.key, o.label]),
    [
      ['1', '严格：树必须一致'],
      ['2', '只看会上线的文件'],
    ],
  )
  assert.equal(d.options[0].body, '挡掉最近 6 次里的 4 次。')
  assert.equal(d.default, '1')
})

test('a file saved with CRLF line endings (Windows editor, git core.autocrlf) parses the same as LF', () => {
  const crlf = SAMPLE.replace(/\n/g, '\r\n')
  const lf = parseDecision(SAMPLE, '/x/D415-a.md', false, 'web')
  const d = parseDecision(crlf, '/x/D415-a.md', false, 'web')
  assert.deepEqual(d.options.map((o) => [o.key, o.label, o.body]), lf.options.map((o) => [o.key, o.label, o.body]))
  assert.equal(d.default, lf.default)
  assert.equal(d.title, lf.title)
  assert.equal(d.body.replace(/\r\n/g, '\n'), lf.body)
})

test('a lone CR (old-style Mac line endings) also normalises to LF', () => {
  const cr = SAMPLE.replace(/\n/g, '\r')
  const d = parseDecision(cr, '/x/D415-a.md', false, 'web')
  assert.deepEqual(d.options.map((o) => o.key), ['1', '2'])
})

test('the options block stops at the next h2', () => {
  const opts = parseOptions(SAMPLE)
  assert.equal(opts.length, 2, 'the 默认动作 section must not become an option')
})

test('legacy letter keys and alternate separators still parse', () => {
  const body = ['## 各选项', '', '### A —— keep things as they are', 'Cost: none.', '', '### B: swap it out', 'Cost: a week.'].join('\n')
  assert.deepEqual(
    parseOptions(body).map((o) => [o.key, o.label]),
    [
      ['A', 'keep things as they are'],
      ['B', 'swap it out'],
    ],
  )
})

test('an entry with no options block yields no options rather than guesses', () => {
  const d = parseDecision(
    '---\nid: 9\ntitle: x\nauthor: a\n---\n\nSome freeform body text with ### in it, but outside the options section.\n',
    '/x/D9.md',
    false,
  )
  assert.deepEqual(d.options, [])
})

test('serialize -> parse -> serialize is stable', () => {
  const d = parseDecision(SAMPLE, '/x/D415-a.md', false, 'web')
  const once = serializeDecision(d)
  const twice = serializeDecision(parseDecision(once, '/x/D415-a.md', false, 'web'))
  assert.equal(once, twice)
  assert.ok(once.includes('### 1 · 严格：树必须一致'), 'body must not be reformatted')
})

test('appendSection never disturbs what came before', () => {
  const before = '**这是什么。** 门。\n'
  const after = appendSection(before, '已答（owner · 2026-09-11 00:30）', '1 —— 严格')
  assert.ok(after.startsWith(before.trimEnd()))
  assert.ok(after.endsWith('## 已答（owner · 2026-09-11 00:30）\n\n1 —— 严格\n'))
})

test('slugify keeps CJK and stays short enough to read in ls', () => {
  const s = slugify('部署守门规则要多严：一条测出来会挡掉最近 6 次里的 4 次的检查')
  assert.ok(s.length <= 20)
  assert.ok(!s.includes('：'))
  assert.equal(slugify('!!!'), 'entry')
})

test('--option only eats key=label pairs, so a trailing title stays positional', () => {
  const a = parseArgs(['--option', '1=keep the current setup', '2=switch to Foundry', 'the title comes after'])
  assert.deepEqual(a._, ['the title comes after'])
  assert.deepEqual(
    parseOptionPairs(many(a, 'option', 'o')).map((o) => [o.key, o.label]),
    [
      ['1', 'keep the current setup'],
      ['2', 'switch to Foundry'],
    ],
  )
})

test('--dir is greedy and repeatable, both spellings', () => {
  assert.deepEqual(many(parseArgs(['--dir', '/a', '/b']), 'dir'), ['/a', '/b'])
  assert.deepEqual(many(parseArgs(['--dir', '/a', '--dir', '/b']), 'dir'), ['/a', '/b'])
})

test('a multi-line option value keeps its first line as the heading', () => {
  const [o] = parseOptionPairs(['1=strict: the tree must match\nCost: blocks 4/6.'])
  assert.equal(o.label, 'strict: the tree must match')
  assert.equal(o.body, 'Cost: blocks 4/6.')
  assert.equal(oneLine('a\n  b\tc'), 'a b c')
})

test('booleans and single-value flags', () => {
  const a = parseArgs(['313', '2', '--note', "that's final", '--json'])
  assert.deepEqual(a._, ['313', '2'])
  assert.equal(one(a, 'note'), "that's final")
  assert.ok(bool(a, 'json'))
})

test('store: create, answer, collect, archive', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])

  const d = store.create({
    title: 'whether to connect to Foundry',
    author: 'model-lane · look into Foundry',
    body: '**What it is.** Routing.',
    options: [
      { key: '1', label: 'stay directly connected' },
      { key: '2', label: 'switch to Foundry' },
    ],
    default: '1',
  })
  assert.equal(d.id, 1)
  assert.equal(d.status, 'open')
  assert.ok(!d.archived)

  const answered = store.answer(d, { choice: '2', note: 'Switch, but set up deployment first.' })
  assert.equal(answered.status, 'answered')
  assert.ok(!answered.archived, 'an answer nobody has collected stays visible in active/')
  assert.ok(answered.queued)
  assert.equal(answered.answer?.choice, '2')
  assert.ok(readFileSync(answered.file, 'utf8').includes('## 已答（human · owner · '))

  assert.deepEqual(store.queue().map((x) => x.id), [1])

  const collected = store.deliver(answered)
  assert.ok(!collected.archived, 'collecting means seen, not done — it stays in active/')
  assert.ok(!collected.queued)
  assert.deepEqual(store.queue(), [])
  assert.equal(readdirSync(join(root, 'decisions', 'active')).length, 1)

  const done = store.archive(collected)
  assert.ok(done.archived)
  assert.equal(readdirSync(join(root, 'decisions', 'active')).length, 0)
  assert.equal(readdirSync(join(root, 'decisions', 'archived')).length, 1)
  assert.throws(() => inEnglish(() => store.archive(done)), /already archived/)
})

test('feedback with no choice queues just like an answer', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  const d = store.create({ title: 't', author: 'lane · x', options: [{ key: '1', label: 'a' }] })

  // a push-back with no choice is still a real response the lane must see
  const noted = store.append(d, '追问（owner · 2026-09-10 01:00）', 'clarify first whether this affects another lane', 'owner')
  assert.ok(noted.queued)
  assert.deepEqual(store.queue().map((x) => x.id), [d.id])

  const free = store.create({ title: 't2', author: 'lane · x' })
  const answered = store.answer(free, { note: 'no need to pick — just go with the default' })
  assert.equal(answered.answer?.choice, undefined)
  assert.ok(answered.queued)
  assert.deepEqual(store.queue().map((x) => x.id), [d.id, free.id])
})

test('queue is FIFO by when it was answered, and filters by author', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  const mk = (title: string, author: string) =>
    store.create({ title, author, options: [{ key: '1', label: 'x' }, { key: '2', label: 'y' }] })

  const a1 = mk('a1', 'lane-a · active')
  const b1 = mk('b1', 'lane-b · someone else')
  const a2 = mk('a2', 'lane-a · active')

  store.answer(store.get(a2.id)!, { choice: '1', note: 'answer this one first' })
  store.answer(store.get(b1.id)!, { choice: '2', note: "someone else's" })
  store.answer(store.get(a1.id)!, { choice: '1', note: 'answer last' })

  assert.deepEqual(store.queue().map((d) => d.id), [a2.id, b1.id, a1.id])
  assert.deepEqual(store.queue({ author: 'lane-a' }).map((d) => d.id), [a2.id, a1.id])

  store.deliver(store.queue({ author: 'lane-a' })[0])
  assert.deepEqual(store.queue({ author: 'lane-a' }).map((d) => d.id), [a1.id])
  assert.deepEqual(store.queue({ author: 'lane-b' }).map((d) => d.id), [b1.id], "another lane's answer is untouched")
})

test('an owner follow-up queues; a lane note does not', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  const d = store.create({ title: 't', author: 'lane · x', options: [{ key: '1', label: 'a' }] })

  const own = store.append(d, '执行记录（lane · 2026-09-10 01:00）', 'what I did', 'lane')
  assert.ok(!own.queued, 'a lane appending its own record must not wake itself up')

  const asked = store.append(own, '追问（owner · 2026-09-10 01:01）', 'will this affect another lane?', 'owner')
  assert.ok(asked.queued)
  assert.equal(asked.status, 'open', 'a follow-up does not answer anything')

  const delivered = store.deliver(asked)
  assert.ok(!delivered.archived)
  assert.ok(!delivered.queued)
})

test('default: prefix on an option marks the default action', () => {
  const a = parseArgs(['--option', '1=keep the current setup', 'default:2=switch to Foundry'])
  const opts = parseOptionPairs(many(a, 'option', 'o'))
  assert.deepEqual(opts.map((o) => [o.key, o.label, o.isDefault]), [
    ['1', 'keep the current setup', false],
    ['2', 'switch to Foundry', true],
  ])
})

test('store: an answer must name an option that exists', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  const d = store.create({
    title: 't',
    author: 'a',
    options: [{ key: '1', label: 'x' }],
  })
  assert.throws(() => inEnglish(() => store.answer(d, { choice: '9' })), /no option "9"/)
  assert.throws(() => inEnglish(() => store.answer(d, {})), /choice or a note/)
})

test('store: -o never produces an entry with zero options, even when the body has a near-miss heading', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])

  // near-miss headings must not make `add` think options are already
  // written, leaving options: [] and an unpressable default
  for (const heading of ['## 选项和代价', '## 选项及代价']) {
    const d = store.create({
      title: `near-miss: ${heading}`,
      author: 'a',
      body: `${heading}\n\nSome explanatory text unrelated to the options.`,
      options: [
        { key: '1', label: 'keep the current setup' },
        { key: '2', label: 'switch to Foundry' },
      ],
      default: '2',
    })
    assert.deepEqual(
      d.options.map((o) => o.key),
      ['1', '2'],
      `${heading} must not swallow the real options block`,
    )
    assert.equal(d.default, '2')
    // what's written must parse back the same way decs get/check reads it
    assert.deepEqual(parseOptions(readFileSync(d.file, 'utf8')).map((o) => o.key), ['1', '2'])
  }
})

test('store: a body with a real, matching options heading is left alone (idempotent)', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  const body = ['## 选项', '', '### 1 · keep the current setup', '', '### 2 · switch to Foundry', ''].join('\n')
  const d = store.create({
    title: 't',
    author: 'a',
    body,
    options: [
      { key: '1', label: 'keep the current setup' },
      { key: '2', label: 'switch to Foundry' },
    ],
  })
  assert.equal(readFileSync(d.file, 'utf8').match(/^## 选项$/m)?.length ?? 0, 1, 'the options heading must not be duplicated')
})

test('store: a body with a real options heading that disagrees with -o is refused, not silently dropped', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  const body = ['## 选项', '', '### 1 · a different option', ''].join('\n')
  assert.throws(
    () =>
      inEnglish(() =>
        store.create({
          title: 't',
          author: 'a',
          body,
          options: [
            { key: '1', label: 'keep the current setup' },
            { key: '2', label: 'switch to Foundry' },
          ],
        }),
      ),
    /does not match -o: 1: body「a different option」≠ -o「keep the current setup」; 2「switch to Foundry」only in -o/,
  )
})

test('store: signing is not optional', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  assert.throws(() => inEnglish(() => store.create({ title: 't', author: '  ' })), /--author is required/)
})

test('store: a default that names no option is refused at write time', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  assert.throws(
    () => inEnglish(() => store.create({ title: 't', author: 'a', options: [{ key: '1', label: 'x' }], default: '2' })),
    /not one of the options/,
  )
})

test('ids are never reused after archiving', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  const a = store.create({ title: 'a', author: 'x', options: [{ key: '1', label: 'y' }] })
  store.answer(a, { choice: '1' })
  const b = store.create({ title: 'b', author: 'x' })
  assert.equal(b.id, 2, 'archiving D1 must not free up the number 1')
})

test('concurrent writers never collide on a number', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  initLayout(root)
  const N = 12
  const procs = Array.from({ length: N }, (_, i) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [BIN, 'add', `concurrent ${i}`, '--author', 'race · lane'], {
        cwd: root,
        stdio: ['ignore', 'ignore', 'inherit'],
      })
      child.once('error', reject)
      child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))))
    }),
  )
  return Promise.all(procs).then(() => {
    const ids = readdirSync(join(root, 'decisions', 'active')).map((f) => Number(/^D?(\d+)/.exec(f)![1]))
    assert.equal(new Set(ids).size, N)
    assert.deepEqual([...ids].sort((x, y) => x - y), Array.from({ length: N }, (_, i) => i + 1))
  })
})

test('bench order: pinned top, then longest waiting, then parked', () => {
  const mk = (id: number, created: string, pin?: 'top' | 'bottom') =>
    ({ id, created, pin, options: [], tags: [] }) as unknown as Decision
  const list = [
    mk(1, '2026-09-01T00:00:00+08:00'),
    mk(2, '2026-09-03T00:00:00+08:00', 'top'),
    mk(3, '2026-08-01T00:00:00+08:00', 'bottom'),
    mk(4, '2026-08-20T00:00:00+08:00'),
  ].sort(benchOrder)
  assert.deepEqual(list.map((d) => d.id), [2, 4, 1, 3])
})

test('elapsed (src/i18n/time.ts) reads as how long it has been waiting, in English', () => {
  setLang('en')
  const now = Date.parse('2026-09-11T12:00:00+08:00')
  assert.equal(elapsed('2026-09-11T11:30:00+08:00', now), '30 minutes')
  assert.equal(elapsed('2026-09-11T04:00:00+08:00', now), '8 hours')
  // dayjs is coarser than the old hand-rolled "2 days 3 hours": it picks one unit.
  assert.equal(elapsed('2026-09-09T09:00:00+08:00', now), '2 days')
  assert.equal(elapsed('not a date', now), '')
})

test('nowStamp round-trips through Date.parse', () => {
  const s = nowStamp(new Date('2026-09-11T00:12:33Z'))
  assert.ok(!Number.isNaN(Date.parse(s)))
  assert.equal(Date.parse(s), Date.parse('2026-09-11T00:12:33Z'))
})

test('cli: check flags a default that names no option when there are no options at all', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  // decs check's own messages for this are English in the source.
  const env = { ...process.env, DECS_AUTHOR: 'cli-test · lane', DECS_LANG: 'en' }
  execFileSync(process.execPath, [BIN, 'init', '--no-register'], { cwd: root, env, input: '' })

  // hand-write the broken shape directly: default set, but the heading doesn't parse into options
  writeFileSync(
    join(root, 'decisions', 'active', 'D1-broken.md'),
    [
      '---',
      'id: 1',
      'title: broken entry',
      'author: a',
      'status: open',
      'created: 2026-10-25T00:00:00+08:00',
      'default: "2"',
      '---',
      '',
      '## 选项和代价',
      '',
      'Not a real options heading.',
      '',
    ].join('\n'),
  )

  // decs check exits 1 on an error-level problem, so read the JSON off the thrown error's stdout
  let out: string
  try {
    out = execFileSync(process.execPath, [BIN, 'check', '--json'], { cwd: root, env, encoding: 'utf8', input: '' })
  } catch (e) {
    out = (e as { stdout: string }).stdout
  }
  const problems = JSON.parse(out)
  const hit = problems.find((p: { message: string }) => /no options at all/.test(p.message))
  assert.ok(hit, `expected a "no options at all" problem, got: ${JSON.stringify(problems)}`)
  assert.equal(hit.level, 'error')
})

test('cli: add via heredoc-style stdin, then get --json', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const env = { ...process.env, DECS_AUTHOR: 'cli-test · lane' }
  execFileSync(process.execPath, [BIN, 'init', '--no-register'], { cwd: root, env, input: '' })
  execFileSync(process.execPath, [BIN, 'add', 'title goes in the argument', '-o', '1=do it', '2=skip it'], {
    cwd: root,
    env,
    input: '**What it is.** The body comes from stdin.\n',
  })
  const out = execFileSync(process.execPath, [BIN, 'get', '1', '--json'], { cwd: root, env, encoding: 'utf8', input: '' })
  const d = JSON.parse(out)
  assert.equal(d.title, 'title goes in the argument')
  assert.equal(d.author, 'cli-test · lane')
  assert.equal(d.options.length, 2)
  assert.ok(d.body.includes('The body comes from stdin'))
})

test('cli: a piped document supplies its own title and front matter', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const env = { ...process.env }
  delete env.DECS_AUTHOR
  execFileSync(process.execPath, [BIN, 'init', '--no-register'], { cwd: root, env, input: '' })
  execFileSync(process.execPath, [BIN, 'add'], {
    cwd: root,
    env,
    input: [
      '---',
      'author: piped-lane · verifying',
      '---',
      '',
      '# Done, take a look',
      '',
      '**Where to look.** Settings → About.',
      '',
    ].join('\n'),
  })
  const d = JSON.parse(
    execFileSync(process.execPath, [BIN, 'get', '1', '--json'], { cwd: root, env, encoding: 'utf8', input: '' }),
  )
  assert.equal(d.title, 'Done, take a look')
  assert.equal(d.author, 'piped-lane · verifying')
  assert.ok(!d.body.includes('# Done, take a look'), 'the title line moves into front matter, not the body')
})

test('a lane inside a git worktree files into the main tree, not its own copy', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const main = join(root, 'main')
  const wt = join(root, 'wt-lane')
  const git = (args: string[], cwd: string) =>
    execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' })

  mkdirSync(main, { recursive: true })
  git(['init', '-q', '-b', 'main'], main)
  git(['config', 'user.email', 't@t'], main)
  git(['config', 'user.name', 't'], main)
  const mainLayout = initLayout(main)
  // git doesn't track empty dirs, so commit a real entry first
  new Store([mainLayout]).create({ title: 'an entry already in the main tree', author: 'lead · setting up the repo' })
  git(['add', '-A', '-f'], main)
  git(['commit', '-qm', 'init'], main)
  git(['worktree', 'add', '-q', '-b', 'lane', wt], main)

  // decisions/ is tracked, so the worktree has its own checked-out copy a lane writing there would miss
  assert.ok(existsSync(join(wt, 'decisions', 'active')), 'the decoy copy must actually exist')

  const found = findLayout(wt)
  // findLayout resolves through realpathSync.native (paths.ts's canonical()) — on
  // Windows that can disagree with the plain realpathSync used here, so the
  // assertion compares against the same resolver the code under test uses.
  assert.equal(found?.projectRoot, realpathSync.native(main), 'a worktree must resolve to the main tree')

  const store = new Store([found!])
  const d = store.create({ title: 'filed from inside the worktree', author: 'lane · working in the worktree' })
  assert.ok(d.file.startsWith(realpathSync.native(main)), `wrote to ${d.file}`)
  assert.equal(readdirSync(join(main, 'decisions', 'active')).length, 2)
  assert.equal(readdirSync(join(wt, 'decisions', 'active')).length, 1, "the worktree's stale copy is untouched")
  assert.equal(d.id, 2, 'numbering comes from the main tree too')
})

test("the owner's follow-up pulls an archived entry back into play", (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])

  const d = store.create({ title: 'done, take a look', author: 'lane · x' })
  const done = store.archive(store.deliver(store.answer(d, { choice: '1' })))
  assert.ok(done.archived)

  const asked = store.append(done, '追问（owner · 2026-09-10 02:00）', "didn't see that prompt at step 3", 'owner')
  assert.ok(!asked.archived, 'it is owed a response again, so it belongs in active/')
  assert.ok(asked.queued, 'and the lane has to hear about it')
  assert.deepEqual(store.queue().map((x) => x.id), [d.id])
})

test("a lane's own execution record leaves the archive alone", (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])

  const d = store.create({ title: 't', author: 'lane · x' })
  const done = store.archive(store.deliver(store.answer(d, { choice: '1' })))
  const recorded = store.append(done, '执行记录（lane · 2026-09-10 02:00）', 'done as asked', 'lane')

  assert.ok(recorded.archived, 'recording what you did is not a request')
  assert.ok(!recorded.queued)
  assert.deepEqual(store.queue(), [])
})

// ---------------------------------------------------------------------------
// §6 attachments: groups, captions, --replace history, --approval-content.
// ---------------------------------------------------------------------------

test('renderAttachmentsBlock -> parseAttachments round-trips group and caption', () => {
  const items = [
    { label: 'a.png', target: '../attachments/D1/a.png', image: true, group: 'Option 1', caption: 'before' },
    { label: 'b.png', target: '../attachments/D1/b.png', image: true, group: 'Option 2', caption: 'after' },
    { label: 'c.html', target: '../attachments/D1/c.html', image: false },
  ]
  const block = renderAttachmentsBlock(items)
  assert.match(block, /\*\*Option 1\*\*/)
  assert.match(block, /\*before\*/)
  const body = `**What it is.** x.\n\n${block}`
  assert.deepEqual(parseAttachments(body), items)
})

test('parseAttachments stays backward compatible with a plain, ungrouped block (D304 shape)', () => {
  // the shape decs attach wrote before this feature, plus a numbered-duplicate collision (review-2.html)
  const body = [
    '## 附件',
    '',
    '- ![review_top.png](../attachments/D304/review_top.png)',
    '- [review.html](../attachments/D304/review.html)',
    '- [review-2.html](../attachments/D304/review-2.html)',
    '',
  ].join('\n')
  const atts = parseAttachments(body)
  assert.deepEqual(
    atts.map((a) => [a.label, a.target, a.image, a.group, a.caption]),
    [
      ['review_top.png', '../attachments/D304/review_top.png', true, undefined, undefined],
      ['review.html', '../attachments/D304/review.html', false, undefined, undefined],
      ['review-2.html', '../attachments/D304/review-2.html', false, undefined, undefined],
    ],
  )
})

test('an attachment link written with Windows backslashes still resolves (legacy content, or an old build)', () => {
  const body = ['## 附件', '', '- [review.html](..\\attachments\\D304\\review.html)', ''].join('\n')
  const atts = parseAttachments(body)
  assert.equal(atts[0].target, '../attachments/D304/review.html', 'backslashes become forward slashes on read')
})

test('a URL attachment target is never mistaken for a Windows path', () => {
  const body = ['## 附件', '', '- [issue](https://example.com/issues\\123)', ''].join('\n')
  assert.equal(parseAttachments(body)[0].target, 'https://example.com/issues\\123')
})

test('toPosixPath: a Windows-separated relative path becomes forward-slash, so a link stays readable on any OS', async () => {
  const { toPosixPath } = await import('../src/core/paths.ts')
  assert.equal(toPosixPath('attachments\\12\\screenshot.png', '\\'), 'attachments/12/screenshot.png')
  assert.equal(toPosixPath('attachments/12/screenshot.png', '/'), 'attachments/12/screenshot.png')
})

test('openerFor: start is not spawnable directly on Windows, so it goes through cmd.exe', () => {
  const win = openerFor('C:\\Users\\eve\\decisions\\x\\shot.png', 'win32')
  assert.equal(win.command, 'cmd.exe')
  // The empty "" is required: start's first quoted argument is a window
  // title, and a path with spaces would otherwise be misread as one.
  assert.deepEqual(win.args, ['/c', 'start', '""', 'C:\\Users\\eve\\decisions\\x\\shot.png'])
  assert.equal(win.options?.windowsVerbatimArguments, true)

  assert.deepEqual(openerFor('/x/shot.png', 'darwin'), { command: 'open', args: ['/x/shot.png'] })
  assert.deepEqual(openerFor('/x/shot.png', 'linux'), { command: 'xdg-open', args: ['/x/shot.png'] })
})

test('isScratchPath recognises a Windows temp subfolder, not just a POSIX one', async () => {
  const { win32 } = await import('node:path')
  const winTmp = 'C:\\Users\\eve\\AppData\\Local\\Temp'
  const ops = { resolve: win32.resolve, sep: win32.sep }
  assert.ok(isScratchPath(`${winTmp}\\decs-abc123`, winTmp, ops), 'a subfolder of the Windows temp dir')
  assert.ok(isScratchPath(winTmp, winTmp, ops), 'the temp dir itself')
  assert.ok(!isScratchPath('C:\\Users\\eve\\code\\web', winTmp, ops), 'an ordinary project folder')
})

test('store.attach: without --replace, a same-named file becomes name-2.ext (unchanged behaviour)', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  const d = store.create({ title: 't', author: 'a' })

  const src = join(root, 'review.html')
  writeFileSync(src, '<p>v1</p>')
  const once = store.attach(d, [src])
  writeFileSync(src, '<p>v2 — different file, same name</p>')
  const twice = store.attach(once, [src])

  assert.deepEqual(
    twice.attachments.map((a) => a.label),
    ['review.html', 'review-2.html'],
  )
  assert.equal(store.historyCount(twice, twice.attachments[0]), 0, 'no --replace means no history to keep')
})

test('store.attach --replace overwrites in place and keeps the old version in .history/', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  const d = store.create({ title: 't', author: 'a' })

  const src = join(root, 'review.html')
  writeFileSync(src, '<p>v1</p>')
  const v1 = store.attach(d, [src])
  assert.equal(v1.attachments.length, 1)
  const target = v1.attachments[0].target

  writeFileSync(src, '<p>v2</p>')
  const v2 = store.attach(v1, [src], { replace: true })

  assert.equal(v2.attachments.length, 1, 'still one attachment — the link never grows a -2 copy')
  assert.equal(v2.attachments[0].target, target, 'the body link keeps pointing at the same path')
  assert.equal(readFileSync(join(dirname(v2.file), target), 'utf8'), '<p>v2</p>', 'the latest content is what the link now resolves to')
  assert.equal(store.historyCount(v2, v2.attachments[0]), 1)

  writeFileSync(src, '<p>v3</p>')
  const v3 = store.attach(v2, [src], { replace: true })
  assert.equal(store.historyCount(v3, v3.attachments[0]), 2, 'a second --replace keeps both earlier versions')
})

test('store.attach --replace keeps a previous caption/group when the replace call does not repeat them', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  const d = store.create({ title: 't', author: 'a' })

  const src = join(root, 'a.png')
  writeFileSync(src, 'v1')
  const once = store.attach(d, [src], { groups: ['Option 1'], captions: ['what it looked like before'] })
  assert.equal(once.attachments[0].caption, 'what it looked like before')

  writeFileSync(src, 'v2')
  const replaced = store.attach(once, [src], { replace: true })
  assert.equal(replaced.attachments[0].group, 'Option 1', 'group survives a replace that does not repeat --label')
  assert.equal(replaced.attachments[0].caption, 'what it looked like before', 'caption survives too')
})

test('store.attach --label/--caption line up with sources by position', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  const d = store.create({ title: 't', author: 'a' })

  const a = join(root, 'a.png')
  const b = join(root, 'b.png')
  writeFileSync(a, 'a')
  writeFileSync(b, 'b')

  const next = store.attach(d, [a, b], { groups: ['Option 1', 'Option 2'], captions: ['before', 'after'] })
  assert.deepEqual(
    next.attachments.map((x) => [x.label, x.group, x.caption]),
    [
      ['a.png', 'Option 1', 'before'],
      ['b.png', 'Option 2', 'after'],
    ],
  )
})

test('store.attach --approval-content records a hash, which decs-approved-style matching finds by filename', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  const d = store.create({ title: 't', author: 'a' })

  const src = join(root, 'draft.html')
  writeFileSync(src, '<p>a reply to send to the customer</p>')
  const attached = store.attach(d, [src], { approvalContent: true })

  const approval = store.findApproval(attached, 'draft.html')
  assert.ok(approval, 'an approval record exists, keyed by filename')
  assert.equal(approval!.hash, sha256File(src))
  assert.equal(approval!.approvedHash, undefined, 'attaching is not approving')
})

test('answering the decision approves whatever --approval-content attachments it is gating', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  const d = store.create({ title: 't', author: 'a', options: [{ key: '1', label: 'send' }] })

  const src = join(root, 'draft.html')
  writeFileSync(src, '<p>v1</p>')
  const attached = store.attach(d, [src], { approvalContent: true })
  const hashV1 = sha256File(src)

  const answered = store.answer(attached, { choice: '1' })
  const approvalAfterAnswer = store.findApproval(answered, 'draft.html')
  assert.equal(approvalAfterAnswer!.approvedHash, hashV1, 'the current hash became the approved one')
  assert.equal(approvalAfterAnswer!.approvedBy, 'owner')

  // after --replace, hash moves but approvedHash stays — that's the mismatch `decs approved --check` reports
  writeFileSync(src, '<p>v2 — changed after approval</p>')
  const replaced = store.attach(answered, [src], { replace: true, approvalContent: true })
  const approvalAfterReplace = store.findApproval(replaced, 'draft.html')
  assert.equal(approvalAfterReplace!.approvedHash, hashV1, 'still the v1 hash — not auto-approved')
  assert.equal(approvalAfterReplace!.hash, sha256File(src), 'but the content hash moved to v2')
  assert.notEqual(approvalAfterReplace!.hash, approvalAfterReplace!.approvedHash, 'so the mismatch is visible')

  // Answering again (e.g. the owner re-approves the new draft) catches it up.
  const reanswered = store.answer(replaced, { choice: '1' })
  const approvalAfterReanswer = store.findApproval(reanswered, 'draft.html')
  assert.equal(approvalAfterReanswer!.approvedHash, approvalAfterReanswer!.hash)
})

test('store.attach refuses --approval-content on a URL — there is nothing local to hash', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  const d = store.create({ title: 't', author: 'a' })
  assert.throws(() => store.attach(d, ['https://example.com/draft.html'], { approvalContent: true }), /not a URL/)
})

test('store.historyCount is 0 for a --link attachment — nothing local to version', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  const d = store.create({ title: 't', author: 'a' })
  const src = join(root, 'x.png')
  writeFileSync(src, 'x')
  const linked = store.attach(d, [src], { link: true })
  assert.equal(store.historyCount(linked, linked.attachments[0]), 0)
})

test('CLI: decs attach --replace, then --approval-content + decs approved --check', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  // The owner's own terminal: no CLAUDECODE, so `decs push` is a human answer.
  const { CLAUDECODE: _c, DECS_ROLE: _r, ...ownerEnv } = process.env
  const env = { ...ownerEnv, DECS_AUTHOR: 'cli-test · lane' }
  execFileSync(process.execPath, [BIN, 'init', '--no-register'], { cwd: root, env, input: '' })
  execFileSync(process.execPath, [BIN, 'add', 't', '-o', '1=send'], { cwd: root, env, input: '' })

  const draft = join(root, 'draft.html')
  writeFileSync(draft, '<p>v1</p>')
  execFileSync(process.execPath, [BIN, 'attach', '1', draft, '--approval-content'], { cwd: root, env, input: '' })

  // Never approved yet: --check must fail (non-zero), not pass silently.
  assert.throws(() => execFileSync(process.execPath, [BIN, 'approved', '1', '--check', draft], { cwd: root, env, input: '' }))

  execFileSync(process.execPath, [BIN, 'push', '1', '1'], { cwd: root, env, input: '' })
  execFileSync(process.execPath, [BIN, 'approved', '1', '--check', draft], { cwd: root, env, input: '' })

  // Replace with different content: approval is now stale.
  writeFileSync(draft, '<p>v2</p>')
  execFileSync(process.execPath, [BIN, 'attach', '1', draft, '--replace', '--approval-content'], { cwd: root, env, input: '' })
  assert.throws(() => execFileSync(process.execPath, [BIN, 'approved', '1', '--check', draft], { cwd: root, env, input: '' }))

  const out = execFileSync(process.execPath, [BIN, 'get', '1', '--no-images'], { cwd: root, env, encoding: 'utf8', input: '' })
  assert.match(out, /version 1/)
  assert.match(out, /content changed, needs re-approval/)
})

test('CLI: decs note --attach and decs attach --to put files in the right section, not one global block', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const env = { ...process.env, DECS_AUTHOR: 'cli-test · lane' }
  execFileSync(process.execPath, [BIN, 'init', '--no-register'], { cwd: root, env, input: '' })
  execFileSync(process.execPath, [BIN, 'add', 't', '--task'], { cwd: root, env, input: '' })

  const before = join(root, 'before.png')
  writeFileSync(before, 'A')
  execFileSync(process.execPath, [BIN, 'attach', '1', before, '--to', 'body'], { cwd: root, env, input: '' })

  execFileSync(process.execPath, [BIN, 'note', '1', 'first note', '--agent'], { cwd: root, env, input: '' })

  const after = join(root, 'after.png')
  writeFileSync(after, 'B')
  execFileSync(process.execPath, [BIN, 'attach', '1', after, '--to', 'last'], { cwd: root, env, input: '' })

  const withNote = join(root, 'withnote.png')
  writeFileSync(withNote, 'C')
  execFileSync(process.execPath, [BIN, 'note', '1', 'second note', '--agent', '--attach', withNote], { cwd: root, env, input: '' })

  const json = JSON.parse(execFileSync(process.execPath, [BIN, 'get', '1', '--json'], { cwd: root, env, encoding: 'utf8', input: '' }))
  assert.deepEqual(json.body_attachments.map((a: { label: string }) => a.label), ['before.png'])
  assert.deepEqual(json.notes[0].attachments.map((a: { label: string }) => a.label), ['after.png'])
  assert.deepEqual(json.notes[1].attachments.map((a: { label: string }) => a.label), ['withnote.png'])
  assert.deepEqual(json.attachments.map((a: { label: string }) => a.label), ['before.png', 'after.png', 'withnote.png'])

  // The raw file reads as plain markdown with each attachment right under the section it belongs to.
  const raw = readFileSync(join(root, 'decisions', 'active', '1-t.md'), 'utf8')
  const beforeAt = raw.indexOf('before.png')
  const firstNoteAt = raw.indexOf('first note')
  const afterAt = raw.indexOf('after.png')
  const secondNoteAt = raw.indexOf('second note')
  const withNoteAt = raw.indexOf('withnote.png')
  assert.ok(beforeAt < firstNoteAt && firstNoteAt < afterAt && afterAt < secondNoteAt && secondNoteAt < withNoteAt, raw)
})

test('decs check warns about an approval record whose attachment is gone, but not a healthy one', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  const d = store.create({ title: 't', author: 'a' })
  const src = join(root, 'draft.html')
  writeFileSync(src, 'v1')
  const attached = store.attach(d, [src], { approvalContent: true })
  assert.equal(attached.approvals.length, 1)

  // A healthy approval (attachment still present) must not be flagged.
  // decs check's own message for this is English in the source.
  const env = { ...process.env, DECS_AUTHOR: 'cli-test · lane', DECS_LANG: 'en' }
  const healthy = JSON.parse(execFileSync(process.execPath, [BIN, 'check', '--json'], { cwd: root, env, encoding: 'utf8', input: '' }))
  assert.ok(!healthy.some((p: { message: string }) => /approval record/.test(p.message)))

  // hand-remove the `## 附件` section, leaving the front-matter approval record dangling
  const text = readFileSync(attached.file, 'utf8').replace(/## 附件[\s\S]*$/, '')
  writeFileSync(attached.file, text)

  let out: string
  try {
    out = execFileSync(process.execPath, [BIN, 'check', '--json'], { cwd: root, env, encoding: 'utf8', input: '' })
  } catch (e) {
    out = (e as { stdout: string }).stdout
  }
  const problems = JSON.parse(out)
  assert.ok(problems.some((p: { message: string }) => /approval record/.test(p.message)))
})

test('integration: new attachments go to attachments/<id>/, and approvals are a parsed field, not extra', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  const d = store.create({ title: 't', author: 'a', options: [{ key: '1', label: 'send' }] })
  const src = join(root, 'draft.html')
  writeFileSync(src, '<p>v1</p>')
  const attached = store.attach(d, [src], { approvalContent: true })
  assert.match(attached.attachments[0].target, /attachments\/1\/draft\.html$/)
  assert.equal(attached.extra?.approvals, undefined, 'approvals is not carried as an unknown key')
  assert.equal(attached.approvals.length, 1)
  // Round-trips once, not twice (extra + first-class would write it twice).
  assert.equal((readFileSync(attached.file, 'utf8').match(/^approvals:/gm) ?? []).length, 1)
})

test('integration: only the owner answering approves --approval-content; an agent-recorded answer does not', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  const d = store.create({ title: 't', author: 'a', options: [{ key: '1', label: 'send' }] })
  const src = join(root, 'draft.html')
  writeFileSync(src, '<p>v1</p>')
  const attached = store.attach(d, [src], { approvalContent: true })
  const byAgent = store.answer(attached, { choice: '1', by: 'lead' })
  assert.equal(store.findApproval(byAgent, 'draft.html')!.approvedHash, undefined)
  const byOwner = store.answer(byAgent, { choice: '1' })
  assert.equal(store.findApproval(byOwner, 'draft.html')!.approvedHash, sha256File(src))
})

test('integration: attach works from a stale copy without dropping a note written meanwhile', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  const stale = store.create({ title: 't', author: 'a' })
  store.note(stale, { text: 'something another lane found', role: 'agent', author: 'other' })
  const src = join(root, 'a.png')
  writeFileSync(src, 'png')
  const after = store.attach(stale, [src])
  assert.match(after.body, /something another lane found/, 'attach re-read the node under its lock')
  assert.equal(after.attachments.length, 1)
})

// --- attach lands in the section it belongs to, not one global block --------

test('store.attach with no --to lands on the attaching author\'s own latest note, not the body', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  let d = store.create({ title: 't', author: 'a' })
  d = store.note(d, { text: 'first', role: 'agent', author: 'lane-a · x' })
  d = store.note(d, { text: 'second', role: 'agent', author: 'lane-b · y' })
  const src = join(root, 'shot.png')
  writeFileSync(src, 'p')
  const next = store.attach(d, [src], { by: 'lane-a · x' })
  assert.deepEqual(next.notes[0].attachments.map((a) => a.label), ['shot.png'], 'lane-a\'s own note, not the newest one')
  assert.deepEqual(next.notes[1].attachments, [])
  assert.deepEqual(next.bodyAttachments, [])
  assert.equal(next.attachments.length, 1)
})

test('store.attach with no --to and no matching author falls back to the body', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  let d = store.create({ title: 't', author: 'a' })
  d = store.note(d, { text: 'a note', role: 'agent', author: 'lane-a · x' })
  const src = join(root, 'shot.png')
  writeFileSync(src, 'p')
  const next = store.attach(d, [src], { by: 'someone-else · z' })
  assert.deepEqual(next.bodyAttachments.map((a) => a.label), ['shot.png'])
  assert.deepEqual(next.notes[0].attachments, [])
})

test('store.attach --to last always lands on the newest note, whoever wrote it', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  let d = store.create({ title: 't', author: 'a' })
  d = store.note(d, { text: 'first', role: 'agent', author: 'lane-a · x' })
  d = store.note(d, { text: 'second', role: 'agent', author: 'lane-b · y' })
  const src = join(root, 'shot.png')
  writeFileSync(src, 'p')
  const next = store.attach(d, [src], { to: 'last', by: 'lane-a · x' })
  assert.deepEqual(next.notes[1].attachments.map((a) => a.label), ['shot.png'])
  assert.deepEqual(next.notes[0].attachments, [])
})

test('store.attach --to body always lands on the body, even with notes present', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  let d = store.create({ title: 't', author: 'a' })
  d = store.note(d, { text: 'a note', role: 'agent', author: 'lane-a · x' })
  const src = join(root, 'shot.png')
  writeFileSync(src, 'p')
  const next = store.attach(d, [src], { to: 'body', by: 'lane-a · x' })
  assert.deepEqual(next.bodyAttachments.map((a) => a.label), ['shot.png'])
  assert.deepEqual(next.notes[0].attachments, [])
})

test('store.attach --to <n> picks the nth note (1-based); out of range throws', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  let d = store.create({ title: 't', author: 'a' })
  d = store.note(d, { text: 'first', role: 'agent', author: 'x' })
  d = store.note(d, { text: 'second', role: 'agent', author: 'x' })
  const src = join(root, 'shot.png')
  writeFileSync(src, 'p')
  const next = store.attach(d, [src], { to: '1' })
  assert.deepEqual(next.notes[0].attachments.map((a) => a.label), ['shot.png'])
  assert.deepEqual(next.notes[1].attachments, [])
  inEnglish(() => assert.throws(() => store.attach(d, [src], { to: '9' }), /out of range/))
})

test('store.attach --to <text> matches a note by its heading or timestamp', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  let d = store.create({ title: 't', author: 'a' })
  d = store.note(d, { text: 'first', role: 'human', author: 'owner' })
  d = store.note(d, { text: 'second', role: 'agent', author: 'lane-x · y' })
  const src = join(root, 'shot.png')
  writeFileSync(src, 'p')
  const next = store.attach(d, [src], { to: '回复' })
  assert.deepEqual(next.notes[0].attachments.map((a) => a.label), ['shot.png'], 'the human reply, matched on its heading word')
  inEnglish(() => assert.throws(() => store.attach(d, [src], { to: 'no such text anywhere' }), /no note matches/))
})

test('store.attach: two attachments to different sections keep their own ## 附件 block and don\'t mix', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  let d = store.create({ title: 't', author: 'a' })
  const a = join(root, 'a.png')
  writeFileSync(a, 'A')
  d = store.attach(d, [a], { to: 'body' })
  d = store.note(d, { text: 'a note', role: 'agent', author: 'x' })
  const b = join(root, 'b.png')
  writeFileSync(b, 'B')
  d = store.attach(d, [b], { to: 'last' })

  assert.deepEqual(d.bodyAttachments.map((x) => x.label), ['a.png'])
  assert.deepEqual(d.notes[0].attachments.map((x) => x.label), ['b.png'])
  assert.deepEqual(d.attachments.map((x) => x.label), ['a.png', 'b.png'])

  // Round-trips through a fresh parse of the file, not just the in-memory result.
  const reread = new Store([initLayout(root)]).get(d.id)!
  assert.deepEqual(reread.bodyAttachments.map((x) => x.label), ['a.png'])
  assert.deepEqual(reread.notes[0].attachments.map((x) => x.label), ['b.png'])
})

test('store.note with attach writes the note and its files into the same new section', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  let d = store.create({ title: 't', author: 'a' })
  const a = join(root, 'shot.png')
  writeFileSync(a, 'A')
  d = store.note(d, { text: 'see this', role: 'human', author: 'owner', attach: { sources: [a] } })

  assert.equal(d.notes.length, 1)
  assert.equal(d.notes[0].text, 'see this')
  assert.deepEqual(d.notes[0].attachments.map((x) => x.label), ['shot.png'])
  assert.deepEqual(d.bodyAttachments, [])
  assert.equal(d.queued, true, 'still a normal human reply — queues the node')

  const reread = new Store([initLayout(root)]).get(d.id)!
  assert.deepEqual(reread.notes[0].attachments.map((x) => x.label), ['shot.png'])
})

test('store.note with attach: --label/--caption and --approval-content still work exactly as decs attach', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  let d = store.create({ title: 't', author: 'a', options: [{ key: '1', label: 'send' }] })
  const a = join(root, 'draft.html')
  writeFileSync(a, '<p>v1</p>')
  d = store.note(d, {
    text: 'ready to send',
    role: 'agent',
    author: 'lane · x',
    attach: { sources: [a], groups: ['Option 1'], captions: ['the draft'], approvalContent: true, approveOn: ['1'] },
  })
  assert.equal(d.notes[0].attachments[0].group, 'Option 1')
  assert.equal(d.notes[0].attachments[0].caption, 'the draft')
  assert.ok(store.findApproval(d, a))
})

test('bench opens every registered folder from anywhere; `.` narrows to the current one', () => {
  const home = mkdtempSync(join(tmpdir(), 'decs-home-'))
  const a = mkdtempSync(join(tmpdir(), 'decs-a-'))
  const b = mkdtempSync(join(tmpdir(), 'decs-b-'))
  const elsewhere = mkdtempSync(join(tmpdir(), 'decs-nowhere-'))
  try {
    const env = { ...process.env, DECS_HOME: home, DECS_AUTHOR: 't · x' }
    for (const p of [a, b]) execFileSync(process.execPath, [BIN, 'init', '--no-register'], { cwd: p, env, input: '' })
    for (const p of [a, b]) execFileSync(process.execPath, [BIN, 'projects', 'add', p], { env })
    const reg = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as { projects: { root: string }[] }
    assert.equal(reg.projects.length, 2, 'the registry lives in $DECS_HOME/config.json')

    // Exercised through resolveStore in a child process so DECS_HOME is read fresh.
    // A Windows path (`D:\...`) isn't a valid ESM import specifier — only a
    // relative path or a URL is, so these go through file:// URLs instead.
    const probe = (cwd: string, argv: string[]) =>
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { resolveStore } from ${JSON.stringify(pathToFileURL(join(ROOT, 'src/cli/context.ts')).href)};
           import { parseArgs } from ${JSON.stringify(pathToFileURL(join(ROOT, 'src/cli/args.ts')).href)};
           const s = resolveStore(parseArgs(${JSON.stringify(argv)}), { allowRegistry: true, preferRegistry: true, positionalDirs: true });
           console.log(s.layouts.length)`,
        ],
        { cwd, env, encoding: 'utf8' },
      ).trim()
    assert.equal(probe(elsewhere, []), '2', 'no args: all registered folders, wherever the shell is')
    assert.equal(probe(a, []), '2', 'even from inside one project')
    assert.equal(probe(a, ['.']), '1', '`.` is just this project')
  } finally {
    for (const p of [home, a, b, elsewhere]) rmSync(p, { recursive: true, force: true })
  }
})

test('decs init does not register a scratch directory', () => {
  assert.ok(isScratchPath(join(tmpdir(), 'whatever')))
  assert.ok(isScratchPath('/private/tmp/agent-scratch/x/decsqfvf'))
  assert.ok(!isScratchPath('/home/me/code/web'))
})

// ---------------------------------------------------------------------------
// --approve-on: approval is tied to the answer, not to "answered at all".
// ---------------------------------------------------------------------------

function approvalNode(t: { after: (fn: () => void) => void }, options: { key: string; label: string }[]) {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  const d = store.create({ title: 't', author: 'a', options })
  const src = join(root, 'draft.html')
  writeFileSync(src, '<p>v1</p>')
  return { root, store, d, src }
}

test('--approve-on: a single-option (acceptance) node defaults to that option', (t) => {
  const { store, d, src } = approvalNode(t, [{ key: '1', label: '验收通过' }])
  const a = store.attach(d, [src], { approvalContent: true })
  assert.deepEqual(a.approvals[0].approveOn, ['1'])
  assert.equal(store.findApproval(store.answer(a, { choice: '1' }), 'draft.html')!.approvedHash, sha256File(src))
})

test('--approve-on: a multi-option node without it is refused, and nothing is copied', (t) => {
  const { root, store, d, src } = approvalNode(t, [{ key: '1', label: 'send' }, { key: '2', label: 'hold off for now' }])
  assert.throws(() => store.attach(d, [src], { approvalContent: true }), /which answer counts as approval\? Add --approve-on/)
  assert.equal(store.get(d.id)!.attachments.length, 0)
  assert.ok(!existsSync(join(root, 'decisions', 'attachments', String(d.id), 'draft.html')), 'refused before copying')
  assert.throws(() => store.attach(d, [src], { approvalContent: true, approveOn: ['9'] }), /has no option "9"/)
})

test('--approve-on: only the listed choice approves; another choice declines and withdraws an earlier approval', (t) => {
  const { store, d, src } = approvalNode(t, [
    { key: '1', label: 'send' },
    { key: '2', label: 'hold off for now' },
    { key: '3', label: 'fix it, then send' },
  ])
  const a = store.attach(d, [src], { approvalContent: true, approveOn: ['1', '3'] })
  const no = store.findApproval(store.answer(a, { choice: '2' }), 'draft.html')!
  assert.equal(no.approvedHash, undefined)
  assert.equal(no.declined, '2')
  const yes = store.answer(store.get(d.id)!, { choice: '3' })
  assert.equal(store.findApproval(yes, 'draft.html')!.approvedHash, sha256File(src), '3 is on the list too')
  assert.equal(store.findApproval(yes, 'draft.html')!.declined, undefined)
  const back = store.answer(yes, { choice: '2' })
  assert.equal(store.findApproval(back, 'draft.html')!.approvedHash, undefined, 'the latest answer is the one that counts')
  // A --replace without --approve-on keeps the keys it was attached with.
  writeFileSync(src, '<p>v2</p>')
  assert.deepEqual(store.attach(back, [src], { replace: true, approvalContent: true }).approvals[0].approveOn, ['1', '3'])
})

test('--approve-on Q2:1 approves on a sub-question answer', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  const d = store.create({
    title: 't',
    author: 'a',
    questions: [
      { key: 'Q1', label: 'table header', body: '', default: 'A', options: [{ key: 'A', label: 'keep the original', body: '' }, { key: 'B', label: 'change it', body: '' }] },
      { key: 'Q2', label: 'send or not', body: '', default: '2', options: [{ key: '1', label: 'send', body: '' }, { key: '2', label: "don't send", body: '' }] },
    ],
  })
  const src = join(root, 'draft.html')
  writeFileSync(src, 'x')
  assert.throws(() => store.attach(d, [src], { approvalContent: true }), /--approve-on Q1:A/)
  assert.throws(() => store.attach(d, [src], { approvalContent: true, approveOn: ['Q2:9'] }), /Q2 has no option "9"/)
  const a = store.attach(d, [src], { approvalContent: true, approveOn: ['Q2:1'] })
  const no = store.answer(a, { answers: { Q1: 'B', Q2: '2' } })
  assert.equal(store.findApproval(no, 'draft.html')!.declined, 'Q1=B Q2=2')
  const yes = store.answer(no, { answers: { Q1: 'B', Q2: '1' } })
  assert.equal(store.findApproval(yes, 'draft.html')!.approvedHash, sha256File(src))
})

test('CLI: decs approved --check says the answer was not the approving one; decs push from an agent shell approves nothing', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 't', '-o', '1=send', '2=hold off for now'])
  const draft = join(root, 'draft.html')
  writeFileSync(draft, '<p>v1</p>')
  assert.equal(decsResult(root, ['attach', '1', draft, '--approval-content']).code, 1, 'two options, no --approve-on')
  decs(root, ['attach', '1', draft, '--approval-content', '--approve-on', '1'])

  // Agent shell (the helper's default): the answer is recorded and queued, but approves nothing.
  decs(root, ['push', '1', '1'])
  const relayed = JSON.parse(decs(root, ['get', '1', '--json']))
  assert.equal(relayed.status, 'decided')
  assert.equal(relayed.approvals[0].approved_hash, null)
  assert.deepEqual(relayed.approvals[0].approve_on, ['1'])
  assert.ok(relayed.queued, 'queued regardless of role')
  const relayedCheck = decsResult(root, ['approved', '1', '--check', draft])
  assert.equal(relayedCheck.code, 2)
  assert.match(relayedCheck.stderr, /an agent's recorded answer doesn't count/)
  assert.match(relayed.body, /## 已答（agent · cli-test · lane/)

  // The owner's own terminal answers 2: recorded as human, and refused with the reason.
  decs(root, ['push', '1', '2'], { CLAUDECODE: undefined })
  const r = decsResult(root, ['approved', '1', '--check', draft, '--json'])
  assert.equal(r.code, 2)
  assert.equal(JSON.parse(r.stdout).reason, 'answer-not-approving')
  assert.match(decsResult(root, ['approved', '1', '--check', draft]).stderr, /the answer was 2, which doesn't approve it/)

  // --human overrides the shell default.
  decs(root, ['push', '1', '1', '--human'])
  assert.equal(decsResult(root, ['approved', '1', '--check', draft]).code, 0)
})

test('store.all() reparses only changed files and hands back the same array when nothing changed', () => {
  const root = mkdtempSync(join(tmpdir(), 'decs-cache-'))
  try {
    const store = new Store([initLayout(root)])
    const a = store.create({ title: 'a', author: 'x · y' })
    store.create({ title: 'b', author: 'x · y' })
    const first = store.all()
    assert.equal(store.all(), first, 'nothing changed: same array, so the bench can skip repainting')
    store.note(a, { text: 'n', role: 'agent', author: 'x' })
    const second = store.all()
    assert.notEqual(second, first)
    assert.equal(second.find((d) => d.id === a.id)!.notes.length, 1, 'the changed file is re-read')
    assert.equal(second.length, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
