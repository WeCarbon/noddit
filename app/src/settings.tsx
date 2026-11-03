import { useEffect, useState } from 'preact/hooks'
import { Info } from 'lucide-preact'
import * as api from './backend.ts'
import { previewSound } from './notice-sound.ts'
import type { Variant } from './sounds.ts'
import { s } from './strings.ts'

const isMac = /Mac/.test(navigator.platform)

/** `Ctrl+Alt+Space` → `⌃⌥Space` on a Mac; unchanged elsewhere. */
export function prettyHotkey(hotkey: string): string {
  if (!isMac) return hotkey
  const map: Record<string, string> = { Ctrl: '⌃', Control: '⌃', Alt: '⌥', Option: '⌥', Shift: '⇧', Cmd: '⌘', Command: '⌘', Super: '⌘', CmdOrCtrl: '⌘' }
  return hotkey
    .split('+')
    .map((p) => map[p] ?? p)
    .join('')
}

/** The keys pressed, in the global-shortcut plugin's own spelling: `Ctrl+Alt+Space`. */
function hotkeyFrom(e: KeyboardEvent): string | null {
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean) as string[]
  const code = e.code
  let key: string | null = null
  if (code === 'Space') key = 'Space'
  else if (/^Key[A-Z]$/.test(code)) key = code.slice(3)
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5)
  else if (/^F[0-9]{1,2}$/.test(code)) key = code
  else if (['Enter', 'Tab', 'Backquote', 'Period', 'Comma', 'Slash', 'Semicolon', 'Quote', 'BracketLeft', 'BracketRight', 'Minus', 'Equal'].includes(code)) key = code
  if (!key || !mods.length) return null
  return [...mods, key].join('+')
}

export function Settings({ onClose, onShared }: { onClose: () => void; onShared?: (key: string) => void }) {
  const [view, setView] = useState<api.SettingsView | null>(null)
  const [shared, setShared] = useState<api.SharedSetting[] | null>(null)
  const [sharedError, setSharedError] = useState<string | null>(null)
  useEffect(() => {
    void api.sharedSettings().then(setShared, (e: Error) => setSharedError(e.message))
  }, [])
  const setOne = async (item: api.SharedSetting, value: string) => {
    setSharedError(null)
    try {
      const next = await api.setSharedSetting(item.key, value === item.default ? null : value)
      setShared((all) => all && all.map((x) => (x.key === item.key ? (next ?? { ...x, value }) : x)))
      setSaved(true)
      setTimeout(() => setSaved(false), 1200)
      onShared?.(item.key)
    } catch (e) {
      setSharedError((e as Error).message)
    }
  }
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void api.settingsGet().then(setView)
  }, [])

  const save = async (next: api.AppSettings) => {
    if (!view) return
    setError(null)
    try {
      await api.settingsSet(next)
      setView({ ...view, settings: next, hotkeyError: null })
      setSaved(true)
      setTimeout(() => setSaved(false), 1200)
    } catch {
      setError(s('hotkeyTaken'))
    }
  }

  useEffect(() => {
    if (!recording || !view) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') return setRecording(false)
      const hk = hotkeyFrom(e)
      if (!hk) return
      setRecording(false)
      void save({ ...view.settings, hotkey: hk })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, view])

  if (!view) return null
  const st = view.settings
  const styles: { id: api.NotifyStyle; label: string; hint: string }[] = [
    { id: 'system', label: s('notifySystem'), hint: s('notifySystemHint') },
    { id: 'banner', label: s('notifyBanner'), hint: s('notifyBannerHint') },
    { id: 'off', label: s('notifyOff'), hint: s('notifyOffHint') },
  ]
  return (
    <div class="overlay" onClick={onClose}>
      <div class="settings" onClick={(e) => e.stopPropagation()}>
        <h3>
          {s('settingsTitle')}
          {saved && <span class="saved">✓</span>}
        </h3>

        {shared && shared.length > 0 && (
          <section class="s-shared">
            <div class="s-group">{s('settingsShared')}</div>
            {shared.map((item) => (
              <label key={item.key} class="s-field" title={item.source === 'env' ? s('settingSetBy', { env: item.env ?? '' }) : undefined}>
                <span class="s-field-label">{item.label}</span>
                <select
                  value={item.value}
                  disabled={item.source === 'env'}
                  onChange={(e) => void setOne(item, (e.currentTarget as HTMLSelectElement).value)}
                >
                  {(item.choices.some((c) => c.value === item.value) ? item.choices : [{ value: item.value, label: item.value_label }, ...item.choices]).map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
                {item.source === 'env' && <span class="s-note">{s('settingSetBy', { env: item.env ?? '' })}</span>}
              </label>
            ))}
            {sharedError && <p class="s-error">{sharedError}</p>}
          </section>
        )}

        <div class="s-group">{s('settingsApp')}</div>
        <section>
          <div class="s-label">{s('notifications')}</div>
          <div class="s-choices">
            {styles.map((o) => (
              <button key={o.id} class={`s-choice ${st.notify === o.id ? 'on' : ''}`} onClick={() => void save({ ...st, notify: o.id })}>
                <span class="s-radio" />
                <span class="s-choice-label" title={o.hint}>
                  {o.label}
                </span>
              </button>
            ))}
          </div>
        </section>

        <section>
          <div class="s-label">
            {s('hotkey')}
            <span class="s-info" title={s('hotkeyHint')}>
              <Info size={13} strokeWidth={1.75} />
            </span>
          </div>
          <div class="s-row">
            <button class={`s-hotkey ${recording ? 'recording' : ''}`} onClick={() => setRecording(!recording)}>
              {recording ? s('hotkeyRecord') : st.hotkey ? prettyHotkey(st.hotkey) : s('hotkeyNone')}
            </button>
            {st.hotkey && (
              <button class="quiet" onClick={() => void save({ ...st, hotkey: '' })}>
                {s('hotkeyClear')}
              </button>
            )}
            {st.hotkey !== view.defaultHotkey && (
              <button class="quiet" onClick={() => void save({ ...st, hotkey: view.defaultHotkey })}>
                {s('hotkeyDefault', { key: prettyHotkey(view.defaultHotkey) })}
              </button>
            )}
          </div>
          {view.ctrlSpaceTaken && <p class="s-note">{s('ctrlSpaceNote')}</p>}
          {(error || view.hotkeyError) && <p class="s-error">{error ?? s('hotkeyTaken')}</p>}
        </section>

        <section>
          <label class="s-toggle">
            <input type="checkbox" checked={st.keepInTray} onChange={() => void save({ ...st, keepInTray: !st.keepInTray })} />
            <span class="s-switch" />
            <span class="s-choice-label" title={s('keepInTrayHint')}>
              {s('keepInTray')}
            </span>
          </label>
        </section>

        <section>
          <div class="s-label">{s('soundsTitle')}</div>
          <div class="s-sound">
            <label class="s-toggle">
              <input type="checkbox" checked={st.sounds.updateOn} onChange={() => void save({ ...st, sounds: { ...st.sounds, updateOn: !st.sounds.updateOn } })} />
              <span class="s-switch" />
              <span class="s-choice-label" title={s('soundUpdateHint')}>
                {s('soundUpdateLabel')}
              </span>
            </label>
            <div class="s-row">
              {(['A', 'B'] as const satisfies readonly Variant[]).map((v) => (
                <button key={v} class={`s-variant ${st.sounds.updateVariant === v ? 'on' : ''}`} title={s('soundVariant', { variant: v })} onClick={() => void save({ ...st, sounds: { ...st.sounds, updateVariant: v } })}>
                  {v}
                </button>
              ))}
              <button class="quiet" onClick={() => previewSound('update', st.sounds.updateVariant, st.sounds.volume)}>
                {s('soundPreview')}
              </button>
            </div>
          </div>
          <div class="s-sound">
            <label class="s-toggle">
              <input type="checkbox" checked={st.sounds.decideOn} onChange={() => void save({ ...st, sounds: { ...st.sounds, decideOn: !st.sounds.decideOn } })} />
              <span class="s-switch" />
              <span class="s-choice-label" title={s('soundDecideHint')}>
                {s('soundDecideLabel')}
              </span>
            </label>
            <div class="s-row">
              {(['A', 'B'] as const satisfies readonly Variant[]).map((v) => (
                <button key={v} class={`s-variant ${st.sounds.decideVariant === v ? 'on' : ''}`} title={s('soundVariant', { variant: v })} onClick={() => void save({ ...st, sounds: { ...st.sounds, decideVariant: v } })}>
                  {v}
                </button>
              ))}
              <button class="quiet" onClick={() => previewSound('decide', st.sounds.decideVariant, st.sounds.volume)}>
                {s('soundPreview')}
              </button>
            </div>
          </div>
          <div class="s-row s-volume">
            <span class="s-choice-label">{s('soundVolume')}</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={st.sounds.volume}
              onInput={(e) => void save({ ...st, sounds: { ...st.sounds, volume: Number((e.currentTarget as HTMLInputElement).value) } })}
            />
          </div>
        </section>
      </div>
    </div>
  )
}
