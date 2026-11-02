import { closeSync, openSync, readSync, statSync } from 'node:fs'

/** Attachments shown as text in the bench (and the window): source, logs, markdown. HTML as source, never run. */
export const TEXT_PREVIEW = /\.(txt|log|md|markdown|json|csv|tsv|ya?ml|toml|ini|xml|html?|css|js|mjs|ts|tsx|jsx|py|rb|go|rs|java|kt|swift|c|h|cpp|sh|sql|diff|patch)$/i
export const PREVIEW_MAX = 1_048_576

/** The first `max` bytes of `path` as text, and whether there was more. */
export function readPreview(path: string, max = PREVIEW_MAX): { text: string; truncated: boolean } {
  const size = statSync(path).size
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(Math.min(size, max))
    const n = readSync(fd, buf, 0, buf.length, 0)
    return { text: buf.subarray(0, n).toString('utf8'), truncated: size > max }
  } finally {
    closeSync(fd)
  }
}
