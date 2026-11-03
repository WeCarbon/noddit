import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

import { LANGUAGES, setLang, t, type Lang } from '../src/i18n/index.ts'
import { padLeftToWidth } from '../src/core/render.ts'
import { BIDI_CONTROLS } from '../src/i18n/bidi.ts'
import { BIN, decs, decsResult, killAndWait, scratch } from './helpers.ts'

// ---------------------------------------------------------------------------
// decs --help / decs add --help in every language
// ---------------------------------------------------------------------------

/** One phrase from each language's own translation, to prove it actually rendered (not a fallback). */
const USAGE_PHRASE: Record<Lang, string> = {
  en: 'tasks and decisions as plain markdown files',
  'zh-Hans': '任务和决策，存成普通的 markdown 文件',
  'zh-Hant': '任務和決策，存成一般的 markdown 檔案',
  fr: 'nœuds en fichiers markdown',
  ar: 'عُقد (nodes)',
}

const ADD_HELP_PHRASE: Record<Lang, string> = {
  en: 'create a new node',
  'zh-Hans': '新建一个节点',
  'zh-Hant': '新建一個節點',
  fr: 'crée un nouveau nœud',
  ar: 'ينشئ عقدة جديدة',
}

for (const lng of LANGUAGES) {
  test(`decs --help renders in ${lng}, no leftover {{ or key paths`, (t) => {
    const root = scratch()
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const out = decs(root, ['--lang', lng, '--help'])
    assert.ok(out.includes(USAGE_PHRASE[lng]), out)
    assert.doesNotMatch(out, /\{\{/)
    assert.doesNotMatch(out, /cli\.help\./)
  })

  test(`decs add --help renders in ${lng}, no leftover {{ or key paths`, (t) => {
    const root = scratch()
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const out = decs(root, ['--lang', lng, 'add', '--help'])
    assert.ok(out.includes(ADD_HELP_PHRASE[lng]), out)
    assert.doesNotMatch(out, /\{\{/)
    assert.doesNotMatch(out, /cli\.help\./)
  })
}

// ---------------------------------------------------------------------------
// decs monitor: machine prefixes stay byte-identical in every language
// ---------------------------------------------------------------------------

function spawnMonitor(root: string, args: string[], env: Record<string, string>): { child: ReturnType<typeof spawn>; out: () => string } {
  const child = spawn(process.execPath, [BIN, 'monitor', ...args], {
    cwd: root,
    env: { ...process.env, NO_COLOR: '1', CLAUDECODE: '1', ...env },
  })
  let out = ''
  child.stdout.on('data', (b) => (out += b))
  return { child, out: () => out }
}

for (const lng of LANGUAGES) {
  test(`decs monitor: DECS-UNCLAIMED stays byte-identical under --lang ${lng}`, async (t) => {
    const root = scratch()
    decs(root, ['init', '--no-register'])
    // Filed under a different author so the startup "already queued" dump
    // (filtered by --mine) skips it, and only the unfiltered safety net reports it.
    decs(root, ['add', 'check inbox', '--author', 'mail-deliv · delivery check', '-o', '1=check', '2=skip'])
    decs(root, ['push', '1', '1'], { CLAUDECODE: undefined })

    const { child, out } = spawnMonitor(root, ['--lang', lng, '--mine', '--unclaimed-after', '0s', '--interval', '200'], {
      DECS_AUTHOR: 'lead · collecting',
    })
    // Before the rmSync below: Windows won't remove a directory that's still
    // a live process's cwd.
    t.after(() => killAndWait(child))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const unclaimed = () => out().trim().split('\n').filter((l) => l.startsWith('DECS-UNCLAIMED'))
    for (let waited = 0; waited < 8000 && !unclaimed().length; waited += 100) await new Promise((r) => setTimeout(r, 100))
    // One more interval, to catch a duplicate if the monitor were to report it twice.
    await new Promise((r) => setTimeout(r, 400))
    const lines = unclaimed()
    assert.equal(lines.length, 1, out())
    assert.match(lines[0], /^DECS-UNCLAIMED X1 /)
  })

  test(`decs monitor: DECS-IDLE stays byte-identical under --lang ${lng}`, async (t) => {
    const root = scratch()
    t.after(() => rmSync(root, { recursive: true, force: true }))
    decs(root, ['init', '--no-register'])

    const { child, out } = spawnMonitor(root, ['--lang', lng, '--idle-exit', '1s', '--interval', '200', '--no-sources'], {
      DECS_HOME: join(root, 'home'),
    })
    const code = await new Promise<number | null>((r) => child.on('exit', r))
    assert.equal(code, 0)
    assert.match(out(), /^DECS-IDLE /m)
  })
}

// ---------------------------------------------------------------------------
// File format: byte-identical whatever --lang says
// ---------------------------------------------------------------------------

/** created/updated/answered/deferred/etc. timestamps vary run to run; blank them out before comparing. */
function normalizeTimestamps(text: string): string {
  return text.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:\d{2})?/g, '<TIME>')
}

/** Runs the same sequence of commands under one language and returns the entry file's (timestamp-normalized) content. */
function fileFormatUnder(lang: string): string {
  const root = scratch()
  try {
    const shot = join(root, 'shot.png')
    writeFileSync(shot, 'not a real png, attach() only checks it exists')
    const run = (args: string[], input = '') => decs(root, ['--lang', lang, ...args], {}, input)

    run(['init', '--no-register'])
    run(['add', 'Deploy or hold', '-o', '1=Ship it', '2=Hold off', '--author', 'lane-x · testing'])
    run(['push', '1', '1', '--note', 'going with option 1'])
    run(['note', '1', 'additional context for the lane', '--agent'])
    run(['attach', '1', shot])
    run(['defer', '1', '--human'])
    run(['hold', '1', '--on', 'someone external', '--until', '2030-01-15', '--author', 'lane-x · testing'])

    const file = readdirSync(join(root, 'decisions', 'active')).find((f) => f.startsWith('1-'))!
    return normalizeTimestamps(readFileSync(join(root, 'decisions', 'active', file), 'utf8'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('the decisions/*.md file format is byte-identical under --lang en, fr and ar', () => {
  const en = fileFormatUnder('en')
  const fr = fileFormatUnder('fr')
  const ar = fileFormatUnder('ar')

  // The canonical Chinese headings are the file format — present whatever the UI language said.
  for (const heading of ['## 选项', '### 1 · ', '## 已答（', '## 附件', '## 延迟（', '## 等待（']) {
    assert.ok(en.includes(heading), `en missing ${heading}`)
    assert.ok(fr.includes(heading), `fr missing ${heading}`)
    assert.ok(ar.includes(heading), `ar missing ${heading}`)
  }
  // The agent note's heading word is 补充 (default for --agent), not 回复 (human's default).
  assert.ok(en.includes('## 补充（') && fr.includes('## 补充（') && ar.includes('## 补充（'))

  assert.equal(fr, en, 'fr output differs from en output once timestamps are normalized')
  assert.equal(ar, en, 'ar output differs from en output once timestamps are normalized')
})

// ---------------------------------------------------------------------------
// Plurals: six Arabic forms, French one vs other
// ---------------------------------------------------------------------------

test('Arabic plurals: zero/one/two/few/many/other render six different forms', () => {
  setLang('ar')
  try {
    const forms = [0, 1, 2, 3, 11, 100].map((count) => t('cli.open.onlyNAttachments', { count, ref: 'X1' }))
    assert.equal(new Set(forms).size, 6, forms.join(' | '))
  } finally {
    setLang('en')
  }
})

test('French plurals: 1 is singular, 2 is not', () => {
  setLang('fr')
  try {
    const one = t('core.render.optionsCount', { count: 1 })
    const two = t('core.render.optionsCount', { count: 2 })
    assert.notEqual(one, two)
    assert.match(one, /^1 option$/)
    assert.match(two, /^2 options$/)
  } finally {
    setLang('en')
  }
})

// ---------------------------------------------------------------------------
// RTL table-like listings: right-aligned on a TTY, untouched when piped
// ---------------------------------------------------------------------------

test('padLeftToWidth is a pure left-pad by display width', () => {
  assert.equal(padLeftToWidth('abc', 5), '  abc')
  assert.equal(padLeftToWidth('abc', 2), 'abc', 'already at/over width: unchanged')
  assert.equal(padLeftToWidth('日本語', 10), '    日本語', 'CJK counts two columns per character')
})

test('piped decs show in Arabic keeps logical order: no reordering, no isolates', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  const title = 'مرحبا W5 اختبار'
  decs(root, ['add', title, '--task'])

  // decsResult/execFileSync never attaches a TTY, so alignment/bidi must both no-op.
  const out = decsResult(root, ['--lang', 'ar', 'show', 'all']).stdout
  assert.ok(out.includes(title), 'the title survives byte-for-byte, unreordered')
  assert.doesNotMatch(out, BIDI_CONTROLS)
})

// ---------------------------------------------------------------------------
// decs show <status>: the bare key, 待决策 and the current language's label all work
// ---------------------------------------------------------------------------

test('decs show accepts a status by its key, by 待决策 regardless of --lang, and by the current language label', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 'pick a CDN', '-o', '1=a', '2=b'])

  const byKey = decs(root, ['--lang', 'en', 'show', 'needs_decision'])
  const byCanonicalChinese = decs(root, ['--lang', 'en', 'show', '待决策'])
  const byOwnLabel = decs(root, ['--lang', 'en', 'show', 'Needs decision'])
  for (const out of [byKey, byCanonicalChinese, byOwnLabel]) assert.match(out, /pick a CDN/)

  const byFrenchLabel = decs(root, ['--lang', 'fr', 'show', 'À décider'])
  assert.match(byFrenchLabel, /pick a CDN/)
})
