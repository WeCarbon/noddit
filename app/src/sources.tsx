import { Rss } from 'lucide-preact'
import { s } from './strings.ts'
import type { Source } from './types.ts'

/** Where the ball is on an undone item — same three buckets + an arbitrary name as the TUI's `bucketLabel`. */
const BUCKET_ORDER = ['unhandled', 'owner', 'us']
const bucketLabel = (k: string) =>
  k === 'unhandled' ? s('sourceUnhandled') : k === 'owner' ? s('sourceOwner') : k === 'us' ? s('sourceUs') : s('sourceWaitingOn', { who: k })

function sourceDetail(src: Source): string {
  const keys = Object.keys(src.buckets).sort((a, b) => {
    const ra = BUCKET_ORDER.indexOf(a)
    const rb = BUCKET_ORDER.indexOf(b)
    return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb)
  })
  return keys.map((k) => `${bucketLabel(k)} ${src.buckets[k]}`).join(' · ')
}

/**
 * `nod source register`: unhandled items, who's holding the ball, and whether the sync
 * adapter's heartbeat has gone quiet — the TUI shows the same thing in its summary strip
 * (`src/tui/summary.ts:sourcesLine`). Meant for the sidebar, under the project list.
 */
export function SourcesPanel({ sources }: { sources: Source[] }) {
  if (!sources.length) return null
  return (
    <div class="sources-panel">
      <div class="section-label">{s('sourcesTitle')}</div>
      {sources.map((src, i) => {
        const clear = src.cleared && !src.stale
        const tone = clear ? 'c-green' : src.stale ? 'c-red' : 'c-yellow'
        return (
          <div key={i} class="source-row" title={`${src.title} — ${src.cleared ? s('sourceCleared') : sourceDetail(src)}`}>
            <Rss size={13} strokeWidth={1.75} class={`source-ico ${tone}`} />
            <span class="source-name">{src.name}</span>
            <span class={`source-status ${tone}`}>
              {src.cleared ? s('sourceCleared') : src.unhandled > 0 ? s('sourceUnhandledCount', { count: src.unhandled }) : sourceDetail(src)}
            </span>
            {src.stale && <span class="source-stale c-red">{s('sourceStale')}</span>}
          </div>
        )
      })}
    </div>
  )
}
