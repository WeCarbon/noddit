import { clipCols, cols } from './cols.ts'

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
