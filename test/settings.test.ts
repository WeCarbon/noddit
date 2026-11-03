import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SETTINGS } from '../src/core/settings.ts'
import { LANGUAGES, loadResources } from '../src/i18n/index.ts'
import { BIN, decs, decsResult, killAndWait, scratch } from './helpers.ts'

const home = () => mkdtempSync(join(tmpdir(), 'decs-home-'))
const stored = (h: string) => JSON.parse(readFileSync(join(h, 'config.json'), 'utf8')) as Record<string, unknown>

test('every setting has a label in every language', () => {
  for (const lng of LANGUAGES) {
    const labels = (loadResources(lng).settings as { label: Record<string, string> }).label
    for (const s of SETTINGS) assert.ok(labels[s.key], `${lng} settings.label.${s.key}`)
  }
})

test('decs config <setting> <value> round-trips every setting through config.json', () => {
  const h = home()
  const env = { DECS_HOME: h, DECS_LANG: '', LC_ALL: '', LC_MESSAGES: '', LANG: 'en_US.UTF-8', DECS_BIDI: '', DECS_IMAGES: '' }
  for (const s of SETTINGS) {
    // English keeps every message below in English, whatever language the setting is changed to.
    const value = s.key === 'lang' ? 'en' : s.values.find((v) => v !== s.default)!
    decs(h, ['config', s.key, value], env)
    assert.equal(stored(h)[s.key], value, s.key)
    assert.match(decs(h, ['config', s.key], env), new RegExp(`from nod config ${s.key}$`, 'm'), s.key)
    decs(h, ['config', s.key, '--off'], env)
    assert.equal(stored(h)[s.key], undefined, `${s.key} --off`)
    assert.match(decs(h, ['config', s.key], env), /from (the default|the system locale)$/m, `${s.key} default`)
  }
})

test('decs config lists every setting with where its value comes from', () => {
  const h = home()
  const out = decs(h, ['config'], { DECS_HOME: h, DECS_LANG: 'en', DECS_IMAGES: 'off' })
  for (const s of SETTINGS) assert.match(out, new RegExp(`^${s.key} +`, 'm'))
  assert.match(out, /^images +off, from DECS_IMAGES$/m)
  assert.match(out, /^view +Available, from the default$/m)
})

test('a value equal to the default is not stored, and a bad value or key is refused', () => {
  const h = home()
  const env = { DECS_HOME: h, DECS_LANG: 'en' }
  decs(h, ['config', 'view', 'decide'], env)
  decs(h, ['config', 'view', 'available'], env)
  assert.equal(stored(h).view, undefined)
  const bad = decsResult(h, ['config', 'view', 'sideways'], env)
  assert.equal(bad.code, 1)
  assert.match(bad.stderr, /"sideways" is not a value for view — use one of: available active decide all waiting/)
  assert.match(decsResult(h, ['config', 'colour', 'red'], env).stderr, /unknown setting "colour"/)
  assert.match(decsResult(h, ['config', 'idle-exit', 'soon'], env).stderr, /not a value for idle-exit/)
  decs(h, ['config', 'idle-exit', '90m'], env)
  assert.equal(stored(h)['idle-exit'], '90m', 'a duration takes any valid length, not just the presets')
})

test('decs config lang keeps the folder registry and the other settings', () => {
  const h = home()
  const env = { DECS_HOME: h, DECS_LANG: '' }
  decs(h, ['config', 'mouse', 'off'], env)
  decs(h, ['config', 'lang', 'fr'], env)
  assert.deepEqual(stored(h), { mouse: 'off', lang: 'fr' })
  assert.match(decs(h, ['config', 'lang', 'auto'], env), /lang = /)
  assert.deepEqual(stored(h), { mouse: 'off' })
})

test('the monitor takes idle-exit from decs config when no flag says otherwise', async (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const h = join(root, 'home')
  decs(root, ['init', '--no-register'])
  decs(root, ['config', 'idle-exit', '1s'], { DECS_HOME: h })
  const child = spawn(process.execPath, [BIN, 'monitor', '--with-parent', String(process.pid), '--interval', '200', '--no-sources'], {
    cwd: root,
    env: { ...process.env, NO_COLOR: '1', DECS_LANG: 'en', DECS_HOME: h, CLAUDECODE: '1' },
  })
  // This test's whole premise is the monitor exiting on its own — but if that
  // ever regresses, nothing here must be left to hang the rest of the suite.
  t.after(() => killAndWait(child))
  let out = ''
  child.stdout.on('data', (b) => (out += b))
  const code = await new Promise<number | null>((resolve) => child.once('exit', resolve))
  assert.equal(code, 0)
  assert.match(out, /^DECS-IDLE /m)
})
