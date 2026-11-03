import { bool, many, one, type Args } from '../args.ts'
import { noteKindKey } from '../../core/format.ts'
import { refOf } from '../../core/ref.ts'
import { hasSessionNode, looksLikeRef, readStdin, requireDecision, resolveAuthor, resolveStore, sessionNode, shellRole } from '../context.ts'
import { checkSummary } from '../../core/summary.ts'
import type { NoteRole } from '../../core/types.ts'
import { t } from '../../i18n/index.ts'

const help = () => t('cli.help.note')

function kindLabel(kind: string): string {
  const key = noteKindKey(kind)
  return key ? t(`common.noteKind.${key}`) : kind
}

/**
 * A follow-up that does not settle anything: the owner asking for more, or a
 * lane recording what it did after the fact. Without a flag the role comes
 * from who is running it (`shellRole`), so an agent's note never gets
 * mistaken for an owner request, and vice versa. The owner asking something
 * about an archived entry brings it back to `active/`; an agent's note
 * never does.
 */
export async function run(args: Args): Promise<number> {
  if (bool(args, 'help', 'h')) {
    console.log(help())
    return 0
  }
  // No id in front (`nod note "text"`, or nothing but a piped body): this session's node.
  const implicit = !args._.length || !looksLikeRef(args._[0])
  if (implicit && !hasSessionNode()) throw new Error(t('cli.note.whichOne'))
  const ref = implicit ? undefined : args._[0]
  const rest = implicit ? args._ : args._.slice(1)

  const text = rest.join(' ') || one(args, 'text') || (await readStdin()).trim()
  if (!text) throw new Error(t('cli.note.nothingToAdd'))

  const store = resolveStore(args, { allowRegistry: true })
  const d = ref ? requireDecision(store, ref, args) : sessionNode(store, args)
  if (!d) throw new Error(t('cli.note.whichOne'))

  const explicitBy = one(args, 'by')
  const roleFlag = one(args, 'role')
  if (roleFlag && roleFlag !== 'human' && roleFlag !== 'agent') throw new Error(t('cli.note.badRole'))
  // `--by owner` is how scripts written before roles said "this is the owner".
  if (bool(args, 'human') && bool(args, 'agent')) throw new Error(t('cli.note.humanOrAgentOnly'))
  const role: NoteRole =
    bool(args, 'human') || roleFlag === 'human' || (!roleFlag && !bool(args, 'agent') && explicitBy === 'owner')
      ? 'human'
      : bool(args, 'agent') || roleFlag === 'agent'
        ? 'agent'
        : shellRole()
  const author = explicitBy ?? (role === 'human' ? one(args, 'author', 'a') ?? 'owner' : resolveAuthor(args))

  const same = role === 'human' ? store.recentSameHumanNote(d, text) : undefined
  if (same) {
    console.log(t('cli.note.alreadyRecorded', { ref: refOf(d), by: same.author }))
    return 0
  }
  // N203/N205: checked here, not inside Store.note — that's a shared primitive
  // other writers use too (nod run's own failure note has no --summary of its own
  // and is routinely over the budget), so only this command's own writes enforce it.
  const summary = checkSummary(text, one(args, 'summary'), role)
  const sources = many(args, 'attach')
  const groups = many(args, 'label')
  const captions = many(args, 'caption')
  const approvalContent = bool(args, 'approval-content')
  const approveOn = many(args, 'approve-on').flatMap((v) => v.split(/[,，\s]+/)).filter(Boolean)
  const next = store.note(d, {
    text,
    role,
    author,
    kind: one(args, 'heading'),
    summary,
    attach: sources.length
      ? {
          sources,
          link: bool(args, 'link'),
          name: one(args, 'name'),
          groups: groups.length ? groups : undefined,
          captions: captions.length ? captions : undefined,
          approvalContent,
          approveOn: approveOn.length ? approveOn : undefined,
        }
      : undefined,
  })
  // A note like 「等 Dave 推新版」 or "waiting on Dave" leaves the node 执行中, and the bench
  // never shows it is held up outside. Point at hold.
  if (role === 'agent' && next.state === 'in_progress' && (/(^|[，。；：:])\s*(在等|等(?!待))\s?[^\s，。]{1,20}/.test(text) || /\b(waiting (on|for)|blocked on)\b/i.test(text))) {
    process.stderr.write(`${t('cli.note.holdHint', { ref: refOf(next), id: next.id })}\n`)
  }
  // 「留给后续 session」, "owner must add …": something only the owner can do, written where they never look.
  if (role === 'agent' && (/(留给(后续|之后|下一个)?\s*(session|会话)|等(负责人|owner|你)|需要(负责人|你)(来)?(做|处理|决定|确认|提供|登录|下载|添加))/i.test(text) || /\b(owner (must|to|needs to|should)|left for (a )?(later|next|future) session|needs? the owner)\b/i.test(text))) {
    process.stderr.write(`${t('cli.note.ownerHint', { ref: refOf(next), id: next.id })}\n`)
  }
  const revived = d.archived && !next.archived
  const kind = next.notes[next.notes.length - 1]?.kind ?? ''
  console.log(
    t('cli.note.appended', { ref: refOf(next), kind: kindLabel(kind), role }) +
      (revived ? t('cli.note.revived') : '') +
      (role === 'human' ? t('cli.note.queued') : ''),
  )
  return 0
}
