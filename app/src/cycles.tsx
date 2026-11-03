import { TriangleAlert } from 'lucide-preact'
import { s } from './strings.ts'
import type { CycleNode } from './types.ts'

/**
 * `after` forming a loop makes every node in it permanently unstartable
 * (`nod check` reports the same list as an error) — the TUI shows the first
 * one in its summary strip (`src/tui/summary.ts:cyclesLine`); this is its
 * app-side equivalent, always on top of the list while any loop stands.
 */
export function CycleBanner({ cycles, onJump }: { cycles: CycleNode[][]; onJump: (key: string) => void }) {
  if (!cycles.length) return null
  const [first, ...rest] = cycles
  return (
    <div class="cycle-banner" role="alert">
      <TriangleAlert size={14} strokeWidth={1.75} />
      <span class="cycle-text">
        {s('cycleWarning')}{' '}
        {first.map((n, i) => (
          <span key={n.key} class="cycle-item">
            {i > 0 && <span class="cycle-arrow"> → </span>}
            <button class="cycle-ref" onClick={() => onJump(n.key)} title={n.title}>
              {n.ref}
            </button>
          </span>
        ))}
      </span>
      {rest.length > 0 && <span class="cycle-more">{s('cycleMore', { count: rest.length })}</span>}
    </div>
  )
}
