import { bidiOutput } from '../i18n/bidi.ts'
import { LANGUAGES, initLang, isRtl, normalizeLang, t, takeLangFlag } from '../i18n/index.ts'
import { parseArgs, type Args } from './args.ts'

export interface CommandModule {
  /** `name` is the word typed, for modules that serve several verbs. */
  run(args: Args, name: string): Promise<number> | number
}

/** Commands load on demand, so `nod get` doesn't pay for the TUI or migrator. */
const COMMANDS: Record<string, () => Promise<CommandModule>> = {
  init: () => import('./commands/init.ts'),
  setup: () => import('./commands/setup.ts'),
  send: () => import('./commands/send.ts'),
  add: () => import('./commands/send.ts'),
  new: () => import('./commands/send.ts'),
  get: () => import('./commands/get.ts'),
  show: () => import('./commands/show.ts'),
  list: () => import('./commands/show.ts'),
  push: () => import('./commands/push.ts'),
  choose: () => import('./commands/push.ts'),
  answer: () => import('./commands/push.ts'),
  queue: () => import('./commands/queue.ts'),
  read: () => import('./commands/read.ts'),
  pop: () => import('./commands/read.ts'),
  archive: () => import('./commands/archive.ts'),
  note: () => import('./commands/note.ts'),
  pin: () => import('./commands/pin.ts'),
  flag: () => import('./commands/flag.ts'),
  attach: () => import('./commands/attach.ts'),
  approved: () => import('./commands/approved.ts'),
  open: () => import('./commands/open.ts'),
  check: () => import('./commands/check.ts'),
  wait: () => import('./commands/wait.ts'),
  changes: () => import('./commands/changes.ts'),
  watch: () => import('./commands/watch.ts'),
  source: () => import('./commands/source.ts'),
  bench: () => import('./commands/bench.ts'),
  migrate: () => import('./commands/migrate.ts'),
  projects: () => import('./commands/projects.ts'),
  retitle: () => import('./commands/retitle.ts'),
  after: () => import('./commands/after.ts'),
  start: () => import('./commands/lifecycle.ts'),
  done: () => import('./commands/lifecycle.ts'),
  close: () => import('./commands/lifecycle.ts'),
  ask: () => import('./commands/lifecycle.ts'),
  hold: () => import('./commands/lifecycle.ts'),
  defer: () => import('./commands/defer.ts'),
  undefer: () => import('./commands/defer.ts'),
  assign: () => import('./commands/assign.ts'),
  date: () => import('./commands/date.ts'),
  views: () => import('./commands/views.ts'),
  view: () => import('./commands/views.ts'),
  monitor: () => import('./commands/monitor.ts'),
  tree: () => import('./commands/tree.ts'),
  supersede: () => import('./commands/supersede.ts'),
  search: () => import('./commands/search.ts'),
  move: () => import('./commands/move.ts'),
  config: () => import('./commands/config.ts'),
  folders: () => import('./commands/projects.ts'),
  folder: () => import('./commands/projects.ts'),
  progress: () => import('./commands/progress.ts'),
  steps: () => import('./commands/steps.ts'),
  claim: () => import('./commands/claim.ts'),
  expand: () => import('./commands/expand.ts'),
  briefs: () => import('./commands/briefs.ts'),
  session: () => import('./commands/session.ts'),
  sessions: () => import('./commands/session.ts'),
  step: () => import('./commands/steps.ts'),
  whoami: () => import('./commands/whoami.ts'),
  beat: () => import('./commands/beat.ts'),
}

const usage = () => t('cli.usage')

/**
 * What to run: a bare `nod` on a terminal opens the bench; piped or
 * scripted, it prints the usage instead, as `--help` does.
 */
export function commandFor(given: string | undefined, isTTY: boolean): string {
  if (given === undefined) return isTTY ? 'bench' : 'help'
  return given === '--help' || given === '-h' ? 'help' : given
}

export async function main(input: string[]): Promise<number> {
  const { argv, lang: flag } = takeLangFlag(input)
  if (flag !== undefined && !normalizeLang(flag)) {
    initLang()
    console.error(`nod: ${t('common.lang.unknown', { code: flag, codes: LANGUAGES.join(' ') })}`)
    return 2
  }
  initLang(flag)
  bidiOutput(argv, isRtl())
  const [given, ...rest] = argv
  const name = commandFor(given, Boolean(process.stdout.isTTY))
  if (name === 'help') {
    console.log(usage())
    return 0
  }
  if (name === '--version' || name === '-v') {
    console.log('nod 0.1.0')
    return 0
  }
  const load = COMMANDS[name]
  if (!load) {
    console.error(t('cli.unknownCommand', { name, usage: usage() }))
    return 2
  }
  try {
    const mod = await load()
    return await mod.run(parseArgs(rest), name)
  } catch (e) {
    console.error(`nod ${name}: ${(e as Error).message}`)
    return 1
  }
}
