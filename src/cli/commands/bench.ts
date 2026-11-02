import { existsSync } from 'node:fs'
import { defOf, viewFromArg } from '../../tui/views.ts'
import { validateView } from '../../core/view-defs.ts'
import { MOUSE_OFF, MOUSE_ON } from '../../tui/mouse.ts'
import { settingValue } from '../../core/settings.ts'
import { t } from '../../i18n/index.ts'
import { bool, one, type Args } from '../args.ts'
import { requireDecision, resolveStore } from '../context.ts'

const ALT_ON = '\x1b[?1049h'
const ALT_OFF = '\x1b[?1049l'

export async function run(args: Args): Promise<number> {
  if (bool(args, 'help', 'h')) {
    console.log(t('bench.help'))
    return 0
  }
  if (bool(args, 'json')) {
    const { benchJson, nodeDetailJson } = await import('../../tui/json.ts')
    const ref = one(args, 'node')
    const store = resolveStore(args, { allowRegistry: true, preferRegistry: true, positionalDirs: !ref })
    if (ref) {
      console.log(JSON.stringify(nodeDetailJson(store, requireDecision(store, ref, args))))
      return 0
    }
    // A window polling this is a bench too: deferrals whose day has come end here.
    let back: Awaited<ReturnType<typeof store.returnDueDeferrals>> = []
    try {
      back = store.returnDueDeferrals()
    } catch {
      /* the next read tries again */
    }
    // --view <id>: that tab alone; --def '<json>': a definition not saved yet (a view editor's live preview).
    const def = one(args, 'def')
    const only = def ? [validateView(JSON.parse(def))] : one(args, 'view') ? [defOf(viewFromArg(one(args, 'view')))] : undefined
    console.log(JSON.stringify(benchJson(store, { project: one(args, 'project', 'p'), back, views: only })))
    return 0
  }
  if (!process.stdout.isTTY) {
    console.error(t('bench.cli.needsTty'))
    return 1
  }

  const store = resolveStore(args, { allowRegistry: true, preferRegistry: true, positionalDirs: true })
  for (const l of store.layouts) {
    if (!existsSync(l.activeDir)) process.emitWarning(t('bench.cli.noActiveDir', { root: l.projectRoot }))
  }

  // --scope is the name from before views; its values map onto them.
  const viewArg = one(args, 'view') ?? one(args, 'scope')
  const view = viewFromArg(viewArg ?? settingValue('view').value)
  // 延迟 is a fold row in 等待: --view deferred opens 等待 with it open.
  const openDeferred = viewArg === 'deferred' || viewArg === 'defer'

  // The alternate screen is entered here rather than inside the app so that
  // every exit path below — clean, signal, or throw — restores it exactly once.
  const [{ createElement: h }, { render }, { App }] = await Promise.all([import('react'), import('ink'), import('../../tui/app.ts')])
  let restored = false
  const restore = () => {
    if (restored) return
    restored = true
    process.stdout.write(`${MOUSE_OFF}\x1b[?25h${ALT_OFF}`)
  }
  process.stdout.write(ALT_ON + (settingValue('mouse').value === 'on' ? MOUSE_ON : ''))

  const instance = render(h(App, { store, view, openDeferred, project: one(args, 'project', 'p') }), {
    exitOnCtrlC: true,
    // Rewrites only the lines that changed, not the whole screen.
    incrementalRendering: true,
  })

  const onSignal = () => {
    instance.unmount()
    restore()
    process.exit(130)
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  try {
    await instance.waitUntilExit()
    return 0
  } finally {
    restore()
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}
