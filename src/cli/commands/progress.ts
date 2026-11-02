import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { bool, one, type Args } from '../args.ts'
import { resolveStore } from '../context.ts'
import { nodditNodeEnv } from '../../core/env.ts'
import { refOf } from '../../core/ref.ts'
import { toJSON } from '../../core/render.ts'
import {
  PROGRESS_PARSERS,
  JSONL_PARSER_NAME,
  parseAnyProgressLine,
  percentFromCount,
  percentFromRegex,
  createThrottle,
  createJsonlParser,
  createAutoParser,
  type ProgressParser,
} from '../../core/progress.ts'
import type { Decision as Item } from '../../core/types.ts'
import type { Store } from '../../core/store.ts'
import { t } from '../../i18n/index.ts'

/** `pytest`/`percent`/`fraction` plus `jsonl`, which needs per-call state so it isn't a plain `PROGRESS_PARSERS` entry. */
const parserNames = () => [...Object.keys(PROGRESS_PARSERS), JSONL_PARSER_NAME].join(' | ')

const help = () => t('cli.help.progress', { parsers: parserNames() })

/** A bare percentage, normalized to the same shape a `{pct, msg}` parser result has. */
function asPct(v: number | { pct: number; msg?: string }): { pct: number; msg?: string } {
  return typeof v === 'number' ? { pct: v } : v
}

function resolveNodeRef(args: Args): string {
  const flag = one(args, 'node', 'task', 'id')
  const raw = flag ?? nodditNodeEnv()
  if (!raw) throw new Error(t('cli.progress.noNode'))
  return String(raw)
}

function storeAndItem(args: Args): { store: Store; item: Item } {
  const raw = resolveNodeRef(args)
  const store = resolveStore(args, { allowRegistry: true })
  return { store, item: store.resolve(raw, one(args, 'project', 'p')) }
}

function report(item: Item, args: Args): void {
  if (bool(args, 'json')) console.log(JSON.stringify(toJSON(item)))
  else console.log(`${refOf(item)} ${item.progress}%${item.progressMsg ? ` ${item.progressMsg}` : ''}`)
}

function makeParser(args: Args): ProgressParser {
  const regexRaw = one(args, 'regex')
  if (regexRaw) {
    const re = new RegExp(regexRaw)
    return (line) => percentFromRegex(re, line)
  }
  const name = one(args, 'parse')
  if (name === JSONL_PARSER_NAME) return createJsonlParser()
  if (name) {
    const p = PROGRESS_PARSERS[name]
    if (!p) throw new Error(t('cli.progress.unknownParser', { name, parsers: parserNames() }))
    return p
  }
  return parseAnyProgressLine
}

async function runCountLines(args: Args): Promise<number> {
  const file = one(args, 'count-lines')!
  const total = Number(one(args, 'total'))
  if (!Number.isFinite(total) || total <= 0) throw new Error(t('cli.progress.countLinesNeedsTotal'))
  if (!existsSync(file)) throw new Error(t('core.store.noSuchFile', { path: file }))
  let lines = 0
  await new Promise<void>((resolveP, reject) => {
    const rl = createInterface({ input: createReadStream(file, 'utf8') })
    rl.on('line', () => lines++)
    rl.on('close', () => resolveP())
    rl.on('error', reject)
  })
  const { store, item } = storeAndItem(args)
  const pct = percentFromCount(lines, total)
  const next = store.progress(item, { progress: pct, progressMsg: one(args, 'msg') ?? `${lines}/${total}` })
  report(next, args)
  return 0
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Follows a growing log file like `tail -f`, re-reading it each tick and
 * keeping the last percentage any line matched. Stops when `--until-exit
 * <pid>` goes away, or when idle for `--idle` ms (default 5000).
 */
async function runFromFile(args: Args): Promise<number> {
  const file = one(args, 'from-file')!
  // With neither --parse nor --regex given, auto-detect a noddit JSONL
  // events file rather than always falling back to the legacy line parsers.
  const parse = one(args, 'parse') || one(args, 'regex') ? makeParser(args) : createAutoParser()
  const untilExitRaw = one(args, 'until-exit')
  const untilExitPid = untilExitRaw ? Number(untilExitRaw) : undefined
  const idleMs = Number(one(args, 'idle') ?? 5000)
  const { store, item } = storeAndItem(args)
  const explicitMsg = one(args, 'msg')
  const throttle = createThrottle<{ pct: number; msg?: string }>(5000, ({ pct, msg }) => {
    store.progress(item, { progress: pct, progressMsg: explicitMsg ?? msg })
  })

  let lastSize = -1
  let lastChangeAt = Date.now()
  let last: { pct: number; msg?: string } | null = null

  return new Promise<number>((resolveP) => {
    const tick = () => {
      if (existsSync(file)) {
        const { size } = statSync(file)
        if (size !== lastSize) {
          lastSize = size
          lastChangeAt = Date.now()
        }
        const text = readFileSync(file, 'utf8')
        for (const line of text.split('\n')) {
          const v = parse(line)
          if (v !== null) last = asPct(v)
        }
        if (last !== null) throttle.push(last)
      }
      const processGone = untilExitPid !== undefined && !isAlive(untilExitPid)
      const idleTimedOut = untilExitPid === undefined && Date.now() - lastChangeAt >= idleMs
      if (processGone || idleTimedOut) {
        clearInterval(timer)
        throttle.flush()
        resolveP(0)
      }
    }
    const timer = setInterval(tick, 300)
    tick()
  })
}

/** `pytest ... | decs progress --parse pytest` — tees stdin to stdout so the pipe stays useful for its own sake. */
async function runStdin(args: Args): Promise<number> {
  resolveNodeRef(args) // fail fast on a missing NODDIT_NODE before touching stdin at all
  if (process.stdin.isTTY) {
    throw new Error(t('cli.progress.noInput'))
  }
  const parse = makeParser(args)
  const { store, item } = storeAndItem(args)
  const explicitMsg = one(args, 'msg')
  const throttle = createThrottle<{ pct: number; msg?: string }>(5000, ({ pct, msg }) => {
    store.progress(item, { progress: pct, progressMsg: explicitMsg ?? msg })
  })

  return new Promise<number>((resolveP) => {
    const rl = createInterface({ input: process.stdin, terminal: false })
    rl.on('line', (line) => {
      process.stdout.write(`${line}\n`)
      const v = parse(line)
      if (v !== null) throttle.push(asPct(v))
    })
    rl.on('close', () => {
      throttle.flush()
      resolveP(0)
    })
  })
}

export async function run(args: Args): Promise<number> {
  if (bool(args, 'help', 'h')) {
    console.log(help())
    return 0
  }
  if (one(args, 'count-lines')) return runCountLines(args)
  if (one(args, 'from-file')) return runFromFile(args)

  const [first, ...rest] = args._
  if (first !== undefined && /^\d+(\.\d+)?$/.test(first)) {
    const pct = Number(first)
    const msg = rest.join(' ') || one(args, 'msg')
    const { store, item } = storeAndItem(args)
    const next = store.progress(item, { progress: pct, progressMsg: msg })
    report(next, args)
    return 0
  }

  return runStdin(args)
}
