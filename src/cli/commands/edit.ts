import { bool, one, type Args } from '../args.ts'
import { readStdin, requireDecision, resolveAuthor, resolveStore, shellRole } from '../context.ts'
import { refOf } from '../../core/ref.ts'
import { toJSON } from '../../core/render.ts'
import { t } from '../../i18n/index.ts'
import { dueOf, everyArg } from './send.ts'

const help = () => t('cli.help.edit')

const FIELDS = ['every', 'due'] as const
const CLEAR = new Set(['off', 'none', 'no', '-', ''])

/** `nod edit <id> --every 3d --due fri` (`off` clears one): the node's own fields, not its text. */
function editFields(args: Args, ref: string): number {
  const raw = (k: (typeof FIELDS)[number]) => {
    const v = one(args, k)
    return v === undefined ? undefined : CLEAR.has(v.trim().toLowerCase()) ? null : v
  }
  const every = raw('every')
  const due = raw('due')
  const store = resolveStore(args, { allowRegistry: true })
  const d = requireDecision(store, ref, args)
  const next = store.setFields(d, { every: every === null ? null : everyArg(every), due: due === null ? null : dueOf(due) })
  if (bool(args, 'json')) console.log(JSON.stringify({ ...toJSON(next), changed: next !== d }))
  else console.log(t('cli.edit.fields', { ref: refOf(next), what: fieldsText(next) }))
  return 0
}

function fieldsText(d: { every?: string; due?: string }): string {
  return [
    d.every ? t('cli.edit.every', { every: d.every }) : t('cli.edit.noEvery'),
    d.due ? t('cli.edit.due', { due: d.due.slice(0, 16).replace('T', ' ') }) : t('cli.edit.noDue'),
  ].join(' · ')
}

/**
 * `nod edit <id> --body` / `--note <n>`: the new text on stdin replaces that part of the
 * node and nothing else. `--expect <updated_at>` refuses if the node changed since.
 */
export async function run(args: Args): Promise<number> {
  if (bool(args, 'help', 'h')) {
    console.log(help())
    return 0
  }
  const [ref] = args._
  const noteRaw = one(args, 'note')
  if (ref && !bool(args, 'body') && noteRaw === undefined && FIELDS.some((f) => one(args, f) !== undefined)) return editFields(args, ref)
  if (!ref || (!bool(args, 'body') && noteRaw === undefined)) throw new Error(`${t('cli.edit.which')}\n\n${help()}`)
  const note = noteRaw === undefined ? undefined : Number(noteRaw)
  if (note !== undefined && (!Number.isInteger(note) || note < 1)) throw new Error(t('cli.edit.badNote', { value: noteRaw }))
  const text = one(args, 'text') ?? (await readStdin())
  const store = resolveStore(args, { allowRegistry: true })
  const d = requireDecision(store, ref, args)
  const role = bool(args, 'human') ? 'human' : bool(args, 'agent') ? 'agent' : shellRole()
  const by = one(args, 'by') ?? (role === 'human' ? 'owner' : resolveAuthor(args))
  const next = store.edit(d, { text, note, expect: one(args, 'expect'), by, role, force: bool(args, 'force') })
  if (bool(args, 'json')) console.log(JSON.stringify({ ...toJSON(next), changed: next !== d }))
  else console.log(next === d ? t('cli.edit.unchanged', { ref: refOf(d) }) : t('cli.edit.done', { ref: refOf(d) }))
  return 0
}
