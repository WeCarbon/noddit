/**
 * A small flag parser, e.g. `decs send "标题" --option 1="维持现状" 2="换新 CDN"`.
 * `--option` (and other greedy flags) eat tokens until the next `--flag`, so
 * repeated values can be written as one phrase; repeating the flag also works.
 */
import { REVIEW_DEFAULT, REVIEW_OPTIONS, type DecisionQuestion } from '../core/questions.ts'
import { t } from '../i18n/index.ts'

export interface Args {
  /** Positional arguments, in order, with the subcommand already removed. */
  _: string[]
  flags: Record<string, string[]>
}

/** Flags that swallow following tokens that still look like a value for them. */
const OPTION_TOKEN = /^(?:default:)?(?:[A-Z]\d{1,3}:)?[A-Za-z0-9]{1,4}=/
const GREEDY: Record<string, RegExp | true> = {
  option: OPTION_TOKEN,
  o: OPTION_TOKEN,
  dir: true,
  d: true,
  tag: true,
  after: /^(?:[\w.-]+:)?[A-Za-z]?\d+(?:,(?:[\w.-]+:)?[A-Za-z]?\d+)*$/,
}
/** Flags that take no value. */
const BOOLEAN = new Set([
  'json', 'raw', 'help', 'h', 'all', 'dry-run', 'force', 'quiet', 'q',
  'no-archive', 'keep', 'answered', 'archived', 'version', 'v', 'stdin',
  'seen', 'undo', 'peek', 'mine', 'link', 'fix', 'no-register', 'no-images', 'inline',
  'human', 'agent', 'fyi', 'defaults', 'done', 'notify', 'task', 'tree', 'root', 'upgrade', 'strip-prefix', 'attachments',
  // Not `stale`: `decs queue --stale 1h` takes a value; a bare `--stale` still reads as set.
  'unhandled', 'no-sources', 'here', 'no-sync', 'no-sync-cmd',
  'replace', 'approval-content', 'off', 'brief', 'no-brief', 'no-heartbeat', 'clear',
])

export function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} }
  const push = (k: string, v: string) => (out.flags[k] ??= []).push(v)

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    if (tok === '--') {
      out._.push(...argv.slice(i + 1))
      break
    }
    if (!tok.startsWith('-') || tok === '-') {
      out._.push(tok)
      continue
    }

    const raw = tok.replace(/^--?/, '')
    const eq = raw.indexOf('=')
    const name = eq === -1 ? raw : raw.slice(0, eq)
    const inline = eq === -1 ? undefined : raw.slice(eq + 1)

    if (BOOLEAN.has(name)) {
      push(name, inline ?? 'true')
      continue
    }
    // `--question Q1 "标题"` takes two tokens; `--question Q1="标题"` one.
    if (name === 'question' || name === 'review-item') {
      const first = inline ?? argv[++i]
      if (first === undefined) throw new Error(t('cli.args.flagNeedsKeyTitle', { name }))
      if (/^[A-Z]\d{1,3}=/.test(first)) push(name, first)
      else {
        const label = argv[i + 1]
        if (label === undefined || label.startsWith('-')) throw new Error(t('cli.args.flagNeedsTitleAfter', { name, value: first }))
        push(name, `${first}=${argv[++i]}`)
      }
      continue
    }
    const greedy = GREEDY[name]
    if (inline !== undefined) {
      push(name, inline)
      if (!greedy) continue
    }
    while (i + 1 < argv.length) {
      const next = argv[i + 1]
      if (next.startsWith('-') && next !== '-') break
      if (greedy instanceof RegExp && !greedy.test(next)) break
      push(name, argv[++i])
      if (!greedy) break
    }
    if (!(name in out.flags)) push(name, 'true')
  }
  return out
}

export function one(a: Args, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = a.flags[n]
    if (v?.length) return v[v.length - 1]
  }
  return undefined
}

export function many(a: Args, ...names: string[]): string[] {
  return names.flatMap((n) => a.flags[n] ?? [])
}

export function bool(a: Args, ...names: string[]): boolean {
  return names.some((n) => a.flags[n]?.length)
}

export interface ParsedOption {
  key: string
  label: string
  body: string
  /** Written as `default:2="…"` — marks what happens if nobody answers. */
  isDefault: boolean
}

/**
 * Turns `1=维持现状` into `{ key: '1', label: '维持现状' }`, and `default:2=…`
 * into the same plus `isDefault`. Only the label's first line becomes the
 * `### 1 · <label>` heading; the rest moves into the option's body.
 */
export function parseOptionPairs(raw: string[]): ParsedOption[] {
  return raw.map((pair, i) => {
    const eq = pair.indexOf('=')
    let key = eq === -1 ? String(i + 1) : pair.slice(0, eq).trim()
    const isDefault = key.startsWith('default:')
    if (isDefault) key = key.slice('default:'.length).trim()
    const value = (eq === -1 ? pair : pair.slice(eq + 1)).trim()
    const [first, ...rest] = value.split(/\r?\n/)
    return { key, label: first.trim(), body: rest.join('\n').trim(), isDefault }
  })
}

/**
 * `-o 1=… default:2=…` plus `--default 2`, checked against each other — what
 * `decs add` and `decs ask` both take.
 */
export function optionsAndDefault(a: Args): { options: ParsedOption[]; default?: string } {
  // `Q1:A=…` and `--default Q1:A` belong to sub-questions — see `questionsFromArgs`.
  const options = parseOptionPairs(many(a, 'option', 'o')).filter((o) => !o.key.includes(':'))
  const marked = options.filter((o) => o.isDefault)
  if (marked.length > 1) {
    throw new Error(t('cli.args.onlyOneDefault', { count: marked.length, keys: marked.map((o) => o.key).join(' ') }))
  }
  const plainDefaults = many(a, 'default').filter((v) => !v.includes(':'))
  const explicit = plainDefaults[plainDefaults.length - 1]
  if (explicit && marked.length && explicit !== marked[0].key) {
    throw new Error(t('cli.args.defaultMismatch', { explicit, marked: marked[0].key }))
  }
  return { options, default: explicit ?? marked[0]?.key }
}

/**
 * `--question Q1 "选哪个 CDN" -o Q1:A="继续用现在的" Q1:B="换新的" --default Q1:A`, and
 * `--review-item R1 "回复 Dave"` — a question with 通过 / 不通过 / 改.
 */
export function questionsFromArgs(a: Args): DecisionQuestion[] {
  const qs: DecisionQuestion[] = []
  const add = (raw: string, review: boolean) => {
    const eq = raw.indexOf('=')
    const key = raw.slice(0, eq).trim()
    if (qs.some((q) => q.key === key)) throw new Error(t('cli.args.subQuestionTwice', { key }))
    qs.push({
      key,
      label: oneLine(raw.slice(eq + 1)),
      body: '',
      options: review ? REVIEW_OPTIONS.map((o) => ({ ...o })) : [],
      default: review ? REVIEW_DEFAULT : undefined,
    })
  }
  for (const raw of many(a, 'question')) add(raw, false)
  for (const raw of many(a, 'review-item')) add(raw, true)
  for (const o of parseOptionPairs(many(a, 'option', 'o')).filter((o) => o.key.includes(':'))) {
    const [qk, ok] = o.key.split(':')
    const q = qs.find((x) => x.key === qk)
    if (!q) throw new Error(t('cli.args.subQuestionUndeclared', { key: o.key, qk }))
    q.options.push({ key: ok, label: o.label, body: o.body })
    if (o.isDefault) q.default = ok
  }
  for (const v of many(a, 'default').filter((v) => v.includes(':'))) {
    const [qk, ok] = v.split(':')
    const q = qs.find((x) => x.key === qk)
    if (!q) throw new Error(t('cli.args.subQuestionMissing', { value: v, qk }))
    q.default = ok
  }
  return qs
}

/** Collapses a shell-supplied multi-line string down to something heading-safe. */
export function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}
