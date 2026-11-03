import { useEffect, useState } from 'preact/hooks'
import { Bot } from 'lucide-preact'
import * as api from './backend.ts'
import { gotoSessionLabelKey } from './goto-label.ts'
import { s } from './strings.ts'

/** How often to re-read the main session's heartbeat — the pace monitors write it at. */
const POLL_MS = 30_000

/**
 * The sidebar's 主智能体 row: whether the cross-project main session is live,
 * and a click that brings its terminal to the front. The owner talks to it
 * there, in its terminal — this row never sends it anything.
 */
export function MainAgentEntry({ onToast }: { onToast: (text: string) => void }) {
  const [main, setMain] = useState<api.Session | null | undefined>(undefined)
  useEffect(() => {
    let gone = false
    const read = () => void api.mainSession().then((m) => !gone && setMain(m))
    read()
    const t = setInterval(read, POLL_MS)
    return () => {
      gone = true
      clearInterval(t)
    }
  }, [])
  const online = Boolean(main)
  const terminal = main?.terminal
  const title = !main ? s('mainAgentOffline') : terminal ? s(gotoSessionLabelKey(terminal.type)) : s('listening', { who: main.author ?? main.harness ?? 'AI' })
  const go = () => {
    if (!terminal) return
    void api.gotoMainSession().then((found) => {
      if (!found) onToast(s('sessionGone'))
    })
  }
  return (
    <div class={`project main-agent ${online ? '' : 'offline'}`} title={title} onClick={go} aria-disabled={!terminal}>
      <span class={`live-dot ${main === undefined ? 'unknown' : online ? 'on' : 'off'}`} />
      <span class="letter">
        <Bot size={12} strokeWidth={1.75} />
      </span>
      <span class="label">{s('mainAgent')}</span>
    </div>
  )
}
