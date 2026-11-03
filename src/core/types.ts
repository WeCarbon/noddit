import { OPTION_LABEL } from './format.ts'
import type { DecisionQuestion } from './questions.ts'

/** One selectable option inside a decision, e.g. "A · 维持现状". */
export interface DecisionOption {
  /** Short key the owner types: "A", "B", "1", "2"… */
  key: string
  /** One-line label, from the `### <key> · <label>` heading. */
  label: string
  /** Prose under the heading — usually the cost analysis. May be empty. */
  body: string
}

export interface Attachment {
  /** Link text — a filename, or whatever `--name` said. */
  label: string
  /** Path relative to `decisions/`, or an absolute path, or a URL. */
  target: string
  /** Images are written as `![]()` so any markdown viewer renders them inline. */
  image: boolean
  /**
   * `--label "选项 1"` — attachments sharing a group render side-by-side (or
   * switchable with ←/→) in bench, e.g. a before/after or option-A/option-B
   * comparison. Rendered as a `**<group>**` sub-heading above the attachment
   * in `## 附件`, so a plain markdown viewer still shows which is which.
   */
  group?: string
  /**
   * `--caption "…"` — one line of prose under the attachment, e.g. where a
   * screenshot came from. Rendered as an italic line directly below the
   * markdown link.
   */
  caption?: string
}

/**
 * Outbound content the owner must approve before sending — see `decs attach
 * --approval-content` / `decs approved --check`. `hash` updates on every
 * (re-)attach; `approvedHash` only moves when the owner answers (see
 * `Store.answer`) — the two falling out of step is "changed since approval".
 */
export interface AttachmentApproval {
  /** Same string as the matching `Attachment.target` — the join key. */
  target: string
  /** `sha256:<hex>` of the file's current content. */
  hash: string
  /** `sha256:<hex>` the owner last approved, if ever. */
  approvedHash?: string
  approvedAt?: string
  approvedBy?: string
  /**
   * The answers that count as approving this content (`--approve-on`):
   * option keys (`1`) or sub-question answers (`Q2:1`); any one matching is
   * enough. Absent only on records written before the flag existed — those
   * fall back to "the node's only option", and approve nothing when there is
   * more than one.
   */
  approveOn?: string[]
  /**
   * The owner's latest answer when it was NOT one of `approveOn` — e.g. `2`.
   * Kept so `decs approved --check` can say why it refuses ("答复是 2，不算批准").
   */
  declined?: string
}

export interface DecisionAnswer {
  /** The chosen option key. Absent for free-text answers (验收 / 多问合一). */
  choice?: string
  /** Per sub-question: `{ Q1: 'B', Q2: '1' }`. See core/questions.ts. */
  answers?: Record<string, string>
  /** Per sub-question free text, e.g. the 改法 for a review item answered 改. */
  answerNotes?: Record<string, string>
  /** The owner's own words. */
  note?: string
  by: string
  at: string
}

/** Two-valued view derived from `state`, kept because the bench still speaks it. */
export type DecisionStatus = 'open' | 'answered'

/**
 * Where an item is. Tasks and decisions are one thing sharing one status
 * line; a running task that hits a question becomes `needs_decision`
 * without becoming a second entry. Older files say `open`/`answered`,
 * mapped on read (see `parse.ts`).
 */
export type ItemStatus = 'not_started' | 'in_progress' | 'waiting' | 'needs_decision' | 'decided' | 'completed' | 'closed'

export const ITEM_STATUSES: readonly ItemStatus[] = [
  'not_started', 'in_progress', 'waiting', 'needs_decision', 'decided', 'completed', 'closed',
]

/** Who wrote an appended section. Only a human's words are a request — an
 *  agent's own notes must never wake anyone or revive an archived entry. */
export type NoteRole = 'human' | 'agent'

/**
 * One appended `## 追问（human · owner · 2026-10-28 10:51:30）` section.
 * Derived from the body on every read — the heading is the only copy.
 */
export interface DecisionNote {
  /** The heading word: 已答 / 追问 / 补充 / 已看过 / 执行记录 / whatever `--heading` said. */
  kind: string
  role: NoteRole
  author: string
  /** ISO timestamp with offset, as precise as the heading was (minutes on old entries). */
  at: string
  text: string
  /** The heading line as written, minus `## `. */
  heading: string
  /** The invisible `<!-- nod:by=<identity> -->` marker, if the write that
   *  made this section left one — see `core/identity.ts`. Absent on
   *  anything written before the marker existed, or with no identity set. */
  writer?: string
  /** The invisible `<!-- nod:summary=… -->` marker (N203/N205): a one-line
   *  summary of `text`, shown as a title wherever there isn't room for the
   *  whole reply. Absent on an older note, or a short one that never needed one. */
  summary?: string
  /** This note's own `## 附件` block — attached with `nod note --attach` or
   *  `nod attach --to` pointed here. Empty when this note has none. */
  attachments: Attachment[]
}

/**
 * A settled `## 选项（第 N 轮）` round, older than the node's current one —
 * history, not live state. Reconstructed from the body on every read (the
 * round's own `## 已答` note is the only copy); never applies to the node's
 * live `answer`/`questions`. See `core/parse.ts#parsePreviousRounds`.
 */
export interface PreviousRound {
  round: number
  options: DecisionOption[]
  /** That round's own sub-questions (if `--question` asked any), for
   *  labelling `subAnswers`' keys — never the node's current `questions`. */
  questions: DecisionQuestion[]
  /** The rendered `<choice> —— <label>` headline from that round's `## 已答`,
   *  or undefined if the round was superseded before anyone answered it. */
  answer?: string
  /** Per sub-question answers recorded for that round, if it asked any. */
  subAnswers?: Record<string, string>
  by?: string
  at?: string
}

/** 「做完了，等你看一眼」 — a decision whose only option is `验收通过`. */
export const ACCEPTANCE_OPTION = { key: '1', label: OPTION_LABEL.accept }
/** An fyi entry needs no answer, but one key to clear it from the bench is still handy. */
export const FYI_OPTION = { key: '1', label: OPTION_LABEL.fyi }

/** How soon the owner should look. Absent in front matter means normal. */
export type Urgency = 'high' | 'normal' | 'low'

/**
 * - `decision`: the owner has to weigh options.
 * - `acceptance`: 「做完了，等你看一眼」 — one 验收通过 option. Derived, not stored.
 * - `fyi`: 「告诉你一声，不用回」 — kept out of every "waiting on you" list.
 */
export type DecisionKind = 'decision' | 'acceptance' | 'fyi' | 'task'

export interface Decision {
  id: number
  title: string
  /** `<agent name> · <what it was doing>` — required, never inferred. */
  author: string
  /** The real status. See ItemStatus. */
  state: ItemStatus
  /** Legacy two-valued view of `state`, for the bench. */
  status: DecisionStatus
  /** Why it was closed: `superseded`, `obsolete`, `merged-into:W15`, or free text. */
  closeReason?: string
  /** 等待: who/what outside this is held up on. Not a decs ref — that's `after`. */
  waitingOn?: string
  /** 等待: the day (an ISO stamp) to check back on whoever it waits on. Read only while waiting. */
  waitingUntil?: string
  /** 延迟: a flag on top of `state`, not a state of its own; hides the subtree. */
  deferredAt?: string
  /** Who deferred it — `owner`, or the lane that did it for them. */
  deferredBy?: string
  /** `nod defer --until`: back in the working lists from this moment on. Absent = until undeferred. */
  deferredUntil?: string
  /**
   * Who does it. Absent = an AI. `human` = the owner: an agent never works on it,
   * never gets checked in on or nagged about it, never picks it up as a brief.
   */
  assignee?: string
  created: string
  /** Stamped on every write. */
  updatedAt?: string
  /** Latest `updatedAt` in this node's subtree. Derived by `Store.all()`, never stored. */
  activeAt?: string
  /** Option key that happens if the owner never answers. */
  default?: string
  /** The owner touched this and no agent has picked it up yet (see `core/queue.ts`). */
  queued?: boolean
  /**
   * Where the owner put it by hand among the nodes it is listed with: lower first. Absent is 0 —
   * nodes arranged above the rest are negative, the rest keep the view's own order (core/order.ts).
   */
  order?: number
  /** Absent = normal. See core/order.ts for how it sorts. */
  urgency?: Urgency
  /** 到期日: when the node is due — the work done, or the answer given, by then (once two meanings, now one; same key). ISO. */
  due?: string
  /** A key date the owner marked: `due` is the date, counted down on the bench. */
  milestone?: boolean
  /** 提醒: when an AI should tell the owner something (`nod add --remind` / `nod edit
   *  --remind`) — never the owner's own to-do. ISO. See core/remind.ts. */
  remindAt?: string
  /** What the proposer will do if nobody answers — the 「你不回的话」 line, as data. */
  ifNoAnswer?: string
  /** Whether that default action can be undone. */
  reversible?: boolean
  kind: DecisionKind
  /** The agent session (CLAUDE_SESSION_ID or NODDIT_SESSION/DECS_SESSION) that filed it. */
  session?: string
  // Execution fields. Stored and parsed here; what they mean is the
  // progress/sequence layer's business.
  /** 0–100. */
  progress?: number
  /** One line: 「gate 37%」. */
  progressMsg?: string
  /** Refs this item waits on before it can start: `['T1', '12']`. See `isStartable`. */
  after?: string[]
  /** Estimate, free form: `2h`, `0.5 人日`. */
  est?: string
  /** R: how often it comes round (`3d`, `1w`) — 「延迟 R 天」 puts it off to today + R. Only a shortcut for the defer date. */
  every?: string
  /** When it is planned to happen, free form. */
  when?: string
  /** How long without an update counts as stuck: `90m`. */
  staleAfter?: string
  /** Step list, shape owned by the progress layer. */
  steps?: unknown
  /** Which lane runs it; defaults to `author`. */
  ownerAgent?: string
  /** 派活: the owner filed a few words for an AI to pick up and expand (see core/intake.ts). */
  intake?: boolean
  /** Who picked the brief up, and when — set once, under the node's lock (`Store.claim`). */
  claimedBy?: string
  claimedAt?: string
  /** The node this one refines. Not stored — it's where the file sits (`listEntryFiles`). */
  parent?: number
  /** Direct children's ids. Filled in by `Store.all()`; absent on a single reread. */
  children?: number[]
  /** Check-in asks on this node (`core/checkins.ts`), freshly read on every
   *  `Store.all()` call since the ask count can change with no write to the
   *  node itself. Absent when it has never been asked. */
  checkin?: { asked: number; lastAskedAt: string; unanswered: boolean }
  /** Unknown front matter keys, kept verbatim so a newer tool's fields survive. */
  extra?: Record<string, unknown>
  /** Set on an entry another one replaced: `decs supersede`. */
  supersededBy?: number
  /** The entries this one replaced. */
  supersedes?: number[]
  answer?: DecisionAnswer
  /** Last time the entry was filed into archived/. */
  archivedAt?: string
  /** 「归档后有新回复」 flag; meaningful only while newer than `archivedAt`. */
  reopenedAt?: string
  tags: string[]
  /** Everything after the front matter, verbatim. */
  body: string
  /** Parsed out of `## 选项` in the body; empty when the entry has no options. */
  options: DecisionOption[]
  /** Parsed out of the current round's `## 子问题`; empty for an ordinary
   *  node, or once a later `decs ask` round didn't ask any of its own. */
  questions?: DecisionQuestion[]
  /** Earlier `## 选项（第 N 轮）` rounds, each with whatever it was answered —
   *  history for the app/TUI to show collapsed. See `PreviousRound`. */
  previousRounds?: PreviousRound[]
  /** Every `## 附件` in the body, flat and in file order — the concatenation
   *  of `bodyAttachments` and every note's own `attachments`. Kept for
   *  whatever wants one flat numbered list (the bench's picker, `nod open`). */
  attachments: Attachment[]
  /** Just the body's own `## 附件` — the ones attached before any note, or
   *  explicitly with `--to body`. */
  bodyAttachments: Attachment[]
  /** Every appended answer / follow-up / record, in body order. */
  notes: DecisionNote[]
  /** Approval bookkeeping for `## 附件` entries attached with `--approval-content`. */
  approvals: AttachmentApproval[]
  file: string
  slug: string
  archived: boolean
  /** Basename of the project root: the stable key (`web#305`, `web:305`). */
  project: string
  /** What the project is shown as — `decs config name`, else `project`. Filled in by the Store. */
  projectName?: string
  /** Display letter — `W` in `W305`. Filled in by the Store from `decisions/decs.json`. */
  letter?: string
}

/** What `decs send` needs to mint a new entry. */
export interface NewDecision {
  title: string
  author: string
  /** Sub-questions; the node's own options are then generated. */
  questions?: DecisionQuestion[]
  body?: string
  options?: { key: string; label: string; body?: string }[]
  default?: string
  tags?: string[]
  urgency?: Urgency
  due?: string
  remindAt?: string
  ifNoAnswer?: string
  reversible?: boolean
  /** Only `fyi` is stored; decision vs acceptance follows from the options. */
  kind?: 'fyi'
  /** A task: no options, starts as not_started. */
  task?: boolean
  session?: string
  /** Ref of the node this one refines; it is written into that node's folder. */
  parent?: string
  after?: string[]
  est?: string
  every?: string
  when?: string
  staleAfter?: string
  /** 派活: a brief for an AI to expand. The owner's words go under `## 原话`, verbatim. */
  intake?: boolean
  /** `human` for the owner's own to-do; absent for AI work. */
  assignee?: string
  milestone?: boolean
}

/** Tasks and decisions are one entity; this is its name in new code. */
export type Item = Decision
