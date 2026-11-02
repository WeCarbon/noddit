import type { RefObject } from 'preact'
import { useLayoutEffect } from 'preact/hooks'

/**
 * Puts the keyboard in a dialog's field as soon as it opens, and gives focus
 * back to what had it when the dialog goes away. `autoFocus` alone is not
 * enough: browsers honour it once per page, not for elements added later.
 */
export function useDialogFocus(ref: RefObject<HTMLElement | null>, opts: { select?: boolean } = {}, deps: unknown[] = []) {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const before = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
    const focus = () => {
      if (!el.isConnected || document.activeElement === el) return
      el.focus({ preventScroll: true })
      if (opts.select && el instanceof HTMLInputElement) el.select()
    }
    focus()
    // Again after the frame settles (an opening transition, a window that was just shown).
    const later = setTimeout(focus, 30)
    // A window hidden and shown again comes back with nothing focused.
    const onWindowFocus = () => {
      if (document.activeElement === document.body || document.activeElement === null) focus()
    }
    window.addEventListener('focus', onWindowFocus)
    return () => {
      clearTimeout(later)
      window.removeEventListener('focus', onWindowFocus)
      const active = document.activeElement
      const lost = active === null || active === document.body || el.contains(active) || !active.isConnected
      if (lost && before?.isConnected) before.focus({ preventScroll: true })
    }
  }, deps)
}
