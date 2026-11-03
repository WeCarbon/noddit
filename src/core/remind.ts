import type { Decision } from './types.ts'

/**
 * 提醒 / 通知 / 告诉我 / 汇报 / remind / notify / let me know — reminding, reporting to, or
 * notifying the owner is an AI's job, never something filed as the owner's own to-do
 * (`--for me` / `nod assign <id> me`). Both wordings carry "me"/"我", which is how the
 * confusion happens — see cli/commands/send.ts and cli/commands/assign.ts.
 */
const REMIND_WORDS = /提醒|通知|告诉我|汇报|\bremind(?:er|ing|ed)?\b|\bnotify(?:ing)?\b|\blet me know\b/i

export function mentionsRemind(text: string): boolean {
  return REMIND_WORDS.test(text)
}

/**
 * A reminder (`nod add --remind` / `nod edit --remind`) still waiting for its own clock:
 * not idle, so staleness and check-ins leave it alone until then — same idea as a deferred
 * node, just on its own field instead of `deferred_until`.
 */
export function remindsLater(d: Pick<Decision, 'remindAt'>, now = Date.now()): boolean {
  if (!d.remindAt) return false
  const at = Date.parse(d.remindAt)
  return !Number.isNaN(at) && at > now
}
