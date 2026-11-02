import { bool, one, type Args } from '../args.ts'
import { requireDecision, resolveStore } from '../context.ts'
import { refOf } from '../../core/ref.ts'
import { alignRow, cyan, dim, toJSON, yellow } from '../../core/render.ts'
import { isStartable, isTerminal, rollup, statusLabel } from '../../core/status.ts'
import { type Decision } from '../../core/types.ts'
import { t } from '../../i18n/index.ts'

const help = () => t('cli.help.tree')

export function run(args: Args): number {
  if (bool(args, 'help', 'h')) {
    console.log(help())
    return 0
  }
  const store = resolveStore(args, { allowRegistry: true })
  const items = store.all()
  const byKey = new Map(items.map((d) => [`${d.project}#${d.id}`, d]))
  const kidsOf = (d: Decision) =>
    (d.children ?? []).map((id) => byKey.get(`${d.project}#${id}`)!).filter(Boolean).sort((a, b) => a.id - b.id)

  let roots: Decision[]
  if (args._[0]) {
    const picked = requireDecision(store, args._[0], args)
    roots = [byKey.get(`${picked.project}#${picked.id}`) ?? picked]
  } else {
    roots = items.filter((d) => d.parent === undefined && (bool(args, 'all') || !d.archived))
    const project = one(args, 'project', 'p')
    if (project) roots = roots.filter((d) => d.project === store.projectKey(project))
  }

  if (bool(args, 'json')) {
    const nest = (d: Decision): Record<string, unknown> => ({ ...toJSON(d), body: undefined, children: kidsOf(d).map(nest) })
    console.log(JSON.stringify(roots.map(nest)))
    return 0
  }
  if (!roots.length) {
    console.log(t('cli.tree.none'))
    return 0
  }
  const lines: string[] = []
  const draw = (d: Decision, prefix: string, last: boolean, top: boolean) => {
    const r = rollup(d, items)
    // A completed/closed node is done regardless of what its `after` deps do
    // later (one reopened after the fact, say) — never show it waiting.
    const marks = [
      d.state === 'needs_decision' ? yellow(statusLabel(d.state)) : dim(statusLabel(d.state)),
      !isTerminal(d.state) && d.after?.length && !isStartable(d, items) ? dim(t('cli.tree.waitingOnDeps')) : null,
      r.needsOwner ? yellow('◆') : null,
    ].filter(Boolean)
    lines.push(`${prefix}${top ? '' : last ? '└─ ' : '├─ '}${cyan(refOf(d))} · ${marks.join(' ')} · ${d.title}`)
    const kids = kidsOf(d)
    kids.forEach((k, i) => draw(k, top ? '' : prefix + (last ? '   ' : '│  '), i === kids.length - 1, false))
  }
  for (const r of roots) draw(r, '', true, true)
  console.log(lines.map((l) => alignRow(l)).join('\n'))
  return 0
}
