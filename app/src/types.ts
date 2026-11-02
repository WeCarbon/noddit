/** The shape of `decs bench --json`. */

export interface Seg {
  text: string
  color?: string
  bold?: boolean
  dim?: boolean
}

export type ViewName = 'available' | 'active' | 'decide' | 'all' | 'waiting' | 'live'

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

export interface Node {
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
  deferred_at: string | null
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
