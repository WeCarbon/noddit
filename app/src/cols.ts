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
