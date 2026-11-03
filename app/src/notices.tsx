import { X } from 'lucide-preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { s, type StringKey } from './strings.ts'

/** Something an AI (or the clock) did that the owner should notice. */
export interface Notice {
  kind: 'replied' | 'decision' | 'claimed' | 'checkBack' | 'milestone' | 'uncollected'
  key: string
  ref: string
  title: string
  /** milestone: `hour` or `day`. */
  which?: string
  /** decision: how many more arrived with it. */
  more?: number
  /** replied: the reply itself, as plain text; shown (clamped to three lines) instead of "an AI replied". */
  text?: string
}

interface Shown extends Notice {
  id: number
}

export const NOTICE_MS = 6000
const MAX = 3

const WHAT: Record<Notice['kind'], StringKey> = {
  replied: 'noticeReplied',
  decision: 'noticeDecision',
  claimed: 'noticeClaimed',
  checkBack: 'noticeCheckBack',
  milestone: 'noticeMilestoneDay',
  uncollected: 'noticeUncollected',
}

/** The line under the title: what happened, or what the AI said. */
export function noticeWhat(n: Notice): string {
  if (n.kind === 'milestone') return s(n.which === 'hour' ? 'noticeMilestoneHour' : 'noticeMilestoneDay')
  if (n.text) return n.text
  const what = s(WHAT[n.kind])
  return n.more ? `${what} · +${n.more}` : what
}

/**
 * Up to three notices, newest on top. Each goes after `NOTICE_MS`; while the pointer is over
 * the stack none of them do, and they start counting again, from where they were, on leave.
 */
export function useNoticeQueue(onEmpty?: () => void) {
  const [items, setItems] = useState<Shown[]>([])
  const seq = useRef(0)
  const timers = useRef(new Map<number, { left: number; started: number; handle?: number }>())
  const hovering = useRef(false)

  const dismiss = (id: number) => {
    const t = timers.current.get(id)
    if (t?.handle) clearTimeout(t.handle)
    timers.current.delete(id)
    setItems((xs) => xs.filter((x) => x.id !== id))
  }
  const arm = (id: number) => {
    const t = timers.current.get(id)
    if (!t || hovering.current) return
    t.started = Date.now()
    t.handle = window.setTimeout(() => dismiss(id), t.left)
  }
  const push = (n: Notice) => {
    const id = ++seq.current
    timers.current.set(id, { left: NOTICE_MS, started: Date.now() })
    setItems((xs) => {
      // The same node again replaces its older notice instead of stacking.
      const rest = xs.filter((x) => !(x.key === n.key && x.kind === n.kind))
      const next = [{ ...n, id }, ...rest]
      for (const gone of next.slice(MAX)) dismiss(gone.id)
      return next.slice(0, MAX)
    })
    arm(id)
  }
  const hover = (on: boolean) => {
    hovering.current = on
    for (const [id, t] of timers.current) {
      if (on) {
        if (t.handle) clearTimeout(t.handle)
        t.handle = undefined
        t.left = Math.max(800, t.left - (Date.now() - t.started))
      } else arm(id)
    }
  }
  useEffect(() => {
    if (!items.length) onEmpty?.()
  }, [items.length])
  useEffect(() => () => timers.current.forEach((t) => t.handle && clearTimeout(t.handle)), [])
  return { items, push, dismiss, hover }
}

/** The compact top-right stack: ref, title, one line of what; a click opens the node. */
export function NoticeStack(p: { q: ReturnType<typeof useNoticeQueue>; onOpen: (key: string) => void; floating?: boolean }) {
  if (!p.q.items.length) return null
  return (
    <div class={`notices ${p.floating ? 'floating' : ''}`} onMouseEnter={() => p.q.hover(true)} onMouseLeave={() => p.q.hover(false)} role="status" aria-live="polite">
      {p.q.items.map((n) => (
        <div key={n.id} class={`notice k-${n.kind}`} onClick={() => (p.onOpen(n.key), p.q.dismiss(n.id))} role="button" tabIndex={-1}>
          <span class="n-gem" />
          <span class="n-main">
            <span class="n-top">
              <span class="n-ref">{n.ref}</span>
              <span class="n-title" dir="auto">
                {n.title}
              </span>
            </span>
            <span class="n-what">{noticeWhat(n)}</span>
          </span>
          <button
            class="n-close"
            aria-label={s('cancel')}
            onClick={(e) => {
              e.stopPropagation()
              p.q.dismiss(n.id)
            }}
          >
            <X size={12} strokeWidth={2} />
          </button>
        </div>
      ))}
    </div>
  )
}
