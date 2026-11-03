import { Flag } from 'lucide-preact'
import type { Seg } from './types.ts'

/** The milestone glyph (N283's third kind, alongside human/AI) — the TUI draws it as
 *  the ⚑ character; the app draws the same glyph with lucide's Flag icon instead. */
const MILESTONE_GLYPH = '⚑'

const BAR = /^[█░]+$/

export function segClass(s: Pick<Seg, 'color' | 'bold' | 'dim'>): string {
  return [s.color ? `c-${s.color}` : '', s.bold ? 'b' : '', s.dim ? 'd' : ''].filter(Boolean).join(' ')
}

/** A terminal progress bar (`████░░░░`) becomes a real one; everything else keeps its colour. */
export function Segs({ segs, trim }: { segs: Seg[]; trim?: boolean }) {
  return (
    <>
      {segs.map((s, i) => {
        if (BAR.test(s.text)) {
          const pct = (s.text.replace(/░/g, '').length / s.text.length) * 100
          return <Bar key={i} pct={pct} color={s.color} />
        }
        const text = trim && (i === 0 || i === segs.length - 1) ? s.text.trim() : s.text
        return (
          <span key={i} class={segClass(s)}>
            {text}
          </span>
        )
      })}
    </>
  )
}

export function Bar({ pct, color }: { pct: number; color?: string }) {
  return (
    <span class={`bar ${color ? `c-${color}` : 'c-cyan'}`}>
      <span style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </span>
  )
}

export function Glyph({ g }: { g?: Seg }) {
  if (!g) return <span class="glyph" />
  if (g.text === MILESTONE_GLYPH) return <span class={`glyph ${segClass(g)}`}><Flag size={12} strokeWidth={2} fill="currentColor" /></span>
  return <span class={`glyph ${segClass(g)}`}>{g.text}</span>
}
