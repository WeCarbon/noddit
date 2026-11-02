import { bool, one, type Args } from '../args.ts'
import { noteKindKey } from '../../core/format.ts'
import { refOf } from '../../core/ref.ts'
import { readStdin, requireDecision, resolveAuthor, resolveStore, shellRole } from '../context.ts'
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
  const [ref, ...rest] = args._
  if (!ref) throw new Error(t('cli.note.whichOne'))

  const text = rest.join(' ') || one(args, 'text') || (await readStdin()).trim()
  if (!text) throw new Error(t('cli.note.nothingToAdd'))

  const store = resolveStore(args, { allowRegistry: true })
  const d = requireDecision(store, ref, args)

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
  const next = store.note(d, { text, role, author, kind: one(args, 'heading') })
  // A note like 「等 Dave 推新版」 leaves the node 执行中, and the bench
  // never shows it is held up outside. Point at hold.
  if (role === 'agent' && next.state === 'in_progress' && /(^|[，。；：:])\s*(在等|等(?!待))\s?[^\s，。]{1,20}/.test(text)) {
    process.stderr.write(`${t('cli.note.holdHint', { ref: refOf(next), id: next.id })}\n`)
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
