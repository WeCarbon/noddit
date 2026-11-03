import type { Image } from '@tauri-apps/api/image'
import { render, type ComponentChildren } from 'preact'
import { invoke } from './backend.ts'
import type { MenuItem } from './menu.tsx'

/** The key hint the window shows, as an accelerator the OS menu draws in its own style. */
function accelerator(shortcut: string | undefined): string | undefined {
  if (!shortcut) return undefined
  if (/^[A-Z0-9]$/i.test(shortcut)) return shortcut.toUpperCase()
  const named: Record<string, string> = { '⏎': 'Enter', '←': 'ArrowLeft', '→': 'ArrowRight', '⇧F10': 'Shift+F10' }
  return named[shortcut]
}

type Native = typeof import('@tauri-apps/api/menu')

/** That app's own icon (the Rust side fetches and caches it once per process), or undefined
 *  when it can't be found — never throws, so a missing icon just falls back to text only. */
async function appIcon(bundleId: string): Promise<Image | undefined> {
  try {
    const bytes = await invoke<number[] | null>('terminal_icon', { bundleId })
    if (!bytes) return undefined
    const { Image } = await import('@tauri-apps/api/image')
    return await Image.fromBytes(bytes)
  } catch {
    return undefined
  }
}

const drawn = new Map<string, Promise<Image | undefined>>()

/**
 * A menu item's line icon as a picture the OS menu can draw: the native menu takes only
 * images, so the SVG the window would show is painted onto a 2× canvas in the menu's text colour.
 */
function iconImage(icon: ComponentChildren): Promise<Image | undefined> {
  const holder = document.createElement('div')
  render(icon as never, holder)
  const svg = holder.querySelector('svg')
  render(null, holder)
  if (!svg) return Promise.resolve(undefined)
  const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches
  const markup = svg.outerHTML.replace(/currentColor/g, dark ? '#e6e6e6' : '#262626')
  const key = markup
  if (!drawn.has(key)) {
    drawn.set(
      key,
      (async () => {
        try {
          const px = 32
          const img = new window.Image()
          img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup.replace('<svg', `<svg width="${px}" height="${px}"`))}`
          await img.decode()
          const canvas = document.createElement('canvas')
          canvas.width = px
          canvas.height = px
          canvas.getContext('2d')?.drawImage(img, 0, 0, px, px)
          const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/png'))
          if (!blob) return undefined
          const { Image } = await import('@tauri-apps/api/image')
          return await Image.fromBytes(new Uint8Array(await blob.arrayBuffer()))
        } catch {
          return undefined
        }
      })(),
    )
  }
  return drawn.get(key)!
}

async function build(m: Native, items: MenuItem[]): Promise<unknown[]> {
  const out: unknown[] = []
  for (const item of items) {
    if (item.kind === 'separator') {
      out.push(await m.PredefinedMenuItem.new({ item: 'Separator' }))
      continue
    }
    if (item.kind === 'header') {
      out.push(await m.MenuItem.new({ text: item.label, enabled: false }))
      continue
    }
    if (item.sub) {
      const icon = item.icon ? await iconImage(item.icon) : undefined
      out.push(await m.Submenu.new({ text: item.label, enabled: !item.disabled, items: (await build(m, item.sub)) as never, ...(icon ? { icon } : {}) }))
      continue
    }
    const common = { text: item.label, enabled: !item.disabled, accelerator: accelerator(item.shortcut), action: () => item.run?.() }
    const icon = item.appIcon ? await appIcon(item.appIcon) : item.icon && item.checked === undefined ? await iconImage(item.icon) : undefined
    if (icon) {
      out.push(await m.IconMenuItem.new({ ...common, icon }))
      continue
    }
    out.push(item.checked !== undefined ? await m.CheckMenuItem.new({ ...common, checked: item.checked }) : await m.MenuItem.new(common))
  }
  return out
}

/**
 * The menu the OS draws: system font, vibrancy, highlight and shortcut glyphs on macOS,
 * the Windows 11 look on Windows — nothing to imitate. Returns false if it cannot be shown.
 */
export async function popupNative(items: MenuItem[], x: number, y: number): Promise<boolean> {
  try {
    const m = await import('@tauri-apps/api/menu')
    const { LogicalPosition } = await import('@tauri-apps/api/dpi')
    const menu = await m.Menu.new({ items: (await build(m, items)) as never })
    await menu.popup(new LogicalPosition(x, y))
    return true
  } catch {
    return false
  }
}
