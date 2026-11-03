import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LANGUAGES, loadResources, normalizeLang, resolveLang, resolveLangSource, setLang, systemLang, t, takeLangFlag, type Lang } from '../src/i18n/index.ts'
import { decs, decsResult, scratch } from './helpers.ts'

const PLURAL = /_(zero|one|two|few|many|other)$/

function flatten(obj: unknown, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object') flatten(v, key, out)
    else out[key] = String(v)
  }
  return out
}

const placeholders = (s: string) => [...new Set([...s.matchAll(/\{\{\s*([\w.]+)[^}]*\}\}/g)].map((m) => m[1]))].sort()

const en = flatten(loadResources('en'))
const pluralBases = new Set(Object.keys(en).filter((k) => PLURAL.test(k)).map((k) => k.replace(PLURAL, '')))

/** The keys a language must have: every English key, with plurals in that language's own forms. */
function expectedKeys(lng: Lang): string[] {
  const cats = new Intl.PluralRules(lng).resolvedOptions().pluralCategories
  const keys = Object.keys(en).filter((k) => !PLURAL.test(k))
  for (const base of pluralBases) for (const c of cats) keys.push(`${base}_${c}`)
  return keys.sort()
}

for (const lng of LANGUAGES) {
  test(`${lng} has exactly the keys English has, plurals in its own forms`, () => {
    const got = flatten(loadResources(lng))
    const want = expectedKeys(lng)
    assert.deepEqual(Object.keys(got).filter((k) => !want.includes(k)), [], 'extra keys')
    assert.deepEqual(want.filter((k) => !(k in got)), [], 'missing keys')
  })

  test(`${lng} uses the same placeholders as English`, () => {
    const got = flatten(loadResources(lng))
    for (const [key, value] of Object.entries(got)) {
      const base = key.replace(PLURAL, '')
      const ref = pluralBases.has(base) ? en[`${base}_other`] : en[key]
      if (ref === undefined) continue
      const want = placeholders(ref)
      const have = placeholders(value)
      // A singular form may spell the number out ("one node") instead of using {{count}}.
      const tolerated = pluralBases.has(base) && !key.endsWith('_other') ? want.filter((p) => p !== 'count') : want
      assert.ok(
        tolerated.every((p) => have.includes(p)) && have.every((p) => want.includes(p)),
        `${lng} ${key}: placeholders ${have.join(',')} vs ${want.join(',')}`,
      )
    }
  })
}

test('locale names map to the five languages', () => {
  assert.equal(normalizeLang('zh_CN.UTF-8'), 'zh-Hans')
  assert.equal(normalizeLang('zh_SG'), 'zh-Hans')
  assert.equal(normalizeLang('zh_TW.UTF-8'), 'zh-Hant')
  assert.equal(normalizeLang('zh_HK'), 'zh-Hant')
  assert.equal(normalizeLang('zh-Hant-TW'), 'zh-Hant')
  assert.equal(normalizeLang('fr_CA.UTF-8'), 'fr')
  assert.equal(normalizeLang('ar_EG'), 'ar')
  assert.equal(normalizeLang('en_GB'), 'en')
  assert.equal(normalizeLang('de_DE'), undefined)
  assert.equal(normalizeLang('C'), undefined)
  assert.equal(normalizeLang('POSIX'), undefined)
})

test('the system locale follows LC_ALL, then LC_MESSAGES, then LANG', () => {
  const noOs = () => undefined
  assert.equal(systemLang({ LC_ALL: 'fr_FR.UTF-8', LC_MESSAGES: 'ar_EG', LANG: 'zh_CN' }, noOs), 'fr')
  assert.equal(systemLang({ LC_MESSAGES: 'ar_EG', LANG: 'zh_CN' }, noOs), 'ar')
  assert.equal(systemLang({ LANG: 'zh_TW.UTF-8' }, noOs), 'zh-Hant')
  assert.equal(systemLang({ LC_ALL: 'C', LANG: 'fr_FR.UTF-8' }, noOs), 'fr')
  assert.equal(systemLang({ LANG: 'C.UTF-8' }, noOs), undefined)
  assert.equal(systemLang({ LANG: 'de_DE.UTF-8' }, noOs), 'en')
  assert.equal(systemLang({}, noOs), undefined)
})

test('without locale variables (cmd, PowerShell) the OS locale from Intl decides', () => {
  assert.equal(systemLang({}, () => 'zh-Hant-TW'), 'zh-Hant')
  assert.equal(systemLang({}, () => 'zh-CN'), 'zh-Hans')
  assert.equal(systemLang({}, () => 'fr-BE'), 'fr')
  assert.equal(systemLang({}, () => 'ar-SA'), 'ar')
  assert.equal(systemLang({}, () => 'ja-JP'), 'en')
  assert.equal(systemLang({ LANG: 'fr_FR.UTF-8' }, () => 'ar-SA'), 'fr')
  assert.deepEqual(resolveLangSource({ env: {}, config: () => undefined, osLocale: () => 'ar-EG' }), { lang: 'ar', source: 'system' })
  assert.deepEqual(resolveLangSource({ env: {}, config: () => undefined, osLocale: () => undefined }), { lang: 'en', source: 'default' })
})

test('language resolution: --lang, DECS_LANG, decs config lang, system locale, English', () => {
  const home = mkdtempSync(join(tmpdir(), 'decs-home-'))
  const env = (extra: Record<string, string>) => ({ DECS_HOME: home, LC_ALL: '', LC_MESSAGES: '', LANG: '', ...extra })
  const run = (extra: Record<string, string>, ...args: string[]) =>
    decs(home, [...args, 'config', 'lang'], env(extra)).trim()
  writeFileSync(join(home, 'config.json'), JSON.stringify({ lang: 'zh-Hant' }))
  assert.match(run({ DECS_LANG: 'ar' }, '--lang', 'fr'), /^Français/)
  assert.match(run({ DECS_LANG: 'ar' }), /^العربية/)
  assert.match(run({ DECS_LANG: '', LANG: 'fr_FR.UTF-8' }), /^繁體中文/)
  writeFileSync(join(home, 'config.json'), JSON.stringify({ projects: [] }))
  assert.match(run({ DECS_LANG: '', LANG: 'fr_FR.UTF-8' }), /^Français/)
  assert.match(run({ DECS_LANG: '', LANG: 'en_US.UTF-8' }), /^English/)
  // Nothing configured at all falls through to the OS locale — covered
  // directly, with an injected locale, by `systemLang`'s own tests above.
  // Pinned to English here (rather than leaving DECS_LANG empty) because
  // that last resort reads the real machine's locale via Intl, which on
  // Windows comes from the OS, not from the LANG/LC_ALL this test clears —
  // a Chinese-language Windows box would otherwise fail this assertion.
  assert.match(run({ DECS_LANG: 'en' }), /^English/)
})

test('resolveLang ignores values it does not know and moves on', () => {
  assert.equal(resolveLang({ env: { DECS_LANG: 'klingon', LANG: 'ar_SA.UTF-8' }, config: () => undefined }), 'ar')
})

test('--lang is taken out of argv wherever it is, but not after --', () => {
  assert.deepEqual(takeLangFlag(['show', '--lang', 'fr', 'all']), { argv: ['show', 'all'], lang: 'fr' })
  assert.deepEqual(takeLangFlag(['--lang=ar', 'get', '3']), { argv: ['get', '3'], lang: 'ar' })
  assert.deepEqual(takeLangFlag(['note', '3', '--', '--lang', 'x']), { argv: ['note', '3', '--', '--lang', 'x'], lang: undefined })
})

test('an unknown --lang is an error that lists the languages', () => {
  const r = decsResult(scratch(), ['--lang', 'xx', 'show'], { DECS_LANG: 'en' })
  assert.equal(r.code, 2)
  assert.match(r.stderr, /unknown language "xx".*en zh-Hans zh-Hant fr ar/)
})

test('decs config lang stores the language per user and keeps the folder registry', () => {
  const home = mkdtempSync(join(tmpdir(), 'decs-home-'))
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'config.json'), JSON.stringify({ projects: [{ name: 'web', root: '/srv/web' }] }))
  const env = { DECS_HOME: home, DECS_LANG: '' }
  decs(home, ['config', 'lang', 'zh_TW'], env)
  const cfg = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))
  assert.equal(cfg.lang, 'zh-Hant')
  assert.equal(cfg.projects[0].name, 'web')
  assert.match(decs(home, ['config', 'lang'], env), /來自 nod config lang/)
  decs(home, ['config', 'lang', '--off'], env)
  assert.equal(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).lang, undefined)
  assert.equal(decsResult(home, ['config', 'lang', 'klingon'], env).code, 1)
})

const PLUGIN = fileURLToPath(new URL('../plugin/', import.meta.url))

function hook(script: string, input: string, env: Record<string, string>, cwd = scratch()): string {
  const out = execFileSync(process.execPath, [join(PLUGIN, script)], {
    cwd,
    input,
    encoding: 'utf8',
    env: { ...process.env, DECS_AUTHOR: 'cli-test · lane', ...env },
  })
  return JSON.parse(out).hookSpecificOutput.additionalContext as string
}

for (const lng of LANGUAGES) {
  test(`the prompt-refs hook reminds in ${lng}`, () => {
    const text = hook('prompt-refs.mjs', JSON.stringify({ prompt: 'about W305', cwd: '/nonexistent' }), { DECS_LANG: lng })
    assert.match(text, /W305/)
    assert.match(text, /nod note <id> --human/)
    assert.doesNotMatch(text, /\{\{|plugin\.promptRefs/)
  })

  test(`the session-start hook lists open nodes with ${lng} status labels`, () => {
    const dir = scratch()
    decs(dir, ['init'])
    decs(dir, ['add', '--task', 'Ship the login page'])
    setLang(lng)
    const label = t('common.status.not_started')
    setLang('en')
    const text = hook('session-start.mjs', '', { DECS_LANG: lng }, dir)
    assert.ok(text.includes(`· ${label} · Ship the login page`), text.slice(-400))
    const rules = readFileSync(join(PLUGIN, 'rules.md'), 'utf8')
    assert.ok(text.startsWith(rules.split('\n')[0]), `the English rules first, under ${lng} too`)
    assert.doesNotMatch(text, /\{\{|plugin\.sessionStart/)
  })
}

test('French puts a no-break space before : ; ? ! » and after «', () => {
  for (const [key, value] of Object.entries(flatten(loadResources('fr')))) {
    assert.doesNotMatch(value, / [:;?!»]|« /, `fr ${key}: use U+00A0 (node scripts/fr-typography.ts)`)
  }
})

/** What is left of a value once code-like tokens are taken out: commands, flags, env vars, refs, paths, placeholders. */
function codeless(value: string): string {
  return (
    value
      .split('\n')
      // a synopsis line ("nod add <title> …") or a value lined up before its description ("open      …")
      .map((line) => line.replace(/^\s*(?:decs|nod)\b(?: [a-z<>[\]|.…0-9=" -]+?)?(?=\s{2,}|$)|^\s*[\w<>.]+(?:\s*\|\s*[\w<>.]+)*(?=\s{2,})/, ''))
      .join('\n')
      .replace(/\{\{[^}]*\}\}|`[^`]*`|<[^>\n]*>|\[[^\]\n]*\]/g, ' ')
      .replace(/(?:^|\s)--?[\w-]+/g, ' ')
      .replace(/\b[A-Z][A-Z0-9_-]{1,}\b|\b\w*\d\w*\b|\S*[/.~:=]\S*/g, ' ')
      // a command named inline: "… run nod monitor", "decs show fyi"
      .replace(/\b(?:decs|nod)\s+[a-z][a-z-]*/gi, ' ')
      // the Monitor tool's name; the lowercase noun stays checkable
      .replace(/\bMonitor\b/g, ' ')
      // a list of literal values: tree|owner|running
      .replace(/\b[\w-]+(?:\|[\w-]+)+\b/g, ' ')
      // a note heading as written in the file: "(human · owner · …)", "(agent · lead/ship-v2 · …)"
      .replace(/\b(?:human|agent)\s*·\s*\S+/g, ' ')
  )
}

/** `codeless`, also without the literal words commands and their arguments use. */
function prose(value: string): string {
  return codeless(value).replace(/\b(?:decs|nod|register|sync|push|heartbeat|list|items|ack|wait|events|top|bottom|off|superseded|obsolete|merged-into|markdown|id|ids|en|fr|ar|zh-Hans|zh-Hant)\b/gi, ' ')
}

/** Words French shares with English, which a translation may keep as they are. */
const COGNATES = new Set(['note', 'urgent', 'parent', 'agent', 'sources', 'option', 'options', 'version', 'adapter'])

for (const lng of LANGUAGES.filter((l) => l !== 'en')) {
  test(`${lng} has no value left in English`, () => {
    const got = flatten(loadResources(lng))
    const untranslated = Object.entries(got).filter(([key, value]) => {
      const base = key.replace(PLURAL, '')
      const ref = en[key] ?? en[`${base}_other`]
      if (value !== ref) return false
      const words = prose(value).toLowerCase().match(/[a-z]{3,}/g) ?? []
      return words.some((w) => !COGNATES.has(w))
    })
    assert.deepEqual(untranslated.map(([k]) => k), [])
  })
}

for (const lng of ['zh-Hans', 'zh-Hant', 'ar'] as const) {
  test(`${lng} has no English sentence left inside a translated value`, () => {
    const mixed = Object.entries(flatten(loadResources(lng))).filter(([, value]) => /(?:\b[A-Za-z]{2,}\b[ ,;]+){3,}[A-Za-z]{2,}/.test(prose(value)))
    assert.deepEqual(mixed.map(([k, v]) => `${k}: ${prose(v).replace(/\s+/g, ' ').trim().slice(0, 80)}`), [])
  })
}

test('the condensed body keeps the what / why paragraphs whatever language they are written in', async () => {
  const { condense } = await import('../src/tui/model.ts')
  const body = (what: string, why: string) => `${what} first.\n\nlong evidence\n\nmore evidence\n\n${why} second.\n\nlogs`
  for (const [what, why] of [
    ['**What.**', '**Why now.**'],
    ['**是什么：**', '**为什么：**'],
    ['**這是什麼：**', '**為什麼：**'],
    ['**Quoi.**', '**Pourquoi maintenant.**'],
    ['**ما هو.**', '**لماذا الآن.**'],
  ]) {
    assert.equal(condense({ body: body(what, why) } as never), `${what} first.\n\n${why} second.`, what)
  }
})

/** English words a translation should say in its own language; French already has agent and session. */
const LOANWORDS = ['owner', 'agent', 'lane', 'lead', 'teammate', 'session', 'adapter', 'bench', 'monitor', 'front matter', 'fyi', 'shell']

for (const lng of ['zh-Hans', 'zh-Hant', 'fr', 'ar'] as const) {
  test(`${lng} says owner, lane, bench and the like in its own words`, () => {
    const words = lng === 'fr' ? LOANWORDS.filter((w) => w !== 'agent' && w !== 'session') : LOANWORDS
    const found = Object.entries(flatten(loadResources(lng))).flatMap(([key, value]) => {
      const text = codeless(value).toLowerCase()
      return words.filter((w) => new RegExp(`(?<![\\w-])${w}s?(?![\\w-])`).test(text)).map((w) => `${key}: ${w}`)
    })
    assert.deepEqual(found, [])
  })
}
