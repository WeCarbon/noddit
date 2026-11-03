/** Display columns, as the CLI counts them: CJK and wide symbols take two. */
export const cols = (s: string) => [...s].reduce((n, c) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u.test(c) ? 2 : 1), 0)

/** `s` cut to at most `max` columns. */
export function clipCols(s: string, max: number): string {
  let out = ''
  for (const c of s) {
    if (cols(out + c) > max) break
    out += c
  }
  return out
}

/**
 * An input handler that refuses what would go past `max` columns — but only once an IME has
 * committed, so a half-typed pinyin syllable is never cut.
 */
export function limitInput(max: number, then?: (value: string) => void) {
  return (e: Event) => {
    const el = e.target as HTMLInputElement
    if ((e as InputEvent).isComposing) return
    if (cols(el.value) > max) el.value = clipCols(el.value, max)
    then?.(el.value)
  }
}
