/** The shape of `decs bench --json`. */

export interface Seg {
  text: string
  color?: string
  bold?: boolean
  dim?: boolean
}

export type ViewName = 'available' | 'active' | 'decide' | 'waiting' | 'live' | 'all'

export interface Row {
  key: string
  kind: 'node' | 'header' | 'fold'
  depth: number
  fold: string | null
  text?: string
  count?: number
  node?: string
  ref?: string
  title?: string
  state?: string
  glyph?: Seg
  mark?: 'strong' | 'weak' | null
  has_kids?: boolean
  /** Rows sharing a scope can be put in order by hand (drag, ⌥↑/⌥↓); null where the list keeps its own order. */
  scope?: string | null
  collapsed?: boolean
  context?: boolean
  deferred?: boolean
  /** 延迟 on the node itself: `passive` (grey) or `active` (waiting on someone — purple). */
  delay?: 'passive' | 'active' | null
  /** 预估 still ahead, in minutes: this node, or a parent's whole subtree, by whose time. */
  estimate?: { human: number; ai: number } | null
  progress?: number | null
  badge?: Seg[]
  badge_short?: Seg[]
  /** Who does it: the owner's own to-do (`human`) or an AI's. */
  assignee?: 'human' | 'ai'
  human_task?: boolean
  deferred_until?: string | null
  /** A decision an AI is stuck on. */
  blocks_ai?: boolean
  /** The owner's mark: ★ important, ⚑ a milestone counted down to `due`. */
  flag?: 'important' | 'milestone' | null
  due?: string | null
  /** 等待: the day to check back, and whether it has come. */
  waiting_until?: string | null
  wait_due?: boolean
  /** Recent: what the owner last did here. */
  touch?: { kind: string; at: string; text: string; choice?: string; label: string }
}

export interface View {
  view: ViewName
  /** A lucide icon name, from the view's definition. */
  icon?: string
  label: string
  empty: string
  count: number | null
  /** Waiting nodes due to be checked on, among those counted. */
  due_count?: number
  rows: Row[]
}

export interface Option {
  key: string
  label: string
  body: string
}

export interface Question {
  key: string
  label: string
  default: string | null
  options: Option[]
}

/** A sub-question answer of this value means free text instead of an option — see
 *  `OTHER_KEY` in `src/core/questions.ts`, which this must keep matching. */
export const OTHER_KEY = '*'

/** An earlier `nod ask` round of a node, with what it was answered — history, not live state. */
export interface PreviousRound {
  round: number
  options: Option[]
  /** That round's own sub-questions. */
  questions: Question[]
  /** `<choice> —— <label>`, or null when the next round replaced it unanswered. */
  answer: string | null
  sub_answers: Record<string, string> | null
  by: string | null
  at: string | null
}

export interface BodyRow {
  text: string
  image?: number
  style?: Seg
}

export interface Image {
  name: string
  alt: string
  target: string
  path: string
  source: 'body' | 'attachment'
  attachment: number | null
  group: string | null
  caption: string | null
}

export interface Attachment {
  label: string
  target: string
  path: string
  image: boolean
  group: string | null
  caption: string | null
}

/** `nod attach --approval-content`: outbound content the owner must sign off before it's sent.
 *  `target` is the matching `Attachment.target` — the join key. */
export interface Approval {
  target: string
  /** `sha256:<hex>` of the file's current content. */
  hash: string
  /** Answers that count as approving it (option keys or `Q2:1`); null on records from before the flag existed. */
  approve_on: string[] | null
  /** `sha256:<hex>` last approved, if ever. */
  approved_hash: string | null
  approved_by: string | null
  approved_at: string | null
  /** The answer that declined it (did not match `approve_on`), if any. */
  declined: string | null
}

export interface Node {
  /** Only from a one-node reload (`bench --json --node`): how its list row looks now. */
  row?: Partial<Row>
  key: string
  id: number
  ref: string
  project: string
  project_name?: string
  file: string
  title: string
  author: string
  who: string
  status: string
  status_label: string
  kind: string
  default: string | null
  options: Option[]
  questions: Question[]
  previous_rounds?: PreviousRound[]
  answer: { choice?: string; note?: string; by: string; at: string } | null
  answers: Record<string, string> | null
  /** A sub-question answered `OTHER_KEY`: the free text that was typed, keyed the same way as `answers`. */
  answer_notes: Record<string, string> | null
  deferred_at: string | null
  /** The deferral on record was an agent's, not the owner's. */
  deferred_by_ai?: boolean
  /** 预估, free form (`2h`): the assignee's time — the owner's (`est_who: human`) or an AI's. */
  est?: string | null
  est_who?: 'human' | 'ai'
  /** R: 「延迟 R 天」 puts it off to today + this (`3d`, `1w`). */
  every?: string | null
  parent: number | null
  children: number[]
  can_default: boolean
  /** Where the owner put it by hand: negative above the rest, null if never moved. */
  order?: number | null
  urgency: 'high' | 'normal' | 'low'
  status_line: Seg[]
  meta: Seg[][]
  body_rows: BodyRow[]
  images: Image[]
  attachments: Attachment[]
  /** The description as written (markdown), for editing it. */
  description?: string
  /** The body's own attachments (each note carries its own). */
  body_attachments?: Attachment[]
  terminal: boolean
  backlinks: string[]
  progress: number | null
  progress_msg: string | null
  /** The owner's own words, filed with Cmd+K for an AI to expand. */
  intake?: boolean
  brief?: 'unclaimed' | 'claimed' | null
  claimed_by?: string | null
  claimed_at?: string | null
  original?: string | null
  steps: unknown
  created: string
  updated_at: string | null
  due: string | null
  /** 等待: who/what, and the day to check back. */
  waiting_on?: string | null
  waiting_until?: string | null
  /** The owner's marks (nod flag). */
  assignee?: 'human' | 'ai'
  human_task?: boolean
  deferred_until?: string | null
  important?: boolean
  milestone?: boolean
  if_no_answer: string | null
  reversible: boolean | null
  notes: Note[]
  staleness: 'fresh' | 'stale'
  /** How often `nod monitor` asked this running node for an update, and whether three went unanswered. */
  checkin?: { asked: number; last_asked_at: string; unanswered: boolean } | null
  parent_node: NodePill | null
  after_nodes: NodePill[]
  blocking_nodes: NodePill[]
  archived: boolean
  /** Outbound attachments pending the owner's approval, or already ruled on. */
  approvals: Approval[]
}

export interface NodePill {
  key: string | null
  ref: string
  title: string | null
  state: string | null
  glyph: Seg | null
}

export interface Note {
  kind: string
  role: 'human' | 'agent'
  author: string
  at: string
  text: string
  /** A one-line summary (N203/N205's `--summary`), shown instead of `text` wherever there isn't
   *  room for the whole reply — a notice, a note card's title, the TUI. Absent on a short note
   *  (which is its own summary) or one written before `--summary` existed. */
  summary?: string | null
  /** A 已答 that replaces an earlier answer to the same round — drawn as its own block, labelled as a change. */
  revises?: boolean
  /** This note's own attachments. */
  attachments?: Attachment[]
}

export interface Project {
  /** The folder name: the key in node keys (`web#305`). */
  project: string
  /** An AI session's monitor is live in it (newer CLIs only). */
  listening?: boolean
  /** What people see: `decs config name`, else the folder name. */
  name: string
  letter: string
  former_letters?: string[]
  root: string
  /** Tasks nobody has started or is deciding (not deferred). */
  stale_count?: number
}

/** One node in an `after` loop — `nod check` reports the same list as an error. */
export interface CycleNode {
  key: string
  ref: string
  id: number
  project: string
  title: string
}

/** `nod source register`: one issue tracker / inbox / feedback form the project reads from. */
export interface Source {
  project: string
  project_letter: string
  name: string
  title: string
  kind: string
  owner_agent: string | null
  adapter: string | null
  /** Non-deleted items known about. */
  total: number
  unhandled: number
  /** Among undone items, grouped by where the ball is: `unhandled`, `owner`, `us`, or a name. */
  buckets: Record<string, number>
  heartbeat_at: string | null
  heartbeat_age_ms: number | null
  /** No heartbeat within the source's staleAfter — the adapter is probably dead. */
  stale: boolean
  /** No unhandled items, and nothing parked on owner/us/an open node ref. */
  cleared: boolean
}

export interface Bench {
  now: string
  lang: string
  rtl: boolean
  labels: { defaultMark: string }
  projects: Project[]
  views: View[]
  nodes: Record<string, Node>
  /** One per project: its live tree, shown when the project is picked in the sidebar. */
  project_views?: { project: string; count: number; empty: string; rows: Row[] }[]
  /** Deferrals this read ended: each says so once. */
  back_from_deferral?: { key: string; ref: string; title: string; text: string }[]
  /** `after` forming a loop: every node in each chain is permanently unstartable. */
  cycles?: CycleNode[][]
  /** Registered external sources (issues/mail/feedback), cleared or not. */
  sources?: Source[]
  /** ⚡ the daily Nod counter — every registered project, archived nodes
   *  included (`core/nods.ts`'s `NodsSummary`). */
  nods: NodsSummary
}

export interface NodsDay {
  date: string
  count: number
}

export interface NodsSummary {
  today: number
  yesterday: number
  /** Mean of `days` (7 local days, today included). */
  avg7: number
  /** Oldest first, 7 entries, the last one today. */
  days: NodsDay[]
}

/**
 * One line of `decs monitor --updates --json`. `event: 'updated'` is the only
 * kind the app reads structurally (N258) — `changed` names exactly which
 * nodes to reload, `key` matching `Bench.nodes`; everything else (brief,
 * unclaimed, checkin, stale, warn, …) is handled as a reason to do a full
 * `loadBench()` instead.
 */
export interface MonitorUpdated {
  event: 'updated'
  refs: string[]
  changed: { key: string; ref: string; id: number; project: string; file: string }[]
  gone: string[]
  owner_facing: string[]
  at: string
}

export interface ShellEnv {
  path: string
  node: string | null
  node_version: string | null
  npm: string | null
  decs: string | null
  decs_version: string | null
}

export interface RunOutput {
  code: number
  stdout: string
  stderr: string
}
