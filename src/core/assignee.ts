import { t } from '../i18n/index.ts'
import type { Decision } from './types.ts'

/** The stored value for the owner's own to-do. */
export const HUMAN = 'human'

/**
 * A node for a person to do, not an AI: never started, checked in on, nagged
 * about or picked up as a brief by an agent. Agents may file one for the
 * owner ("call the vendor") and read it, nothing more.
 */
export const isHumanTask = (d: Pick<Decision, 'assignee'>) => Boolean(d.assignee) && d.assignee !== 'ai'

/**
 * The third kind, alongside a person's own to-do and an AI's: a goal with
 * sub-goals and work under it. Reuses `milestone` (N248/N250 dropped the
 * menu entries and the ⚑ countdown, but kept the field; this brings the
 * glyph back as a node kind, not a highlighted date). Never started or
 * finished by itself — see `core/checkins.ts`, `core/tidy.ts`.
 */
export const isMilestone = (d: Pick<Decision, 'milestone'>) => Boolean(d.milestone)

/** `--for me|ai` / `nod assign <id> me|ai`: what is stored — `human`, or undefined for an AI. */
export function assigneeArg(raw: string): string | undefined {
  const v = raw.trim().toLowerCase()
  if (['me', 'human', 'owner', 'person', 'moi', '我', '人'].includes(v)) return HUMAN
  if (['ai', 'agent', 'bot', 'ia', '机器', '機器'].includes(v)) return undefined
  throw new Error(t('cli.assign.badWho', { value: raw }))
}

/** `nod assign <id> milestone` / `--milestone`: the word for the third kind. */
export const isMilestoneWord = (raw: string) => ['milestone', 'goal', '里程碑', '目标'].includes(raw.trim().toLowerCase())
