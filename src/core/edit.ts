import { parseNoteHeading } from './parse.ts'

/**
 * Replacing one part of a node's body and nothing else: the description (everything
 * above the first `## ` heading) or the text of one appended note (between its heading
 * and the next `## `). Every other byte — option headings, answers, note headings,
 * writer marks, attachment lists — stays exactly as it was.
 */

const H2 = /^##[ \t]+\S/

/** A `## ` line in edited text would start a section of the file: it becomes `### `. */
const keepInside = (text: string) =>
  text
    .trim()
    .split('\n')
    .map((l) => (/^##[ \t]/.test(l) ? `#${l}` : l))
    .join('\n')

/** The description: the body's lines before the first `## ` heading. */
export function descriptionOf(body: string): string {
  const lines = body.split('\n')
  const end = lines.findIndex((l) => H2.test(l))
  return (end === -1 ? lines : lines.slice(0, end)).join('\n').trim()
}

export function replaceDescription(body: string, text: string): string {
  const lines = body.split('\n')
  const end = lines.findIndex((l) => H2.test(l))
  const rest = end === -1 ? '' : lines.slice(end).join('\n')
  const desc = keepInside(text)
  if (!rest) return desc ? `${desc}\n` : ''
  return desc ? `${desc}\n\n${rest}` : rest
}

/** Line of the `n`th (1-based) appended note's heading, in body order, or -1. */
function noteLine(lines: string[], n: number): number {
  let seen = 0
  for (let i = 0; i < lines.length; i++) {
    if (!parseNoteHeading(lines[i])) continue
    if (++seen === n) return i
  }
  return -1
}

/** The `n`th note's text replaced; its heading and everything around it untouched. Null if there is no such note. */
export function replaceNoteText(body: string, n: number, text: string): string | null {
  const lines = body.split('\n')
  const at = noteLine(lines, n)
  if (at === -1) return null
  let end = at + 1
  while (end < lines.length && !H2.test(lines[end])) end++
  // A section ends with one blank line before the next heading, as appendSection writes it.
  const tail = end < lines.length ? [''] : ['']
  return [...lines.slice(0, at + 1), '', ...keepInside(text).split('\n'), ...tail, ...lines.slice(end)].join('\n')
}
