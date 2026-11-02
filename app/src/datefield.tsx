import { useEffect, useRef, useState } from 'preact/hooks'
import * as api from './backend.ts'
import { useDialogFocus } from './focus.ts'
import { s } from './strings.ts'

/**
 * A date typed loosely — "fri", "next week", "3d", "11月15日" — read by `nod date` as you
 * type, with what it understood shown under the field and ready-made picks beside it.
 * `onChange` gets the YYYY-MM-DD it read, or null while it reads nothing.
 */
export function DateField(p: {
  value: string
  onText: (text: string) => void
  onChange: (date: string | null) => void
  onEnter?: () => void
  onEscape?: () => void
  autoFocus?: boolean
  placeholder?: string
}) {
  const [read, setRead] = useState<api.DateRead | null>(null)
  const [picks, setPicks] = useState<api.DateSuggestion[]>([])
  const field = useRef<HTMLInputElement>(null)
  const seq = useRef(0)
  useDialogFocus(p.autoFocus ? field : { current: null })

  useEffect(() => {
    void api.readDate('').then((r) => setPicks(r.suggestions))
  }, [])
  useEffect(() => {
    const text = p.value.trim()
    if (!text) {
      setRead(null)
      p.onChange(null)
      return
    }
    const mine = ++seq.current
    const timer = setTimeout(() => {
      void api.readDate(text).then((r) => {
        if (mine !== seq.current) return
        setRead(r)
        p.onChange(r.ok ? r.date : null)
      })
    }, 120)
    return () => clearTimeout(timer)
  }, [p.value])

  return (
    <div class="datefield">
      <input
        ref={field}
        value={p.value}
        placeholder={p.placeholder ?? s('datePlaceholder')}
        onInput={(e) => p.onText((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter' && !e.isComposing) (e.preventDefault(), p.onEnter?.())
          if (e.key === 'Escape') p.onEscape?.()
        }}
      />
      <div class={`date-read ${read && !read.ok ? 'bad' : ''}`} aria-live="polite">
        {read ? (read.ok ? `${read.text} · ${read.relative}` : read.hint || s('dateUnread')) : ' '}
      </div>
      {picks.length > 0 && (
        <div class="date-picks">
          {picks.map((x) => (
            <button key={x.key} class={`qchip ${read?.date === x.date ? 'on' : ''}`} onClick={() => p.onText(x.label)} title={`${x.text} · ${x.relative}`}>
              {x.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
