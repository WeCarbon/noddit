import { bool, type Args } from '../args.ts'
import { resolveStore } from '../context.ts'
import { existsSync, realpathSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { findLayout, layoutFor, type Layout } from '../../core/paths.ts'
import { DEFAULT_LETTER, configPath, projectDisplayName, readProjectConfig, writeProjectConfig } from '../../core/project.ts'
import { CONFIG_PATH, readProjects } from '../../core/config.ts'
import { dim } from '../../core/render.ts'
import { SETTINGS, settingFor, settingValue, setSetting, showValue, type Setting } from '../../core/settings.ts'
import { LANGUAGES, LANGUAGE_NAMES, langFlag, resolveLangSource, t } from '../../i18n/index.ts'

const help = () =>
  t('cli.config.help', {
    defaultLetter: DEFAULT_LETTER,
    languages: LANGUAGES.map((l) => `${l} (${LANGUAGE_NAMES[l]})`).join(', '),
    settings: SETTINGS.map((s) => `  ${s.key.padEnd(17)}${s.values.join(' | ')}${s.env ? `   (NODDIT_${s.env})` : ''}`).join('\n'),
  })

export function run(args: Args): number {
  if (bool(args, 'help', 'h')) {
    console.log(help())
    return 0
  }
  const [key, value] = args._
  if (!key) return bool(args, 'json') ? listJson() : list()
  if (key === 'letter') return letter(args, value)
  if (key === 'name') return name(args, args._.slice(1).join(' ') || undefined)
  const setting = settingFor(key)
  if (!setting) throw new Error(`${t('cli.config.unknownKey', { key, keys: ['letter', 'name', ...SETTINGS.map((s) => s.key)].join(' ') })}\n\n${help()}`)
  if (bool(args, 'off')) {
    setSetting(key, undefined)
    if (bool(args, 'json')) console.log(JSON.stringify(settingJson(setting)))
    else console.log(t('cli.config.cleared', { key, path: dim(CONFIG_PATH) }))
    return 0
  }
  if (value === undefined) {
    console.log(bool(args, 'json') ? JSON.stringify(settingJson(setting)) : current(setting))
    return 0
  }
  const stored = setSetting(key, value) ?? setting.default
  if (bool(args, 'json')) {
    console.log(JSON.stringify(settingJson(setting)))
    return 0
  }
  if (key === 'lang' && stored !== 'auto') {
    console.log(t('common.lang.set', { name: showValue(setting, stored), code: stored, path: dim(CONFIG_PATH) }))
  } else {
    console.log(t('cli.config.set', { key, value: showValue(setting, stored), path: dim(CONFIG_PATH) }))
  }
  return 0
}

/** One setting's value and where it comes from: `Français (fr), from nod config lang`. */
function current(s: Setting): string {
  if (s.key === 'lang') {
    const { lang, source, envName } = resolveLangSource({ flag: langFlag() })
    const label = source === 'env' ? envName! : t(`common.lang.source.${source}`)
    return t('common.lang.current', { name: LANGUAGE_NAMES[lang], code: lang, source: label })
  }
  const { value, source, envName } = settingValue(s.key)
  const from = source === 'env' ? envName! : source === 'config' ? `nod config ${s.key}` : t('common.lang.source.default')
  return t('cli.config.current', { value: showValue(s, value), source: from })
}

/**
 * One setting as a window draws it: its label, the value in force and where it comes from
 * (an env var's value can't be changed from there), and every choice with its label.
 */
function settingJson(s: Setting): Record<string, unknown> {
  const { value, source, envName } = settingValue(s.key)
  return {
    key: s.key,
    label: t(`settings.label.${s.key}`),
    type: s.type,
    value,
    value_label: showValue(s, value),
    default: s.default,
    source,
    env: envName ?? null,
    choices: s.values.map((v) => ({ value: v, label: showValue(s, v) })),
  }
}

/** `nod config --json`: every setting, in the order the bench's dialog lists them. */
function listJson(): number {
  console.log(JSON.stringify({ path: CONFIG_PATH, settings: SETTINGS.map(settingJson) }))
  return 0
}

/** `decs config`: every setting, then this project's letter when there is a project here. */
function list(): number {
  const width = Math.max(...SETTINGS.map((s) => s.key.length)) + 2
  for (const s of SETTINGS) console.log(`${s.key.padEnd(width)}${current(s)}`)
  console.log(dim(CONFIG_PATH))
  const layout = findLayout()
  if (layout) {
    const cfg = readProjectConfig(layout)
    console.log(`\n${'letter'.padEnd(width)}${cfg.letter ?? t('cli.config.letterUnset', { letter: DEFAULT_LETTER })}`)
    console.log(`${'name'.padEnd(width)}${cfg.name ?? t('cli.config.nameUnset', { folder: basename(layout.projectRoot) })}`)
    console.log(dim(configPath(layout)))
  }
  return 0
}

/** The project letter belongs to the repo you are standing in, not to the user. */
function letter(args: Args, value: string | undefined): number {
  const layout = resolveStore(args).primary
  const asJson = bool(args, 'json')
  if (!value) {
    const cfg = readProjectConfig(layout)
    if (asJson) console.log(JSON.stringify({ letter: cfg.letter ?? DEFAULT_LETTER, set: Boolean(cfg.letter), former_letters: cfg.former_letters ?? [] }))
    else console.log(cfg.letter ?? t('cli.config.letterUnset', { letter: DEFAULT_LETTER }))
    return 0
  }
  const wanted = value.toUpperCase()
  const clash = otherProjectWithLetter(layout, wanted)
  if (clash && !bool(args, 'force'))
    throw new Error(t('cli.config.letterTaken', { project: clash, letter: wanted, example: `${basename(layout.projectRoot)}:305` }))
  const next = writeProjectConfig(layout, { letter: wanted })
  if (asJson) {
    console.log(JSON.stringify({ letter: next.letter, former_letters: next.former_letters ?? [] }))
    return 0
  }
  console.log(`${t('cli.config.letterSet', { letter: next.letter })}  ${dim(configPath(layout))}`)
  if (next.former_letters?.length) console.log(dim(t('cli.config.letterFormer', { former: next.former_letters.join(' ') })))
  return 0
}

/** Another registered project already showing `letter`, by its display name. Only matters when this one is registered too. */
function otherProjectWithLetter(self: Layout, letter: string): string | undefined {
  // .native to agree with core/paths.ts's own canonicalization — plain realpathSync can
  // normalise a Windows path differently, breaking the identity check below.
  const real = (p: string) => (existsSync(p) ? realpathSync.native(p) : resolve(p))
  const here = real(self.projectRoot)
  const registered = readProjects()
  if (!registered.some((p) => real(p.root) === here)) return undefined
  for (const p of registered) {
    if (real(p.root) === here) continue
    const l = layoutFor(p.root)
    if (!existsSync(l.root)) continue
    if (readProjectConfig(l).letter === letter) return projectDisplayName(l)
  }
  return undefined
}

/** What the project is called on the bench and in the window; the folder name stays the key. */
function name(args: Args, value: string | undefined): number {
  const layout = resolveStore(args).primary
  const folder = basename(layout.projectRoot)
  const asJson = bool(args, 'json')
  if (bool(args, 'off')) {
    writeProjectConfig(layout, { name: null })
    if (asJson) console.log(JSON.stringify({ name: folder, set: false }))
    else console.log(t('cli.config.nameCleared', { folder }))
    return 0
  }
  if (!value?.trim()) {
    const cfg = readProjectConfig(layout)
    if (asJson) console.log(JSON.stringify({ name: cfg.name ?? folder, set: Boolean(cfg.name) }))
    else console.log(cfg.name ?? t('cli.config.nameUnset', { folder }))
    return 0
  }
  const next = writeProjectConfig(layout, { name: value.trim() })
  if (asJson) console.log(JSON.stringify({ name: next.name, set: true }))
  else console.log(`${t('cli.config.nameSet', { name: next.name, folder })}  ${dim(configPath(layout))}`)
  return 0
}
