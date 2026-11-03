import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { asQuote } from './launch.ts'
import type { SessionTerminal } from './terminal.ts'

/**
 * `nod session goto`: finds the iTerm2 session or Terminal.app tab a
 * monitor's heartbeat recorded (core/terminal.ts) and brings it to the
 * front. Building the script is pure (testable); running it is a separate
 * step, so tests never shell out to `osascript` or touch a real window.
 *
 * Each script is guarded by `if application "…" is running then` — merely
 * naming an application in a `tell` block launches it, which would open a
 * fresh default window exactly when there is nothing to switch to.
 */

function iterm2GotoScript(id: string): string {
  return [
    'if application "iTerm" is running then',
    '  tell application "iTerm"',
    `    set targetId to ${asQuote(id)}`,
    '    set found to false',
    '    repeat with w in windows',
    '      repeat with t in tabs of w',
    '        repeat with sess in sessions of t',
    '          if (id of sess) is targetId then',
    '            select sess',
    '            select t',
    '            tell w to select',
    '            set found to true',
    '          end if',
    '        end repeat',
    '      end repeat',
    '    end repeat',
    '    if found then',
    '      activate',
    '      return "found"',
    '    end if',
    '  end tell',
    'end if',
    'return "not_found"',
  ].join('\n')
}

function terminalGotoScript(tty: string): string {
  return [
    'if application "Terminal" is running then',
    '  tell application "Terminal"',
    '    set found to false',
    '    repeat with w in windows',
    '      repeat with tb in tabs of w',
    `        if (tty of tb) is ${asQuote(tty)} then`,
    '          set selected tab of w to tb',
    '          set index of w to 1',
    '          set found to true',
    '        end if',
    '      end repeat',
    '    end repeat',
    '    if found then',
    '      activate',
    '      return "found"',
    '    end if',
    '  end tell',
    'end if',
    'return "not_found"',
  ].join('\n')
}

/** The AppleScript that selects `terminal`'s session/tab and brings its app to the front. */
export function gotoSessionScript(terminal: SessionTerminal): string {
  return terminal.type === 'mac-iterm2' ? iterm2GotoScript(terminal.id) : terminalGotoScript(terminal.id)
}

/**
 * Runs the script and reports whether the session was still there.
 * `NODDIT_LAUNCH_RECORD=<file>` (the same seam `core/launch.ts` uses) appends
 * it as one JSON line instead, so no suite ever shells out for real.
 */
export function runGotoSession(terminal: SessionTerminal): boolean {
  const record = process.env.NODDIT_LAUNCH_RECORD
  const script = gotoSessionScript(terminal)
  if (record) {
    appendFileSync(record, `${JSON.stringify({ kind: 'goto', terminal, script })}\n`)
    return true
  }
  try {
    const out = execFileSync('osascript', ['-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 })
    return out.trim() === 'found'
  } catch {
    return false
  }
}
