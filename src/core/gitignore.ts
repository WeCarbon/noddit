import { existsSync, readFileSync, writeFileSync } from 'node:fs'

/** Adds missing lines to a `.gitignore` without touching anything a human added by hand. */
export function ensureGitignoreLines(path: string, lines: string[]): void {
  const existing = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : []
  const have = new Set(existing.map((l) => l.trim()).filter(Boolean))
  const missing = lines.filter((l) => !have.has(l))
  if (!missing.length) return
  const base = existing.join('\n').replace(/\s+$/, '')
  writeFileSync(path, `${base ? `${base}\n` : ''}${missing.join('\n')}\n`)
}
