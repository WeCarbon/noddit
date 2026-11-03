import { stringWidth } from '../tui/width.ts'
import { t } from '../i18n/index.ts'
import type { NoteRole } from './types.ts'

/**
 * A notice's text area is about 290px at 12.5px — one line holds roughly 23
 * CJK characters (2 columns each) or 45 Latin ones (1 column). N203 rounds
 * that down to a flat 120 display columns (60 CJK / 120 Latin) for three
 * lines, used both ways: a reply over this needs its own `--summary`, and a
 * `--summary` itself must fit inside it.
 */
export const SUMMARY_MAX_WIDTH = 120

/**
 * A note's markdown as one plain paragraph, for measuring how it will read
 * in a narrow notice. Mirrors `app/src/plain-reply.ts`'s `plainReply` —
 * kept separate since the CLI package and the desktop app build apart from
 * each other; keep the two in step by hand if one changes.
 */
export function plainTextOf(markdown: string): string {
  return markdown
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s?)/gm, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Display columns — CJK and emoji count as two, same as the TUI's own layout. */
export const displayWidth = stringWidth

/**
 * N203/N205: an agent's reply over the display budget must carry its own
 * one-line `--summary`; a short reply is its own summary, so none is
 * required. A given summary must itself fit the budget, and can't contain
 * anything that would break out of the `<!-- nod:summary=… -->` marker it
 * is stored in (serialize.ts's `appendSection`). The owner's own words
 * (`role: 'human'`) are never rejected — `--human` is unaffected.
 */
export function checkSummary(text: string, summary: string | undefined, role: NoteRole): string | undefined {
  if (role === 'human') return summary
  if (summary !== undefined) {
    if (/[\r\n]/.test(summary) || summary.includes('-->')) throw new Error(t('core.store.summaryBadChars'))
    if (displayWidth(summary) > SUMMARY_MAX_WIDTH) throw new Error(t('core.store.summaryTooLong'))
    return summary
  }
  if (displayWidth(plainTextOf(text)) > SUMMARY_MAX_WIDTH) throw new Error(t('core.store.summaryNeeded'))
  return undefined
}
