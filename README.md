**English** · [Simplified Chinese](README.zh-Hans.md) · [Traditional Chinese](README.zh-Hant.md) · [French](README.fr.md) · [Arabic](README.ar.md)

# Noddit

*Where you and your AI hand work to each other.*

You give an agent a two-hour job — or five agents, one each — and walk away.
An hour later, three of them have been sitting on a question in chats you
weren't watching, and you can't tell which one is still working.

**Noddit gives your agents one place to put their work and their questions, and
gives you one screen to watch it all. Agents ask; you answer with one keypress;
the agent hears about it and carries on — while it's still running.**

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/WeCarbon/noddit/main/docs/app.en.dark.png">
  <img alt="The Noddit desktop app: the Available view with a pending decision open, its two options as cards, progress bars and a new request waiting for an AI" src="https://raw.githubusercontent.com/WeCarbon/noddit/main/docs/app.en.png">
</picture>

<sub>Desktop app — <a href="https://github.com/WeCarbon/noddit/releases/latest">download for macOS, Windows and Linux</a></sub>

![Demo: the nod bench opens on a tree of running work; read a pending decision, answer it with a keystroke, then an agent picks up the answer with nod read](https://raw.githubusercontent.com/WeCarbon/noddit/main/docs/demo.gif)

<sub>In the terminal</sub>

## Why

| Without Noddit | With Noddit |
|---|---|
| An agent asks "A or B?" in chat. You miss it; it waits for an hour. | Every open question is on one screen, the ones blocking an agent first. |
| You answer, the answer scrolls away, the next session never sees it. | The question and your answer are a markdown file in git, for good. |
| "What are you doing? How far along?" — you have to ask, and interrupt. | Each task shows its progress bar; one that goes quiet turns grey, then red. |
| Five agents share one `TODO.md`, pick the same number, overwrite each other. | Every task is its own file with its own id; any number of agents write at once. |
| You step away and everything stops. | Each question carries a default and says what happens if you don't answer; agents keep going on the rest. |

It's not a board you plan work on. It's the line between a running agent and
you: its question reaches you, your answer reaches it, and both are kept.

## What it looks like

1. Your agent hits a choice. Instead of asking in chat, it runs:

   ```sh
   nod ask W4 -o 1="Keep current CDN" 2="Switch to Fastly" --default 1
   ```

2. You run `nod` in any terminal. W4 is at the top, marked ◆ Decide, with
   both options and what each one costs.

3. You press `2`.

4. The agent is told right away, reads "Switch to Fastly" and carries on.
   The question and your answer stay in `decisions/active/4-pick-cdn.md`, in git.

## Quickstart (Claude Code)

```sh
npm i -g @wecarbon/noddit
cd your-project && nod init
```

Then, inside Claude Code:

```
/plugin marketplace add wecarbon/noddit
/plugin install decs@decisions-md
```

That's it. Give your agent a task as usual. It logs its work and asks its
questions through nod on its own. Run `nod` in another terminal to watch.
(`decs` still works as an alias, for every command on this page.)

Using a different agent? Paste [`AGENTS.md`](AGENTS.md) into its instructions —
the rules are plain CLI calls, so any agent with a shell can follow them.

## Three words

- **Node** — one thing an agent is doing. One markdown file.
- **Decide** — a node that needs your answer. It shows up with options; press a number.
- **Bench** — the screen you get when you run `nod`. Everything, live.

That's all you need to start. The rest of this page is how it works underneath.

---

## The idea

One kind of thing — a **node** — and one id space.

A node is something the AI does. When the agent knows how, it just does it.
When it needs the owner first, the node becomes **needs decision**, with
options, a default, and what happens if nobody answers. A running node that
hits a question doesn't spawn a second entry; it turns into a question itself,
and goes back to running when you answer.

```
decisions/
  decs.json                                  # {"letter": "W"} → refs read W12
  active/12-ship-v2-4.md                     # a root node still in play
  active/12-ship-v2-4/13-run-test-suite.md   # its children live in its folder
  archived/9-rotate-api-keys.md              # done or closed, kept forever
  attachments/12/after.png
  .ids/12                                    # zero-byte reservation (O_EXCL)
```

Because every node is its own file and ids are reserved with `O_EXCL`, any number
of agents can write at once without colliding. Because it's markdown in git, you
get history, diffs, review and grep for free.

## What you get

**For the human — the bench.** `nod bench` is a live terminal UI over every
project you've registered. Five tabs:

| tab | shows |
|---|---|
| **Available** | what can move now: running, waiting on someone, ready to start, needs you, answered |
| **Active** | what's happening: running and needs-decision only |
| **Decide** | just the questions for you, per project, the ones blocking an agent first |
| **All** | everything, finished nodes folded into a `✓ Completed N` row |
| **Waiting** | held up outside — a colleague, a customer, a service — longest wait first |

The left pane is the node tree with progress bars and staleness (grey past 30
minutes without an update, red past an hour). The right pane is the selected
node: status, urgency, *"if you don't answer"*, parent, dependencies, body,
attachments. Press `1`–`9` to answer, `Enter` for the default. Screenshots
render inline in the terminal (iTerm2, kitty, Ghostty, WezTerm).

**For the agent — a CLI and a contract.** Agents create nodes, break them into
child nodes, report progress, ask questions, and get notified of your answers:

```sh
nod add "Ship v2.4" --task --author "lead · release"          # → W12
nod add "Run full test suite" --task --parent W12 --after W14
nod start W13
pytest | nod progress --parse pytest                           # bar moves by itself

nod ask W15 -o 1="Short & playful" 2="Plain & direct" --default 2 <<'EOF'
**What.** The first screen new users see after sign-up …
EOF
```

**Notifications without polling.** `nod monitor` prints one line per thing an
agent must act on — an owner answer, a reply, a new item from an external
source, an answer nobody has picked up for five minutes — and remembers where
each session left off. The Claude Code plugin starts it for the whole session
(`nod monitor --here`, watching the current project); it goes offline by itself
after two quiet hours with a `DECS-IDLE` line. Sub-agents, or a session after
`DECS-IDLE`, arm it with Claude Code's Monitor tool:

```
Monitor({ command: "nod monitor --mine", description: "nod", timeout_ms: 1800000 })
```

**Dependencies and order.** `--after W13` holds a node back until W13 is done.
You can still answer a question early; the node then waits as **to do** and
starts when its turn comes.

**External sources.** Point a tiny adapter at GitHub issues, a support inbox or
a feedback form. It syncs *references only* (id + title, optional url/state/from),
never bodies, never credentials. The bench header tells you, per source,
whether it's cleared and who holds what:

```
Sources github-issues ✗ unhandled 2 W7 1   support-inbox ✓ clear
```

**Approval gates for anything that leaves the building.** Attach a draft with
`--approval-content`; nod records its sha256. Before sending, the agent runs
`nod approved W20 --check draft.html` — it fails unless *you* picked the
approving option *for exactly that content*. An agent relaying "send it" from
the chat can't approve on your behalf.

**Defer.** Press `d` on anything you want out of sight. It leaves the working
views without changing state, and the agent on it is told it was deferred and stops
until you lift it.

## Install

Requires Node 22.18+.

```sh
npm i -g @wecarbon/noddit

cd ~/code/your-project
nod init --letter W                  # creates decisions/, registers the project
nod add "Try nod" --task --author "me · kicking the tyres"
nod                                  # the bench (same as nod bench); q to quit
```

No install: `npx @wecarbon/noddit init --letter W` works the same way, one command at a time.

### From source

TypeScript runs directly; there is no build step.

```sh
git clone https://github.com/wecarbon/noddit.git
cd noddit && npm install
export PATH="$PWD/bin:$PATH"          # add to your shell profile

cd ~/code/your-project
nod init --letter W
nod add "Try nod" --task --author "me · kicking the tyres"
nod
```

### With Claude Code

The repo is also a Claude Code plugin marketplace. The plugin injects the usage
rules at the start of every session (plus the project's open nodes, so a
resumed session picks its work back up), starts `nod monitor` for the session
so your answers reach the agent without it polling, and reminds the agent to
record what you say about a node in chat before replying.

```
/plugin marketplace add wecarbon/noddit
/plugin install decs@decisions-md
```

(`/plugin marketplace add /path/to/noddit` works for a local clone.)

The full agent guide is [`AGENTS.md`](AGENTS.md) — paste it into your own
`AGENTS.md` / `CLAUDE.md` if you use a different agent harness. The rules are
CLI calls, so any agent with a shell can follow them.

## Language

`nod` picks the UI language in this order:

1. `--lang <code>` on any command, e.g. `nod bench --lang fr`
2. the `NODDIT_LANG` environment variable (`DECS_LANG` still works)
3. `nod config lang <code>` — stored per user in `~/.decs/config.json`
   (`$NODDIT_HOME/config.json`). `nod config lang` alone shows the current
   language and where it comes from; `nod config lang --off` removes it.
4. the system locale (`LC_ALL` / `LC_MESSAGES` / `LANG`, `C` / `POSIX`
   ignored): `zh_CN` → `zh-Hans`, `zh_TW` / `zh_HK` → `zh-Hant`, `fr_*` →
   `fr`, `ar_*` → `ar`
5. the OS display language, when none of those locale variables are set —
   plain Windows terminals (cmd, PowerShell) have none, so nod reads it the
   way Node's `Intl` reports it
6. otherwise, English — also where a locale nod has no translation for
   ends up

Codes: `en`, `zh-Hans`, `zh-Hant`, `fr`, `ar`. The plugin's prompt
reminder follows the same resolution; the session-start rules
(`plugin/rules.md`) are English in every language.

Arabic is laid out right to left. `NODDIT_BIDI=visual|terminal` (`DECS_BIDI`
still works, or `nod config bidi visual|terminal`, `--off` to remove) picks how: `visual`
(the default) has nod reorder each line itself with the Unicode
Bidirectional Algorithm, for terminals that draw strictly left to right
(e.g. macOS Terminal); `terminal` has nod write logical order and wrap
embedded left-to-right runs (refs like W12, numbers, commands, English
titles) in Unicode isolates, for terminals that apply bidi themselves
(iTerm2 with bidi enabled, kitty, VTE-based terminals). In Arabic the bench
also mirrors: the list sits on the right, details on the left. Output to
pipes and `--json` always stays in logical order, so scripts and agents
read it unchanged. Relative times ("3 days ago") follow the language too.

The on-disk file format never changes with the language: `nod` always
writes one fixed set of section headings, so a repo stays readable by every
teammate whatever language their CLI speaks. When you write a file by hand,
`## Options`, `## Attachments` and `## Questions` are accepted. See [The file format](#the-file-format) below.

## How a session goes

1. You give the lead agent a goal. It runs `nod add "Ship v2.4" --task`, starts
   it, and splits it into child nodes with `--after` dependencies.
2. It hands lanes (sub-agents) their own nodes. Each lane pipes its long
   commands into `nod progress`; the bench bars move on their own.
3. A lane hits a fork in the road. It runs `nod ask <id> -o …` with options,
   costs and a default. The node turns yellow `◆` in your bench.
4. You press `2`. `nod monitor` wakes the lane; it runs `nod read`, carries on,
   and finally `nod done <id> --note "412/412 passing"`.
5. You never had to ask "where are we?" — and next week, the whole story is
   still in `decisions/archived/`.

## CLI cheat sheet

| | |
|---|---|
| `nod init [--letter W]` | create `decisions/` here and register the project |
| `nod add <title> [--task] [-o 1=… 2=…]` | new node; with options it needs a decision. Body from stdin |
| `nod add <title> --parent W12 --after W13` | child node, ordered after another |
| `nod start / done / close <id>` | To do → In progress → Done / Closed (`--reason obsolete\|superseded\|merged-into:W15`) |
| `nod ask <id> -o 1=… 2=…` | a running node needs the owner |
| `nod hold <id> --on "Carol: icon set" --until fri` | waiting on someone outside (an active delay, purple); not counted as stuck — same as `nod defer --on` |
| `nod progress <pct> "msg"` · `… \| nod progress --parse pytest` | report progress (or let a pipe report it) |
| `nod steps <id> "a" "b" "c"` · `nod step <id> 2` | multi-step work, percent computed for you |
| `nod note <id> "…"` | append a record (agent by default; `--human` for the owner) |
| `nod push <id> 2 [--note …]` | record an answer |
| `nod monitor [--mine] [--here] [--idle-exit 2h]` | the agent's notification stream |
| `nod read <id>` · `nod queue` | collect answers / see what's uncollected |
| `nod attach <id> file [--approval-content --approve-on 1]` | attach a file; gate it on approval |
| `nod approved <id> --check <file>` | exit 0 only if exactly this content was approved |
| `nod defer <id> [--until <date>]` · `nod undefer <id>` | put off, to a day or indefinitely (a passive delay, grey) / bring back |
| `nod show [open\|active\|deferred\|…] [--stale]` · `nod tree` · `nod get <id>` | read the store |
| `nod search <words> [--all]` | titles, bodies, notes, attachment names |
| `nod source register/sync/push/list/items/ack` | external sources |
| `nod changes --since <t>` | everything after a cursor, for catching up |
| `nod bench [.\|<dir>…] [--view decide]` | the live screen |
| `nod` | on a terminal, the same as `nod bench`; piped or in a script, prints the usage |
| `nod config [<setting> [<value>\|--off]]` | your settings: lang, bidi, view, images, mouse, idle-exit, unclaimed-after (also in the bench: `,`) |

Ids are `305`, `W305` (project letter), `web:305` (project name), or legacy
`D305`. `nod <command> --help` has the rest.

## Bench keys

| key | |
|---|---|
| `↑` `↓` | move |
| `←` `→` · `-` `+` | fold / unfold (remembered across sessions) |
| `Tab` `Shift-Tab` | switch view |
| `1`–`9` · `Enter` | answer · take the default |
| `w` | jump to the next node an agent is stuck on |
| `g` or `:` | go to an id |
| `N` | reply without deciding (the node goes back to the agent) |
| `d` | defer / undefer |
| `X` · `A` | close with a reason · mark looked-at and archive |
| `M` | move mode: ↑/↓ moves the node among its siblings (or its group in a list), ⏎ done; the app takes a drag |
| `i` · `o` | pick and view images · open an attachment |
| `j` `k` `Ctrl-F` `Ctrl-B` | scroll the detail pane |
| `Z` · `?` · `q` | condensed body · all keys · quit |
| `,` | settings (language, right-to-left text, mouse, …) |

The mouse works too: click a tab, a node, an option or an attachment; the wheel
scrolls the pane it's over.

## The file format

A node is markdown with YAML front matter. Humans can read it in any editor;
agents and the bench go through the CLI, which handles locking and history.

```markdown
---
id: 1
title: Choose a CDN
author: lane-perf · static assets
status: needs_decision
created: 2026-03-14T10:12:03+00:00
urgency: high
default: "1"
if_no_answer: stay; re-measure Friday
reversible: true
---

**What.** Static assets are served from one region.

**Why now.** APAC p95 doubled last week.

## Options

### 1 · Stay on current CDN

### 2 · Move to edge provider
```

Section headings are fixed tokens, not translated: see [Language](#language)
above for why, and how each person picks their own. Replies and notes are
appended as their own sections, each recording who wrote it and when.

Statuses: `not_started` To do · `in_progress` In progress · `waiting`
Waiting · `needs_decision` Needs decision · `decided` Answered, for AI ·
`completed` Done · `closed` Closed. Children live in a folder named like
their parent's file; ids stay flat, so moving a node is a rename and every
reference still holds.

## Design principles

- **Files, not a service.** Everything is in `decisions/`, versioned with your
  code, readable without nod installed.
- **The filesystem is the lock.** Ids come from `O_EXCL` files; each write
  re-reads the node under its own lock and lands via write-then-rename. Two dozen
  concurrent writers get consecutive ids and lose nothing — there's a test for it.
- **One kind of thing.** Tasks and decisions are the same node. Fewer concepts,
  one id space, one tree.
- **The human never has to ask.** Status, progress, staleness, what's waiting on
  whom — it's all on the bench, not in a chat thread.
- **Roles are explicit.** Every appended section says whether a human or an agent
  wrote it, who, and when. Only human answers approve outbound content.
- **References, not content, from outside.** External sources sync ids and
  titles; bodies and credentials stay where they live.

## FAQ

**Is this only for Claude Code?**
No. The CLI is agent-agnostic — anything with a shell can call it. The Claude
Code plugin adds session-start rules and uses `CLAUDECODE` /
`CLAUDE_SESSION_ID` to tell agent shells from yours and tag who wrote what.
Elsewhere, set `NODDIT_ROLE=agent` and `NODDIT_SESSION` (`DECS_ROLE` / `DECS_SESSION` still work).

**Does it work with git worktrees?**
Yes. `nod` always resolves to the main checkout's `decisions/`, so lanes in
worktrees share one store.

**Several repos at once?**
`nod init` registers each project; `nod bench` with no arguments opens all of
them, grouped by project letter.

**What if nobody answers?**
Every question carries a default and an `--if-no-answer`. `nod wait --timeout`
exits with code 2 and prints the default — the moment to proceed with it.

**Can I edit the files by hand?**
You can read them freely. For writes, use the CLI: it keeps ids, locks, the
answer queue and attachment history consistent.

**I have an old `DECISIONS.md`.**
`nod migrate --dir <project> --dry-run`, then without `--dry-run`.

## Python SDK

Noddit also ships a small Python package, [`noddit` on PyPI](https://pypi.org/project/noddit/) (standard library only, Python 3.10+). It lets long Python jobs report progress to a node — useful when tests or scripts run somewhere `nod` isn't installed, such as a Docker container. A pytest plugin writes one JSON line per test; `progress_events` does the same for any script. On the host, `nod progress --from-file` or `nod run` reads the file and moves the node.

```sh
pip install noddit
pytest --noddit-events events.jsonl          # or NODDIT_EVENTS=events.jsonl pytest
nod run W12 --events events.jsonl -- pytest  # the node's progress bar follows the run
```

```python
from noddit import progress_events

ev = progress_events("events.jsonl")
ev.start(total=23, label="recalculate")
ev.step(done=5, msg="table 3")
ev.finish(ok=True, summary="23 tables")
```

The event format is in [`python/docs/progress-events.md`](python/docs/progress-events.md).

## Development

```sh
npm test            # node --test
npm run typecheck   # tsc --noEmit
node scripts/render-screenshot.ts --out docs/screenshot.en   # regenerate docs/screenshot.<lng>.svg/.png (mock data)
```

The desktop app (`app/src`) and the terminal board (`src/tui`) are meant to stay at feature
parity — [`docs/app-tui-parity.md`](docs/app-tui-parity.md) tracks where each feature lives in
both, and gets a new row whenever one changes.

## License

[MIT](LICENSE) © 2026 WeCarbon
