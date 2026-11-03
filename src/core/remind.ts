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
