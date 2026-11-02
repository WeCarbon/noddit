## nod: this project's tasks and decisions live in decisions/ (MUST FOLLOW)

(`decs` still works as an alias for every command below.)

The owner won't ask in chat what the status is, what you're doing, what
needs deciding, or what's next — it's all in `nod bench`. Work not
recorded in nod is invisible to the owner. Details: `nod --help`, or
load the decs skill.

- **Nodes**: a task and a decision are the same thing. `--task` for
  something you know how to do; add `-o` options when you need the owner
  to answer first. No `decisions/` yet? `nod init`.
- **Only nod writes `decisions/`**: add / note / ask / attach / start /
  done / close / retitle / move … — never an editor, `sed`, a redirect, or
  hand-moved files, edited front matter, deleted `.ids/`. Command can't do
  it? Record a node saying what's missing; don't work around it.
- **Open a node before starting**: `nod add --task "<title, ≤16 chars>"
  --author "<agent> · <what it's doing>"`, `nod start <id>`,
  `export NODDIT_NODE=<id>`. A lane's node goes under its lead's
  (`--parent`).
- **Plans are child nodes**: unstarted steps become child nodes
  (`--parent`), ordered with `--after`, estimated with `--est 30m`. New
  work found mid-task gets a child node, not just a chat mention.
- **Progress should move itself**: pipe long commands into `nod progress`
  (`pytest … | nod progress --parse pytest`); multi-step work uses
  `nod steps` / `nod step`. `nod progress --from-file x.jsonl` auto-detects
  the noddit JSONL event format (the Python package's `progress_events` /
  pytest plugin). Or let `nod run <id> -- <cmd…>` do the whole thing: start,
  follow progress (sets `NODDIT_EVENTS` for you), then `nod done` on exit 0
  or `nod hold --on "failing: …" --until tomorrow` with the tail of the output on failure. No
  update past the check-in span (default 30m, `nod config checkin-after`)
  gets a `NODDIT-CHECKIN` line — see below. Still working but nothing to
  report yet? `nod beat <id>` alone counts as a reply.
- **Waiting on someone outside**: `nod hold <id> --on "<who/what>" --until <date>` — a day to check back is required
  (status "waiting", not stuck); `nod start <id>` once it clears.
- **Need the owner to decide**: `nod ask <id> -o …` on the current node,
  or a new child node with options; the answer arrives via nod monitor
  (below).
- **Whoever finishes a node closes it — don't wait for anyone**: once the work
  is merged and the checks (tests, gate) pass, run `nod done <id> --note
  "<result, commit>"` right away. A reviewer who finds a problem reopens it
  with `nod start <id>` — reviewing is not closing. When delegating, never
  tell a sub-agent "don't mark it done, wait for me". Before merging, the lead
  runs `nod tree <parent>` and checks every child node, including ones
  sub-agents created.
- **Wrapping up**: `nod done <id> --note "<result>"`; not doing it after
  all → `nod close <id> --reason obsolete|superseded|merged-into:<id>`.
  `nod read` collects the owner's answer; `done` only once the question
  is actually settled.
- **Outbound content**: `nod attach <id> draft --approval-content
  --approve-on <option>` before sending; `nod approved <id> --check
  draft` must pass first. Never `--human` to approve on the owner's
  behalf.
- **Attachments follow the message, not one block at the end**: `nod
  attach` with no `--to` lands on your own latest note, else the body;
  `nod note <id> "…" --attach a.png` writes a reply and its evidence
  together. `--to body|last|<n>` picks a section explicitly.
- **External sources**: the lead registers an issue tracker, inbox, or
  feedback form with `nod source register`; sync scripts sync ids and
  titles only. New items arrive via nod monitor; `nod source ack` once
  handled.
- **Deferring**: the owner can defer a node (`d` in the bench, or
  `nod defer`) — it leaves available/active/decide without changing
  state; seeing 「owner 延迟」means stop until it's lifted.
  `nod defer <id> --until fri` (or 3d, 15 nov, 下周一) brings it back on
  its own that day; the monitor then prints `NODDIT-UNDEFERRED <id>` —
  pick it up again as if it were just undeferred.
- **The owner's own to-dos** (`assignee: human`, 「For you」 on the
  bench, listed in Needs you): never start, claim, expand or work on
  one — no check-ins or stale nags come for them. You may file one when
  something needs the owner's hands: `nod add --for me "Call the vendor"
  --parent <id>`, and put the work that waits on it `--after` it. Hand a
  task to the owner with `nod assign <id> me`; taking one back for an AI
  (`nod assign <id> ai --force`) only when they said so.
- **Relay the owner's chat replies**: before replying, record what they
  said about a node (W305, X4, or one you recognize): `nod note <id>
  --human --by "owner (said in chat, relayed by <you>)" "<their words>"`
  (screenshots via `nod attach`), then `nod read <id>` to collect it;
  log what you did with `--agent` once handled. A node the owner replied
  to is yours to act on; `nod ask <id>` to put it back in front of them.

## Getting notified: nod monitor (MUST FOLLOW)

- **The main session / lead doesn't arm one**: the plugin starts
  `nod monitor --here` automatically each session (current project only,
  lasts the whole session, never expires). Each line is one thing to act
  on: an owner answer/reply → `nod read` it, then reply on the node with
  what you'll do (a short note, or `nod read <id> --ack "…"` in one
  step) — a reply the owner can see is itself a notifying event, so this
  matters; `DECS-UNCLAIMED` → an unclaimed answer, go claim it; a new
  external-source item → handle it, then `nod source ack`; a
  `NODDIT-CHECKIN` line → reply right away on that node with
  `nod progress`, `nod note`, or `nod beat <id>` if there's nothing new
  to say yet — after 3 unanswered the bench flags it (usually piggybacked
  on another line, but it can show up on its own after a long enough
  silence); a `NODDIT-STALE` line → some not-started, not-decision-
  blocked nodes have sat untouched — `nod start`, `nod defer`,
  `nod close`, or re-plan each one; `DECS-ERROR` → look, the monitor
  keeps going.
- **`DECS-IDLE`**: after 2 quiet hours the monitor stops itself. Need to
  wait on a reply again later? Arm it: `Monitor({ command: "nod
  monitor", description: "nod", timeout_ms: 1800000 })`, re-arm
  unchanged on expiry (it remembers where it left off).
- **A bare `nod monitor` only watches the project under its cwd** — same
  as `--here`, minus exiting when there's none. Watching every registered
  project needs `--all-projects` spelled out; don't add it just to be
  safe, it means seeing other projects' nodes too.
- **Sub-agents and teammates handle only their own nodes, always with
  `--mine`**: arm `Monitor({ command: "nod monitor --mine", description:
  "nod", timeout_ms: 1800000 })` on start and re-arm it unchanged on
  expiry. In a teammate session the monitor the plugin starts recognises
  the teammate and only reports its own nodes. A node that isn't yours is
  the lead's — leave it. `nod whoami` shows the identity (`NODDIT_IDENTITY`,
  else your author name plus a session id) a monitor matches against, and
  that gets stamped — invisibly — on everything you write, so relaying the
  owner's own words never echoes back to you.
- The lead / main session never adds `--mine` (a sub-agent's node is
  authored in its name — add it and you miss the notification).
- No `nod wait` in a background shell, no home-grown polling, no
  `nod watch` (that one's for humans).

## Briefs from the owner: claim → expand → ask (MUST FOLLOW)

- The owner hands work over in a few words — `nod add "…"` in their own
  terminal, `p` in the bench, the app's new-task box. That node is a brief:
  ✎ in the bench, `intake: true`, the owner's words verbatim under
  `## 原话`. The lead's monitor prints `DECS-BRIEF <id> …` (once more if
  still unclaimed after 5 minutes); a `--mine` monitor only for briefs
  filed under its own nodes.
- **Claim first**: `nod claim <id>`. It is atomic — if it says someone else
  has it, leave it. Never expand a brief you didn't claim.
- **Expand**: `nod expand <id> [--title "…"] <<'EOF' … EOF` — what, why,
  done when; mark assumptions as assumptions. The words under 原话 are
  never edited.
- **Split**: child nodes `nod add --task "…" --parent <id> --after <id>
  --est 30m`.
- **The owner confirms before any work starts**: `nod ask <id> -o
  1="start as planned" 2="change it (say how in your reply)"`, no default.
  Answer 1 → `nod read <id>` and carry on as usual; answer 2 → revise
  (expand again, adjust the children) and ask again.
- Asked in chat to treat a short node the owner wrote this way: `nod claim
  <id>`, then the same steps. Relaying new work the owner described in
  chat: `nod add --brief --author owner "<their words>"`.
- `nod briefs` lists what waits; `nod sessions` shows who is listening.
  Opening a new session (`nod session start`) is the owner's call — don't
  start one yourself.
