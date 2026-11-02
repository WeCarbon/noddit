import { readUserConfig, writeUserConfig } from './config.ts'
import { parseDuration } from './duration.ts'
import { nodditEnvHit } from './env.ts'
import { LANGUAGES, LANGUAGE_NAMES, normalizeLang, resolveLang, setLang, t } from '../i18n/index.ts'
import { BIDI_MODES } from '../i18n/bidi.ts'

/**
 * Every per-user setting, in the order the bench's settings dialog lists them.
 * `decs config` and the dialog both read this list, so a new setting is one
 * entry here. Values live in `$NODDIT_HOME/config.json`; an environment
 * variable, where a setting has one, overrides the stored value.
 */
export interface Setting {
  /** The key in config.json and the word after `decs config`. */
  key: string
  type: 'enum' | 'bool' | 'duration'
  /** The choices the dialog cycles through; a duration also accepts any `parseDuration` value. */
  values: readonly string[]
  default: string
  /** The suffix after `NODDIT_`/`DECS_` for this setting's env var, when it has one (e.g. `'LANG'` for `NODDIT_LANG`/`DECS_LANG`). */
  env?: string
  /** A value as the user reads it; defaults to the value itself. */
  show?: (value: string) => string
  /** Takes a new value into this process (the dialog changes things live). */
  apply?: (value: string) => void
  /** Normalises what was typed, or undefined when it is not a valid value. */
  parse?: (raw: string) => string | undefined
}

const VIEWS = ['available', 'active', 'decide', 'all', 'waiting'] as const

export const SETTINGS: readonly Setting[] = [
  {
    key: 'lang',
    type: 'enum',
    values: ['auto', ...LANGUAGES],
    default: 'auto',
    env: 'LANG',
    show: (v) => (v === 'auto' ? t('settings.value.auto') : (LANGUAGE_NAMES as Record<string, string>)[v] ?? v),
    parse: (raw) => (raw === 'auto' ? 'auto' : normalizeLang(raw)),
    apply: () => setLang(resolveLang()),
  },
  {
    key: 'bidi',
    type: 'enum',
    values: BIDI_MODES,
    default: 'visual',
    env: 'BIDI',
  },
  {
    key: 'view',
    type: 'enum',
    values: VIEWS,
    default: 'available',
    show: (v) => t(`bench.tabs.${v}`),
  },
  {
    key: 'images',
    type: 'enum',
    values: ['auto', 'iterm', 'kitty', 'off'],
    default: 'auto',
    env: 'IMAGES',
    show: (v) => (v === 'auto' || v === 'off' ? t(`settings.value.${v}`) : v),
  },
  {
    key: 'mouse',
    type: 'bool',
    values: ['on', 'off'],
    default: 'on',
    show: (v) => t(`settings.value.${v}`),
  },
  {
    key: 'idle-exit',
    type: 'duration',
    values: ['30m', '1h', '2h', '4h', '8h', '0'],
    default: '2h',
    show: (v) => (v === '0' ? t('settings.value.never') : v),
  },
  {
    key: 'unclaimed-after',
    type: 'duration',
    values: ['1m', '5m', '15m', '30m', '1h'],
    default: '5m',
  },
  {
    key: 'checkin-after',
    type: 'duration',
    values: ['15m', '30m', '1h', '2h', '4h'],
    default: '30m',
    env: 'CHECKIN_AFTER',
  },
]

export function settingFor(key: string): Setting | undefined {
  return SETTINGS.find((s) => s.key === key)
}

export type SettingSource = 'env' | 'config' | 'default'

function valid(s: Setting, raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  const v = raw.trim()
  if (s.parse) return s.parse(v)
  if (s.type === 'duration') {
    try {
      parseDuration(v)
      return v
    } catch {
      return undefined
    }
  }
  return s.values.includes(v) ? v : undefined
}

/** The value in force and where it comes from. An unusable env or stored value is skipped. */
export function settingValue(key: string, env: NodeJS.ProcessEnv = process.env): { value: string; source: SettingSource; envName?: string } {
  const s = settingFor(key)
  if (!s) throw new Error(t('settings.unknown', { key, keys: SETTINGS.map((x) => x.key).join(' ') }))
  const hit = s.env ? nodditEnvHit(s.env, env) : undefined
  const fromEnv = hit ? valid(s, hit.value) : undefined
  if (fromEnv) return { value: fromEnv, source: 'env', envName: hit!.name }
  const stored = valid(s, readUserConfig()[s.key])
  if (stored) return { value: stored, source: 'config' }
  return { value: s.default, source: 'default' }
}

/** Stores a value (undefined removes it, back to the default), applies it here, and returns what was stored. */
export function setSetting(key: string, raw: string | undefined): string | undefined {
  const s = settingFor(key)
  if (!s) throw new Error(t('settings.unknown', { key, keys: SETTINGS.map((x) => x.key).join(' ') }))
  if (raw === undefined) {
    writeUserConfig({ [s.key]: undefined })
    s.apply?.(settingValue(key).value)
    return undefined
  }
  const v = valid(s, raw)
  if (!v) throw new Error(t('settings.invalid', { key, value: raw, values: s.values.join(' ') }))
  writeUserConfig({ [s.key]: v === s.default ? undefined : v })
  s.apply?.(v)
  return v
}

/** The next (or previous) choice after the value in force, for the dialog's ←/→. */
export function cycleSetting(key: string, step: 1 | -1): string {
  const s = settingFor(key)!
  const { value } = settingValue(key)
  const i = s.values.indexOf(value)
  const next = s.values[(i + step + s.values.length) % s.values.length] ?? s.default
  return setSetting(key, next) ?? s.default
}

export function showValue(s: Setting, value: string): string {
  return s.show ? s.show(value) : value
}
