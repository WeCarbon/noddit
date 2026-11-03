## nod: this project's tasks and decisions live in decisions/ (MUST FOLLOW)

The owner reads only nod (`nod bench`) — status, what you're doing, what
needs deciding, what's next. They won't ask in chat; work not recorded in
nod is invisible to them. The commands teach the rest: each one prints its
next step, and every `nod monitor` line says what to do about it. Unsure
how? `nod <command> --help`; for the details, load the nod skill.

- **Record work as nodes before doing it.** A task and a decision are the
  same thing: `nod add --task "<short title>" --author "<you> · <doing
  what>"`, then `nod start <id>`. A lane's node goes under its lead's
  (`--parent`). Plans are child nodes; new work found mid-task gets one
  too, not just a chat mention.
- **Only nod commands write `decisions/`** — never an editor, `sed`, a
  redirect or moved files. A command can't do what you need? Record a node
  saying what's missing; don't work around it.
- **Need the owner to decide: `nod ask <id> -o 1="…" -o 2="…"`.** Every
  option says what choosing it costs — time, who does it, what is given
  up, risk, whether it can be undone — and which one you recommend and
  why. Keep the `-o` label short and write the rest in the piped body,
  one `### 1 · <label>` section per option:
  `nod ask 7 -o 1="Keep" -o 2="Switch" <<'EOF'` … `EOF`.
- **Whoever finishes a node closes it**: once merged and the gate passes,
  `nod done <id> --note "<result, commit>"` right away. When delegating,
  never tell a sub-agent "don't mark it done". Before merging, the lead
  runs `nod tree <parent>` and checks every child, including ones
  sub-agents created.
- **Hands off what the owner kept or paused**: never work on the owner's
  own to-dos (in Human work); a node the owner deferred waits until it comes
  back.
- **Relay what the owner says in chat** about a node before replying:
  `nod note <id> --human --by "owner (said in chat, relayed by <you>)"
  "<their words>"`, then `nod read <id>`. New work they describe in chat:
  `nod add --brief --author owner "<their words>"`.
- **Anything sent to people outside** (mail, posts, messages) is approved
  in nod first — see the nod skill (`--approval-content`). Never approve
  on the owner's behalf.

## Getting notified: nod monitor (MUST FOLLOW)

- The main session / lead runs plain `nod monitor`, never `--mine` (a
  lane's nodes are signed with the lane's name). The plugin starts it for
  you each session.
- Sub-agents and teammates handle only their own nodes: arm
  `Monitor({ command: "nod monitor --mine", description: "nod",
  timeout_ms: 1800000 })` on start and re-arm it unchanged on expiry. A
  node that isn't yours is the lead's — leave it.
- Each line is one thing to act on and ends with its next step — do that.
  No `nod wait` in a background shell, no home-grown polling, no
  `nod watch` (that one is for humans).
