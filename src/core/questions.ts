import { OPTION_LABEL, allDefaultsLabel, itemByItemLabel, questionsHeading } from './format.ts'
import type { DecisionOption } from './types.ts'
import { t } from '../i18n/index.ts'

/**
 * Sub-questions: one node, several small questions, each with its own
 * options. Before this existed, several small questions on one node meant
 * typing a free-text answer like 「Q1=B Q2=2」 into a reply for an agent to
 * parse.
 *
 * In the body (so a markdown viewer still reads it):
 *
 *   ## 子问题
 *
 *   ### Q1 · 选哪个 CDN
 *   （为什么要问）
 *
 *   #### A · 继续用现在的
 *   #### B · 换新的
 *
 * Each question's default is front matter `question_defaults: {Q1: A}` — like
 * `default`, a fact for machines, kept out of the prose. The node's own
 * `## 选项` is two generated choices, 「1 · 全部按默认」 and 「2 · 逐条回复」,
 * so a bench that knows nothing about sub-questions can still settle one with
 * a single key.
 */
export interface DecisionQuestion {
  /** `Q1`, `R3` — one capital letter and a number. */
  key: string
  label: string
  body: string
  options: DecisionOption[]
  default?: string
}

export const QUESTION_KEY_RE = /^[A-Z]\d{1,3}$/
/** `## 子问题（第 2 轮）` — only the suffix differs from `OPTIONS_HEADING_RE`
 *  in `core/parse.ts`; group 2 is the round, absent meaning round 1. */
export const QUESTIONS_HEADING_RE = /^##[ \t]+(子问题|Questions)(?:[（(]第[ \t]*(\d+)[ \t]*轮[）)])?[ \t　]*[:：]?[ \t]*$/
const QUESTION_RE = /^###[ \t]+([A-Z]\d{1,3})[ \t]*(?:[·:：．.\-—–]{1,2}[ \t]*(.*))?$/
const SUB_OPTION_RE = /^####[ \t]+([A-Za-z0-9]{1,4})[ \t]*(?:[·:：．.\-—–]{1,2}[ \t]*(.*))?$/
const H2_RE = /^##[ \t]+\S/

/** The review shape: every item is 通过 / 不通过 / 改（写改法）. */
export const REVIEW_OPTIONS: DecisionOption[] = [
  { key: '1', label: OPTION_LABEL.reviewPass, body: '' },
  { key: '2', label: OPTION_LABEL.reviewFail, body: '' },
  { key: '3', label: OPTION_LABEL.reviewChange, body: '' },
]
/** Not sending is the reversible default for an outgoing draft nobody looked at. */
export const REVIEW_DEFAULT = '2'

/**
 * Sub-questions belong to the round that asked them: a `## 子问题` with no
 * `（第 N 轮）` suffix is round 1; a later `decs ask --question` writes its
 * own `## 子问题（第 N 轮）`. Only the block matching `currentRound` (the
 * node's current options round — see `core/parse.ts#optionsRoundOf`) is
 * returned; older rounds' blocks stay in the file as history (surfaced via
 * `parsePreviousRounds`) but never apply to the node's live answer.
 */
export function parseQuestions(body: string, defaults: Record<string, string> = {}, currentRound = 1): DecisionQuestion[] {
  const out: DecisionQuestion[] = []
  let inSection = false
  let collecting = false
  let q: DecisionQuestion | null = null
  let opt: DecisionOption | null = null
  let buf: string[] = []
  const flush = () => {
    const text = buf.join('\n').trim()
    if (opt) opt.body = text
    else if (q) q.body = text
    buf = []
  }
  for (const line of body.split('\n')) {
    const hm = QUESTIONS_HEADING_RE.exec(line)
    if (hm) {
      flush()
      inSection = true
      collecting = Number(hm[2] ?? 1) === currentRound
      q = opt = null
      continue
    }
    if (inSection && H2_RE.test(line)) {
      flush()
      inSection = false
      collecting = false
      q = opt = null
      continue
    }
    if (!collecting) continue
    const qm = QUESTION_RE.exec(line)
    if (qm) {
      flush()
      q = { key: qm[1], label: (qm[2] ?? '').trim(), body: '', options: [], default: defaults[qm[1]] }
      opt = null
      out.push(q)
      continue
    }
    const om = q ? SUB_OPTION_RE.exec(line) : null
    if (om && q) {
      flush()
      opt = { key: om[1], label: (om[2] ?? '').trim(), body: '' }
      q.options.push(opt)
      continue
    }
    buf.push(line)
  }
  flush()
  return out
}

export function renderQuestionsBlock(qs: DecisionQuestion[], round = 1): string {
  if (!qs.length) return ''
  const parts = [`## ${questionsHeading(round)}`, '']
  for (const q of qs) {
    parts.push(`### ${q.key}${q.label ? ` · ${q.label}` : ''}`, '')
    if (q.body.trim()) parts.push(q.body.trim(), '')
    for (const o of q.options) {
      parts.push(`#### ${o.key}${o.label ? ` · ${o.label}` : ''}`)
      if (o.body.trim()) parts.push('', o.body.trim())
      parts.push('')
    }
  }
  return parts.join('\n')
}

/** The two node-level choices that stand for "all defaults" and "item by item". */
export function questionOptions(qs: DecisionQuestion[]): DecisionOption[] {
  const defaults = qs.map((q) => `${q.key}=${q.default}`).join(' ')
  const keys = qs.map((q) => `${q.key}=…`).join(' ')
  return [
    { key: '1', label: allDefaultsLabel(defaults), body: '' },
    { key: '2', label: itemByItemLabel(keys), body: '' },
  ]
}

export function checkQuestions(qs: DecisionQuestion[]): void {
  const seen = new Set<string>()
  for (const q of qs) {
    if (!QUESTION_KEY_RE.test(q.key)) throw new Error(t('core.questions.badKey', { key: q.key }))
    if (seen.has(q.key)) throw new Error(t('core.questions.keyTwice', { key: q.key }))
    seen.add(q.key)
    if (!q.options.length) throw new Error(t('core.questions.noOptions', { key: q.key }))
    const dupe = q.options.map((o) => o.key).find((k, i, a) => a.indexOf(k) !== i)
    if (dupe) throw new Error(t('core.questions.optionTwice', { key: q.key, option: dupe }))
    if (!q.default) throw new Error(t('core.questions.noDefault', { key: q.key, option: q.options[0].key }))
    if (!q.options.some((o) => o.key === q.default))
      throw new Error(t('core.questions.defaultNotAnOption', { key: q.key, default: q.default, keys: q.options.map((o) => o.key).join(' ') }))
  }
}

/**
 * `Q1=B`, `R3=3:把第二段删掉` — out of push arguments or a free-text note.
 * Only keys and options that exist count, so prose like 「F1=… 的意思是」 in a
 * note that happens to share a shape is not mistaken for an answer.
 */
export function parseAnswerTokens(
  text: string,
  qs: DecisionQuestion[],
): { answers: Record<string, string>; notes: Record<string, string> } {
  const answers: Record<string, string> = {}
  const notes: Record<string, string> = {}
  const re = /(?<![A-Za-z0-9])([A-Z]\d{1,3})[ \t]*[=＝][ \t]*([A-Za-z0-9]{1,4})(?![A-Za-z0-9])(?:[:：]([^\n，,；;]*))?/g
  for (const m of text.matchAll(re)) {
    const q = qs.find((x) => x.key === m[1])
    if (!q || !q.options.some((o) => o.key === m[2])) continue
    answers[m[1]] = m[2]
    if (m[3]?.trim()) notes[m[1]] = m[3].trim()
  }
  return { answers, notes }
}
