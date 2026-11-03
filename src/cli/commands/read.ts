import { isAnswerKind, NOTE_KIND } from '../../core/format.ts'
import { bool, one, type Args } from '../args.ts'
import { refOf } from '../../core/ref.ts'
import { requireDecision, resolveAuthor, resolveStore } from '../context.ts'
import { bold, dim, green, toJSON } from '../../core/render.ts'
import { renderAnswerLines } from '../../core/questions.ts'
import { checkSummary } from '../../core/summary.ts'
import type { Decision } from '../../core/types.ts'
import { t } from '../../i18n/index.ts'

const help = () => t('cli.help.read')

function describe(d: Decision): string {
  const chosen = d.options.find((o) => o.key === d.answer?.choice)
  const lines: string[] = [`${bold(refOf(d))}${d.project ? ` ${dim(d.project)}` : ''} · ${d.title}`]

  if (d.status === 'answered') {
    lines.push(`${green(t('cli.read.answered', { choice: d.answer?.choice ? ` ${d.answer.choice}` : '' }))}${chosen?.label ? ` —— ${chosen.label}` : ''}`)
    if (chosen?.body) lines.push(dim(chosen.body))
    // Sub-question nodes: the headline above is just "2 —— 逐条回复（…）" — the
    // actual per-question picks, including any 「其他」free text, live here.
    if (d.questions?.length && d.answer?.answers) lines.push(renderAnswerLines(d.questions, d.answer.answers, d.answer.answerNotes))
    if (d.answer?.note) lines.push('', `${d.answer.by}：${d.answer.note}`)
  }

  // A follow-up is delivered by showing the tail of the entry from the owner's
  // latest non-answer section on, because that is where it was appended — and
  // only a human's: a lane's own 补充 is not what it is being woken up for.
  const followUp = [...d.notes].reverse().find((n) => n.role === 'human' && !isAnswerKind(n.kind))
  const at = followUp ? d.body.indexOf(`## ${followUp.heading}`) : -1
  if (at !== -1) lines.push('', d.body.slice(at).trim())

  lines.push('', dim(t('cli.read.fullTextHint', { id: d.id, file: d.file })))
  return lines.join('\n')
}

export function run(args: Args): number {
  if (bool(args, 'help', 'h')) {
    console.log(help())
    return 0
  }

  const store = resolveStore(args, { allowRegistry: true })
  const author = one(args, 'author') ?? (bool(args, 'mine') ? resolveAuthor(args) : undefined)

  if (!args._.length) {
    const q = store.queue({ author, project: one(args, 'project', 'p') })
    console.error(q.length ? `${t('cli.read.whichOne', { refs: q.map((d) => refOf(d)).join(' ') })}\n\n${help()}` : t('cli.queue.empty'))
    return 1
  }

  const picked = args._.map((ref) => requireDecision(store, ref, args))
  const notQueued = picked.filter((d) => !d.queued)
  if (notQueued.length) {
    throw new Error(t('cli.read.notQueued', { refs: notQueued.map((d) => refOf(d)).join(' ') }))
  }

  const asJson = bool(args, 'json')
  if (bool(args, 'peek')) {
    console.log(asJson ? JSON.stringify(picked.map(toJSON)) : picked.map(describe).join('\n\n'))
    return 0
  }

  const done = bool(args, 'done')
  // Checked before anything is collected, so a refusal leaves the queue as it was.
  // A follow-up alone moves a node to 待 AI 取走 too, so the state cannot tell
  // "answered" from "the owner only asked something" — the answer field can.
  const unanswered = done ? picked.filter((d) => d.state === 'needs_decision' || (d.options.length > 0 && !d.answer)) : []
  if (unanswered.length) {
    throw new Error(t('cli.read.cantDoneUnanswered', { refs: unanswered.map((d) => refOf(d)).join(' ') }))
  }
  const ack = one(args, 'ack')
  // Checked before anything is collected (N203/N205): --ack already always
  // writes its note through `store.note`, which enforces this — but that
  // write comes *after* `store.deliver` below, which already dequeued the
  // item by then. Failing here first keeps a bad --ack from leaving a node
  // delivered with no note to show for it.
  const summary = ack ? checkSummary(ack, one(args, 'summary'), 'agent') : one(args, 'summary')
  const delivered = picked.map((d) => {
    const got = store.deliver(d)
    const filed = done && !got.archived ? store.archive(got) : got
    const noted = ack ? store.note(filed, { text: ack, role: 'agent', author: resolveAuthor(args), kind: NOTE_KIND.received, summary }) : filed
    return { ...noted, options: d.options, body: noted.body, notes: noted.notes }
  })

  if (asJson) {
    console.log(JSON.stringify(delivered.map(toJSON)))
    return 0
  }
  console.log(delivered.map(describe).join('\n\n'))
  if (done) console.log(dim(`\n${t('cli.read.archivedHint', { refs: delivered.map((d) => refOf(d)).join(' ') })}`))
  else console.log(dim(`\n${t('cli.read.doneNextHint', { ids: delivered.map((d) => d.id).join(' ') })}`))
  for (const d of delivered) if (d.intake && d.answer) console.log(dim(t('cli.read.briefNext', { ref: refOf(d) })))
  // The owner can see a reply; collecting without one is easy to forget (N47).
  if (!ack) console.log(dim(`\n${t('cli.read.ackHint', { refs: delivered.map((d) => refOf(d)).join(' ') })}`))

  const left = store.queue({ author, project: one(args, 'project', 'p') })
  if (left.length) console.log(dim(t('cli.read.leftInQueue', { count: left.length, refs: left.map((d) => refOf(d)).join(' ') })))
  return 0
}
