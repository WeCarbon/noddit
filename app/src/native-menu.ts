import type { Image } from '@tauri-apps/api/image'
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
      out.push(await m.Submenu.new({ text: item.label, enabled: !item.disabled, items: (await build(m, item.sub)) as never }))
      continue
    }
    const common = { text: item.label, enabled: !item.disabled, accelerator: accelerator(item.shortcut), action: () => item.run?.() }
    const icon = item.appIcon ? await appIcon(item.appIcon) : undefined
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
