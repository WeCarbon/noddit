/**
 * Node refs mentioned in prose — a project's letter plus its number, e.g. `G91`, the same shape
 * `node.ref` is built from (letter + id; core/ref.ts:formatRef). The app bundle can't import that
 * module (it drags in `node:fs` through core/project.ts), so the match rule is kept here by hand,
 * mirroring core/ref.ts:parseBodyRefs: word-boundaried, a known project's letter, and at least two
 * digits — `F1`, `T3`, `Q2`, "H2", "A4 paper" and "MP3" are common text that only look like refs.
 */

export interface RefMatch {
  start: number
  end: number
  text: string
  letter: string
  id: number
}

// Earlier alternatives "consume" a code span, a bold run, and an existing markdown or bare link —
// a ref inside any of those is left alone. Only a match through the last alternative is a ref.
const REF_OR_SKIP = /`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^)\s]+\)|https?:\/\/[^\s)]+|(?<![A-Za-z0-9_])([A-Z])(\d{2,6})(?![A-Za-z0-9_])/g

/** Every node ref in `text` whose letter is a known project's — skipping code spans, bold runs, and links. */
export function findRefs(text: string, knownLetters: Iterable<string>): RefMatch[] {
  const letters = new Set(knownLetters)
  const out: RefMatch[] = []
  for (const m of text.matchAll(REF_OR_SKIP)) {
    const letter = m[1]
    const digits = m[2]
    if (letter === undefined || digits === undefined || !letters.has(letter)) continue
    out.push({ start: m.index, end: m.index + m[0].length, text: m[0], letter, id: Number(digits) })
  }
  return out
}

/** What turns a matched ref into a click: which letters are real projects, how to resolve one to
 *  a node's key, and how to jump there. `resolve` returns `undefined` for a ref that parses but
 *  matches no node — left as plain text. */
export interface RefLinker {
  knownLetters: Set<string>
  resolve: (ref: string) => string | undefined
  jump: (key: string) => void
}

export function buildRefLinker(projects: Iterable<{ letter: string }>, nodes: Record<string, { ref: string }>, jump: (key: string) => void): RefLinker {
  const knownLetters = new Set<string>()
  for (const p of projects) knownLetters.add(p.letter)
  const byRef = new Map<string, string>()
  for (const [key, n] of Object.entries(nodes)) byRef.set(n.ref, key)
  return { knownLetters, resolve: (ref) => byRef.get(ref), jump }
}
