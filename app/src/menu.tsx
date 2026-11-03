import type { ComponentChildren } from 'preact'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'

export type MenuItem =
  | {
      kind?: 'item'
      label: string
      icon?: ComponentChildren
      /** A bundle id: the native menu asks macOS for that app's own icon (falls back to `icon`, then text-only). Ignored outside the native menu. */
      appIcon?: string
      shortcut?: string
      run?: () => void
      sub?: MenuItem[]
      danger?: boolean
      checked?: boolean
      disabled?: boolean
    }
  | { kind: 'separator' }
  | { kind: 'header'; label: string }

export interface MenuState {
  x: number
  y: number
  items: MenuItem[]
  /** For a submenu: how wide the menu it opened from is. */
  parentWidth?: number
}

/** macOS shows key glyphs; Windows spells keys out. */
function shortcutText(k: string): string {
  if (document.documentElement.dataset.platform !== 'win') return k
  const words: Record<string, string> = { '⏎': 'Enter', '←': 'Left', '→': 'Right', '⇧F10': 'Shift+F10' }
  return words[k] ?? k.replace('⌘', 'Ctrl+').replace('⇧', 'Shift+').replace('⌥', 'Alt+')
}

const isAction = (i: MenuItem): i is Extract<MenuItem, { kind?: 'item' }> => i.kind === undefined || i.kind === 'item'

/**
 * The window's own context menu: arrow keys move, → opens a submenu, ← and Esc go back,
 * Enter runs. It stands in for the web view's built-in one, which offers Reload.
 */
export function ContextMenu({ state, onClose, onDone, nested = false }: { state: MenuState; onClose: () => void; onDone?: () => void; nested?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: state.x, y: state.y })
  const enabled = state.items.map((i, n) => (isAction(i) && !i.disabled ? n : -1)).filter((n) => n >= 0)
  const [at, setAt] = useState(nested ? (enabled[0] ?? -1) : -1)
  const [open, setOpen] = useState<{ index: number; state: MenuState } | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const pad = 6
    let x = state.x
    let y = state.y
    // A submenu that would run off the right edge opens to the left of its parent instead.
    if (x + r.width > window.innerWidth - pad) x = nested ? state.x - r.width - (state.parentWidth ?? 0) + 8 : window.innerWidth - r.width - pad
    // No room on either side: lay it over its parent, against the right edge.
    if (nested && x < pad) x = window.innerWidth - r.width - pad
    if (y + r.height > window.innerHeight - pad) y = Math.max(pad, window.innerHeight - r.height - pad)
    setPos({ x: Math.max(pad, x), y })
    el.focus()
  }, [state])

  const openSub = (index: number) => {
    const item = state.items[index]
    if (!isAction(item) || !item.sub) return
    const row = ref.current?.querySelectorAll<HTMLElement>('[data-index]')
    const el = [...(row ?? [])].find((e) => Number(e.dataset.index) === index)
    const r = el?.getBoundingClientRect()
    setOpen({ index, state: { x: (r?.right ?? pos.x) - 4, y: (r?.top ?? pos.y) - 5, items: item.sub, parentWidth: r?.width } })
  }
  const run = (index: number) => {
    const item = state.items[index]
    if (!isAction(item) || item.disabled) return
    if (item.sub) return openSub(index)
    ;(onDone ?? onClose)()
    item.run?.()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (open) return
      const step = (d: number) => {
        if (!enabled.length) return
        const i = enabled.indexOf(at)
        setAt(enabled[(i + d + enabled.length) % enabled.length] ?? enabled[0])
      }
      const handled = () => (e.preventDefault(), e.stopImmediatePropagation())
      if (e.key === 'ArrowDown') return handled(), step(1)
      if (e.key === 'ArrowUp') return handled(), step(at === -1 ? 0 : -1)
      if (e.key === 'Home') return handled(), setAt(enabled[0])
      if (e.key === 'End') return handled(), setAt(enabled.at(-1)!)
      if (e.key === 'Escape' || (nested && e.key === 'ArrowLeft')) return handled(), onClose()
      if (e.key === 'ArrowRight' && at >= 0) return handled(), openSub(at)
      if ((e.key === 'Enter' || e.key === ' ') && at >= 0) return handled(), run(at)
      handled()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  useEffect(() => {
    if (nested) return
    const away = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.ctx-menu')) onClose()
    }
    const gone = () => onClose()
    window.addEventListener('mousedown', away, true)
    window.addEventListener('resize', gone)
    document.addEventListener('visibilitychange', gone)
    return () => {
      window.removeEventListener('mousedown', away, true)
      window.removeEventListener('resize', gone)
      document.removeEventListener('visibilitychange', gone)
    }
  }, [])

  return (
    <>
      <div ref={ref} class="ctx-menu" role="menu" tabIndex={-1} style={{ left: `${pos.x}px`, top: `${pos.y}px`, zIndex: nested ? 51 : undefined }} onContextMenu={(e) => e.preventDefault()}>
        {state.items.map((item, n) => {
          if (item.kind === 'separator') return <div key={n} class="ctx-sep" role="separator" />
          if (item.kind === 'header') return <div key={n} class="ctx-header">{item.label}</div>
          return (
            <div
              key={n}
              data-index={n}
              role="menuitem"
              aria-disabled={item.disabled}
              aria-haspopup={Boolean(item.sub)}
              class={`ctx-item ${at === n ? 'on' : ''} ${item.danger ? 'danger' : ''} ${item.disabled ? 'disabled' : ''}`}
              onMouseEnter={() => {
                if (item.disabled) return
                setAt(n)
                if (item.sub) openSub(n)
                else setOpen(null)
              }}
              onClick={() => run(n)}
            >
              <span class="ctx-check">{item.checked ? '✓' : item.icon}</span>
              <span class="ctx-label" dir="auto">
                {item.label}
              </span>
              {item.shortcut && <span class="ctx-key">{shortcutText(item.shortcut)}</span>}
              {item.sub && <span class="ctx-arrow">›</span>}
            </div>
          )
        })}
      </div>
      {open && (
        <ContextMenu
          nested
          state={open.state}
          onDone={onDone ?? onClose}
          onClose={() => {
            setOpen(null)
            ref.current?.focus()
          }}
        />
      )}
    </>
  )
}
