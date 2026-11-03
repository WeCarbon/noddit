// SessionStart: inject decs's rules unconditionally (a skill only loads when
// the model thinks it's relevant) and list this project's open nodes so a
// resumed session picks its own work back up. The main session
// (src/core/main-session.ts) gets its own block first, and its own store's nodes.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { modulePath, moduleUrl } from './resolve.mjs'

const { t } = await import(moduleUrl('src', 'i18n', 'index.ts'))
const { ensureMainStore, isMainSession } = await import(moduleUrl('src', 'core', 'main-session.ts'))

// The rules are English whatever the interface language; the lines added below follow it.
const here = dirname(fileURLToPath(import.meta.url))
let text = readFileSync(join(here, 'rules.md'), 'utf8')
const main = isMainSession()
if (main) text = `${readFileSync(join(here, 'main-rules.md'), 'utf8')}\n${text}`
const scope = main ? ['--dir', ensureMainStore().projectRoot] : []

try {
  const raw = execFileSync(process.execPath, [modulePath('bin', 'decs.ts'), 'show', 'active', '--json', ...scope], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 8000,
  })
  const shown = new Set(['not_started', 'in_progress', 'needs_decision', 'decided'])
  const open = JSON.parse(raw).filter((n) => shown.has(n.status))
  text += `\n\n${t('plugin.sessionStart.monitorRunning')}\n`
  if (open.length) {
    const lines = open.slice(0, 30).map((n) => `${n.ref} · ${t(`common.status.${n.status}`)} · ${n.title} — ${n.author}`)
    const more = open.length > 30 ? `\n${t('plugin.sessionStart.more', { count: open.length - 30 })}` : ''
    text += `\n\n## ${t('plugin.sessionStart.openHeading')}\n\n${lines.join('\n')}${more}\n`
  }
} catch {
  /* no decisions/ here, or decs failed — the rules alone still apply */
}

// The harness caps additionalContext at 10,000 characters.
if (text.length > 9500) text = `${text.slice(0, 9500)}\n${t('plugin.sessionStart.truncated')}`
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }))
