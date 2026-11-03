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
  all of them) and in the desktop app (⌘-click, ⇧-click, a dragged box).
- The bench's header and the app's sidebar pin a cross-project "main agent"
  row; `Ctrl-L` (bench) or a click (app) goes to its terminal, or starts one
  if it's offline. A matching key/menu item starts a session for any node's
  own project directly.
- The terminal board's view editor (`v`) adds, edits, reorders and deletes
  custom bench tabs with the same fields as `nod view edit`.
- A new milestone node type in the desktop app, alongside human and AI work.
- `nod after --before <dep> <id> <id>...` hangs one dependency on several
  nodes in a single call.

### Changed

- `nod monitor` wakes on filesystem events instead of polling on a timer.
- The bench's former "Decide" tab is renamed **Human work** and now also
  lists the owner's own to-dos, not only decisions waiting on an answer.
- A linked attachment inside a registered project previews inline; a
  refused preview says why instead of loading forever.
- The sidebar's project letter / main-agent icon now leads each row, with
  the live indicator at the end.

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
