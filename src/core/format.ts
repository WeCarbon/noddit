/**
 * The tokens decs writes into `decisions/*.md` and reads back. They are part of
 * the file format, not UI text: they stay byte-identical whatever language the
 * CLI speaks, so repos written by mixed-language teams keep parsing. Display
 * names for them live in the locale files (`noteKind.*`).
 */

export const HEADING = {
  options: '选项',
  attachments: '附件',
  questions: '子问题',
} as const

/** `## 选项（第 2 轮）` — what `decs ask` writes for a re-decision. */
export function optionsHeading(round = 1): string {
  return round > 1 ? `${HEADING.options}（第 ${round} 轮）` : HEADING.options
}

/** The word in an appended `## <kind>（role · author · time）` heading. */
export const NOTE_KIND = {
  answered: '已答',
  followUp: '追问',
  reply: '回复',
  addendum: '补充',
  seen: '已看过',
  log: '执行记录',
  waiting: '等待',
  deferred: '延迟',
  undeferred: '解除延迟',
  completed: '完成',
  superseded: '被取代',
  newQuestion: '新问题',
  original: '原话',
  claimed: '接活',
  heartbeat: '心跳',
  received: '已收到',
} as const

export type NoteKindKey = keyof typeof NOTE_KIND

/** The canonical kind word → its key, for looking up a display name. */
export function noteKindKey(kind: string): NoteKindKey | undefined {
  return (Object.keys(NOTE_KIND) as NoteKindKey[]).find((k) => NOTE_KIND[k] === kind)
}

/** An answer, as opposed to a reply or note: it settles the question. */
export function isAnswerKind(kind: string): boolean {
  return kind === NOTE_KIND.answered || kind === NOTE_KIND.seen
}

/** Option labels decs generates; `kind` detection matches them exactly. */
export const OPTION_LABEL = {
  accept: '验收通过',
  fyi: '知道了',
  reviewPass: '通过',
  reviewFail: '不通过',
  reviewChange: '改（答复里写改法）',
} as const

export function allDefaultsLabel(defaults: string): string {
  return `全部按默认（${defaults}）`
}

export function itemByItemLabel(keys: string): string {
  return `逐条回复（${keys}）`
}

/** Marks a sub-question answer that took the default in the `## 已答` text. */
export const DEFAULT_MARK = '（默认）'

/** Bodies decs writes under the notes it appends itself. */
export const NOTE_TEXT = {
  waitingOn: (on: string) => `等 ${on}`,
  deferred: '后面再做。解除延迟之前先别动它。',
  undeferred: '可以接着做了。',
  seen: '看过了，不用处理。',
  seenAnswer: '看过了，不用处理',
  dependencyDone: (ref: string) => `${ref} 已完成，这个节点的决定早已取走，开始执行。`,
  supersededBy: (ref: string, title: string) => `被 ${ref} 取代：${title}`,
  declinedTextOnly: '只写了文字，没选选项',
  claimed: '接了。展开、拆成子节点后请负责人确认，确认前不开工。',
} as const

/** `<!-- /分组 -->` — ends an attachment group; invisible in a markdown viewer. */
export const ATTACHMENT_GROUP_END = '<!-- /分组 -->'
