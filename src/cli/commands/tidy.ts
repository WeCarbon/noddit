import { isHumanTask } from '../../core/assignee.ts'
import { refOf } from '../../core/ref.ts'
import { alignRow, cyan, dim, toJSON, yellow } from '../../core/render.ts'
import { statusLabel } from '../../core/status.ts'
import { ownedBy } from '../../core/store.ts'
import { isAuthorListening, recordTidyAck, tidyFindings, type TidyFinding } from '../../core/tidy.ts'
import type { Decision } from '../../core/types.ts'
import { bool, one, type Args } from '../args.ts'
import { resolveAuthor, resolveStore } from '../context.ts'
import { t } from '../../i18n/index.ts'

const help = () => t('cli.help.tidy')

/**
 * `nod tidy` — this session's own tree, with everywhere its state and its
 * subtree disagree marked (`core/tidy.ts`'s `tidyFindings`). Always records
 * the ack (N189's `recordTidyAck`), even with nothing to mark — that's what
 * resets `nod monitor`'s own NODDIT-TIDY clock.
 */
export async function run(args: Args): Promise<number> {
  if (bool(args, 'help', 'h')) {
    console.log(help())
    return 0
  }
  const store = resolveStore(args, { allowRegistry: true })
  const author = one(args, 'author') ?? (bool(args, 'mine') ? resolveAuthor(args) : undefined)

  const items = store.all()
  const findings = tidyFindings(items, (d, name) => isAuthorListening(store.layoutOf(d).projectRoot, name))
  // A node can carry more than one finding at once (e.g. its children are all
  // done AND its author has no live monitor) — key by node, value is every
  // finding on it, never just the last one written.
  const findingsByKey = new Map<string, TidyFinding[]>()
  for (const f of findings) {
    const key = `${f.project}#${f.id}`
    findingsByKey.set(key, [...(findingsByKey.get(key) ?? []), f])
  }

  for (const l of store.layouts) recordTidyAck(l, author)

  const inScope = (d: Decision) => (author ? ownedBy(d, author) : !isHumanTask(d))
  const scoped = new Set(items.filter(inScope).map((d) => `${d.project}#${d.id}`))
  const byKey = new Map(items.map((d) => [`${d.project}#${d.id}`, d]))
  const kidsOf = (d: Decision): Decision[] =>
    (d.children ?? [])
      .map((id) => byKey.get(`${d.project}#${id}`))
      .filter((k): k is Decision => Boolean(k && scoped.has(`${k.project}#${k.id}`)))
      .sort((a, b) => a.id - b.id)
  const roots = items
    .filter((d) => scoped.has(`${d.project}#${d.id}`) && (d.parent === undefined || !scoped.has(`${d.project}#${d.parent}`)))
    .sort((a, b) => a.id - b.id)

  if (bool(args, 'json')) {
    const nest = (d: Decision): Record<string, unknown> => ({
      ...toJSON(d),
      body: undefined,
      tidy: (findingsByKey.get(`${d.project}#${d.id}`) ?? []).map((f) => f.kind),
      children: kidsOf(d).map(nest),
    })
    console.log(JSON.stringify(roots.map(nest)))
    return 0
  }
  if (!roots.length) {
    console.log(t('cli.tidy.none'))
    return 0
  }
  const lines: string[] = []
  const markOf = (f: TidyFinding): string => {
    const text = t(`cli.tidy.kind.${f.kind}`, { author: f.author ?? '' })
    return yellow(` ◆ ${text}`)
  }
  const draw = (d: Decision, prefix: string, last: boolean, top: boolean) => {
    const marks = (findingsByKey.get(`${d.project}#${d.id}`) ?? []).map(markOf).join('')
    lines.push(`${prefix}${top ? '' : last ? '└─ ' : '├─ '}${cyan(refOf(d))} · ${dim(statusLabel(d.state))} · ${d.title}${marks}`)
    const kids = kidsOf(d)
    kids.forEach((k, i) => draw(k, top ? '' : prefix + (last ? '   ' : '│  '), i === kids.length - 1, false))
  }
  for (const r of roots) draw(r, '', true, true)
  console.log(lines.map((l) => alignRow(l)).join('\n'))
  return 0
}
