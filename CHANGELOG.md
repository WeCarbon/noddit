# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and version numbers follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.0] - 2026-11-03

### Added

- Human work, alongside an AI's: `nod add --for me` files a to-do that's
  yours, not an AI's, and `nod assign <id> me|ai` moves a node between the
  two. The bench's **Human work** tab lists both — decisions waiting on you
  and your own to-dos.
- Milestones: `nod add --milestone` (or `nod assign <id> milestone`) marks a
  node as a goal with sub-goals and work under it. Never started or finished
  on its own; shown as `⚑` with a done/total count for its children.
- Due dates, estimates and a repeat cadence on any node: `--due <date>`,
  `--est 2h` (whose time it costs — yours or the AI's), `--every 3d` (how
  often it comes round, for `nod defer --every`).
- Reminders: `nod add --remind "fri 2pm"` / `nod edit --remind` schedules a
  plain AI task for that moment. `nod monitor` tells the node's own agent
  once, with its next step; the desktop app reminds the owner too.
- Replies and notes over a line or two now require `--summary`; that one
  line, not the full text, is what a notice, a reply card and the bench show.
- External sources can sync on their own schedule: `nod source register
  --sync-cmd "..." --every 10m` runs the command on an interval while a
  `nod monitor` session is open, with the command itself stored only on the
  local machine, never in the repo.
- Multi-select on the bench (`Space` marks rows; `d D s @ ! A` then act on
  all of them) and in the desktop app (⌘-click, ⇧-click, a dragged box —
  which can start on a row too, not just empty list space, as long as the
  row itself isn't draggable).
- The bench's header and the app's sidebar pin a cross-project "main agent"
  row; `Ctrl-L` (bench) or a click (app) goes to its terminal, or starts one
  if it's offline. A matching key/menu item starts a session for any node's
  own project directly.
- The terminal board's view editor (`v`) adds, edits, reorders and deletes
  custom bench tabs with the same fields as `nod view edit`.
- A new milestone node type in the desktop app, alongside human and AI work.
- `nod after --before <dep> <id> <id>...` hangs one dependency on several
  nodes in a single call.
- A daily Nod counter: ⚡ in the app's sidebar (above Views) and in the
  terminal board's header, counting every owner action — a reply, a
  decision answered, a node filed directly by the owner — across every
  registered project, archived included. Shows today, yesterday and the
  7-day average (floored to a whole number), and updates the instant the
  owner acts rather than waiting for the next refresh.
- A calendar button next to ⚡ (`c` on the terminal board) opens the Nod
  calendar, a GitHub-style heatmap of the owner's Nods over the last year.
- Two notice sounds — "AI update" and "Needs a decision" — synthesized
  live with Web Audio, no audio file. Settings has an on/off switch, an
  A/B variant and a preview button for each, plus one shared volume slider.
- Every answer is its own block in a node's history, labelled "Decided";
  changing an already-locked answer (pencil icon) adds a new block labelled
  "Answer changed" instead of rewriting the old one.
- Node refs written in prose (`G91`) are clickable links in the desktop
  app — in titles, bodies, notes, summaries and options.
- `NODDIT_WORKTREE` tells a lane's own worktree apart from another lane's
  when both are forced to run `nod` from one shared checkout.

### Changed

- `nod monitor` wakes on filesystem events instead of polling on a timer.
- The bench's former "Decide" tab is renamed **Human work** and now also
  lists the owner's own to-dos, not only decisions waiting on an answer.
- A linked attachment inside a registered project previews inline; a
  refused preview says why instead of loading forever.
- The sidebar's project letter / main-agent icon now leads each row, with
  the live indicator at the end.
- A node with any unanswered option is always **needs decision**, even one
  that's running or not started; a reply that doesn't pick an option hands
  that round back to the agent instead of settling it.
- The bench's **Available** tab also lists blocked nodes (queued behind
  another node via `--after`); **Active** still leaves them out.

### Fixed

- Windows: the process tree is walked in one PowerShell call per process
  instead of one call per ancestor, cutting several seconds off every
  `nod start` / `nod progress` and monitor startup; `--with-parent` checks a
  direct parent's liveness the same way.
- The desktop app's background snapshot is written at most every five
  minutes, and on hide or quit, instead of on every refresh — it had been
  writing megabytes to disk each time.
- A link whose target has balanced parentheses in the file name (e.g.
  `a(b).png`) is read in full and rewritten in full, instead of being cut at
  the first `)`.
- The app's refresh requests no longer silently drop one that lands in the
  gap right as another refresh is finishing (e.g. a language change racing
  the 60-second timer or a file-change event).
