import { basename, resolve } from 'node:path'
import { bool, many, one, type Args } from '../args.ts'
import { refOf } from '../../core/ref.ts'
import { requireDecision, resolveAuthor, resolveStore } from '../context.ts'
import { dim } from '../../core/render.ts'
import { t } from '../../i18n/index.ts'

const help = () => t('cli.help.attach')

/** Best-effort — an interactive owner with no configured author still gets
 *  the simplest default (the body) rather than an error. */
function attachingAuthor(args: Args): string | undefined {
  try {
    return resolveAuthor(args)
  } catch {
    return undefined
  }
}

export function run(args: Args): number {
  if (bool(args, 'help', 'h')) {
    console.log(help())
    return 0
  }
  const [ref, ...sources] = args._
  const move = one(args, 'move')
  if (!ref || (!sources.length && !move)) throw new Error(`${t('cli.attach.usage')}\n\n${help()}`)

  const store = resolveStore(args, { allowRegistry: true })
  const d = requireDecision(store, ref, args)
  // --move <file> --to <section>: list an attachment under another section; the file and its approval stay.
  if (move) {
    const to = one(args, 'to')
    if (!to) throw new Error(t('cli.attach.moveNeedsTo'))
    store.moveAttachment(d, move, to)
    console.log(t('cli.attach.moved', { ref: refOf(d), name: basename(move), to }))
    return 0
  }
  const groups = many(args, 'label')
  const captions = many(args, 'caption')
  const approvalContent = bool(args, 'approval-content')
  const approveOn = many(args, 'approve-on').flatMap((v) => v.split(/[,，\s]+/)).filter(Boolean)

  const next = store.attach(d, sources, {
    link: bool(args, 'link'),
    name: one(args, 'name'),
    replace: bool(args, 'replace'),
    groups: groups.length ? groups : undefined,
    captions: captions.length ? captions : undefined,
    approvalContent,
    approveOn: approveOn.length ? approveOn : undefined,
    to: one(args, 'to'),
    by: attachingAuthor(args),
  })

  for (const src of sources) {
    const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(src)
    const match = isUrl
      ? next.attachments.find((a) => a.target === src)
      : next.attachments.find((a) => a.target === resolve(src) || basename(a.target) === basename(src))
    if (!match) continue
    const hist = store.historyCount(next, match)
    const bits = [`${refOf(next)} + ${match.target}`]
    if (hist) bits.push(dim(t('cli.get.historyVersion', { n: hist })))
    if (approvalContent) {
      const approval = store.findApproval(next, match.target)
      if (approval) bits.push(dim(t('cli.attach.pending', { approveOn: approval.approveOn?.join(' / '), hash: approval.hash })))
    }
    console.log(bits.join('  '))
  }
  return 0
}
