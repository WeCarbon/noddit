import stringWidth from 'string-width'
import { NOTE_KIND } from './format.ts'
import { parseNoteHeading } from './parse.ts'
import { isHumanTask } from './assignee.ts'
import { isDeferred, isTerminal } from './status.ts'
import { TITLE_MAX_COLS } from './title.ts'
import type { Decision } from './types.ts'

/**
 * 派活: the owner types a few words (`nod add "make onboarding faster"` in
 * their own terminal, or the app's new-task box) and an AI picks it up,
 * expands it into a full description with child nodes, and asks the owner
 * to confirm before any work starts.
 *
 * On disk: `intake: true` in front matter; the owner's words verbatim under
 * `## 原话（human · owner · <time>）`; `claimed_by` / `claimed_at` once an
 * agent takes it. Everything above `## 原话` is the description the agent writes.
 */

export type BriefState = 'unclaimed' | 'claimed'

/** `unclaimed`: nobody has picked it up yet. `claimed`: an agent has. Null for an ordinary node or a finished one. */
export function briefState(d: Pick<Decision, 'intake' | 'claimedBy' | 'state'>): BriefState | null {
  if (!d.intake || isTerminal(d.state)) return null
  return d.claimedBy ? 'claimed' : 'unclaimed'
}

export const isUnclaimedBrief = (d: Pick<Decision, 'intake' | 'claimedBy' | 'state' | 'deferredAt'> & Partial<Pick<Decision, 'deferredUntil' | 'assignee'>>) =>
  briefState(d) === 'unclaimed' && !isDeferred(d) && !isHumanTask(d)

/** The owner's words as filed — the first `## 原话` section. */
export function originalWords(d: Pick<Decision, 'notes'>): string | undefined {
  return d.notes.find((n) => n.kind === NOTE_KIND.original)?.text
}

/** A title for a brief the owner typed as one long line: cut to fit, the full text stays under 原话. */
export function briefTitle(words: string, max = TITLE_MAX_COLS): string {
  const line = words.replace(/\s+/g, ' ').trim()
  if (stringWidth(line) <= max) return line
  let out = ''
  for (const ch of line) {
    if (stringWidth(out + ch) > max - 1) break
    out += ch
  }
  return `${out.trimEnd()}…`
}

/** Index of the `## 原话` heading line, or -1. */
function originalLine(lines: string[]): number {
  return lines.findIndex((l) => parseNoteHeading(l)?.kind === NOTE_KIND.original)
}

/**
 * The body with everything above `## 原话` replaced by `description`.
 * A node with no 原话 section gets one first, holding its old description
 * (`original` is that section's heading), so the words it was filed with survive.
 */
export function withDescription(body: string, description: string, original: string): string {
  const lines = body.split('\n')
  const at = originalLine(lines)
  let rest: string
  if (at === -1) {
    const firstH2 = lines.findIndex((l) => /^##[ \t]+\S/.test(l))
    const head = (firstH2 === -1 ? lines : lines.slice(0, firstH2)).join('\n').trim()
    const tail = firstH2 === -1 ? '' : lines.slice(firstH2).join('\n').trim()
    rest = [head ? `## ${original}\n\n${head}` : '', tail].filter(Boolean).join('\n\n')
  } else {
    rest = lines.slice(at).join('\n').trim()
  }
  const desc = description.trim()
  return `${[desc, rest].filter(Boolean).join('\n\n')}\n`
}
