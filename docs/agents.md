# Coding agent CLIs: what each one reads, and how `nod setup` uses it

Research behind `nod setup` (see `src/core/agents.ts`, `src/cli/commands/setup.ts`).
Covers the three CLIs `nod setup` detects: Claude Code (`claude`), OpenAI's
Codex CLI (`codex`), and Moonshot's Kimi Code CLI (`kimi`). All three were
installed locally and queried with `<cli> --help` / `<cli> <subcommand>
--help`; version numbers are what was on hand when this was written and will
drift.

## At a glance

| | project instructions file | nesting | plugins / marketplace | hooks | MCP | background watcher |
|---|---|---|---|---|---|---|
| Claude Code | `CLAUDE.md` | nested, closest wins | yes — `.claude-plugin/`, installable non-interactively | `hooks.json`, incl. `SessionStart` | yes | plugin can start one (this repo's `monitors/`) |
| Codex CLI | `AGENTS.md` (or `AGENTS.override.md`) | root → cwd, concatenated, closest wins | yes (added ~March 2026) — `codex plugin marketplace add` / `codex plugin add` | `hooks.json`, incl. `SessionStart`, but needs one-time interactive trust | yes, `codex mcp add` | no — hooks can be `async` but not long-lived |
| Kimi Code CLI | `AGENTS.md` | project (incl. `.kimi-code/AGENTS.md`) → user (`~/.kimi-code/AGENTS.md`) → plugin → built-in | no marketplace; has skills/sub-agents/MCP instead | yes, but **user-level `config.toml` only** — no project-level hook file | yes, `~/.kimi-code/mcp.json` or project `.kimi-code/mcp.json` | not addressed in the docs; not project-scoped either way |

This is why `nod setup`'s three integrations look different: Claude gets the
real plugin; Codex and Kimi both get the same thing instead — a `decs`
section dropped into the project's `AGENTS.md` — because that is the one
mechanism both of them read and that a script can safely edit.

## Claude Code (`claude`)

- **Instructions file**: `CLAUDE.md`, discovered per the normal nested-directory
  rule (closest to cwd wins); this is the platform nod already plugs into, so
  it isn't re-researched here.
- **Plugins**: `.claude-plugin/plugin.json` + `.claude-plugin/marketplace.json`
  (this repo has both). Installed interactively inside a session with
  `/plugin marketplace add <owner/repo>` then `/plugin install <plugin>@<marketplace>`.
- **Non-interactive install**: `claude plugin marketplace add <source> [--scope user|project|local]`
  then `claude plugin install <plugin>@<marketplace> --scope <scope> --json -y`.
  `-y` accepts a marketplace-declared command without a confirmation prompt
  (required when stdin/stdout isn't a TTY); `--json` on `install` prints one
  machine-readable result line. `marketplace add` has no `--json`/`-y` of its
  own — it's a plain git-fetch-and-register step.
- **Hooks**: `hooks/hooks.json`, wired up by the plugin manifest; events include
  `SessionStart`. This is how nod injects its rules and starts `nod monitor`
  every session (`plugin/session-start.mjs`, `monitors/monitors.json`) — a
  Claude Code plugin feature, not something generic to all three CLIs.
- **`nod setup`'s approach**: run the two non-interactive commands above,
  scoped to the target project (`--scope project`, cwd set to that project).
  If either fails (offline, an older `claude` without `plugin`, a trust prompt
  that can't be answered non-interactively, …), fall back to printing the two
  `/plugin …` lines for the person to run inside an interactive session —
  the same two lines this repo's README already gives for manual install.

## Codex CLI (`codex`)

- **Instructions file**: `AGENTS.md`. Codex reads `AGENTS.override.md` instead
  of `AGENTS.md` when present, at each level. Discovery walks from the git
  repository root down to the current working directory; every file found
  along the way is concatenated, with files closer to the cwd appended later
  (so they win on conflicting guidance). A global layer at `$CODEX_HOME`
  (default `~/.codex`) is included first. Combined size caps out at
  `project_doc_max_bytes` (32 KiB by default).
  Source: [developers.openai.com/codex/guides/agents-md](https://developers.openai.com/codex/guides/agents-md).
- **Plugins**: added to the CLI around March 2026 — `codex plugin marketplace add <owner/repo|git-url|path> [--ref <ref>] [--sparse <path>]`
  then `codex plugin add <plugin>@<marketplace>`. Both support `--json`.
  `codex plugin list [--json] [--available]` and `codex plugin marketplace list`
  round out the read side. A nod marketplace/plugin for Codex is plausible
  future work, but `nod` doesn't ship a Codex plugin today (it would need a
  separate manifest under `.codex-plugin/`), so `nod setup` doesn't attempt
  one — see "Why no hooks or plugin for Codex/Kimi yet" below.
- **Hooks**: `hooks.json`, with the same precedence idea as everywhere else —
  project `.codex/hooks.json` (or `[hooks]` in `.codex/config.toml`) over user
  `~/.codex/hooks.json` over a plugin's own `hooks/hooks.json`. Events include
  `SessionStart`, `SubagentStart`/`SubagentStop`, etc. Command hooks support
  `"async": true`, which runs a one-shot background task and delivers its
  output at the next safe point — not a persistent watcher like `nod monitor`.
  Crucially, **a non-managed hook requires interactive review and trust**
  (`/hooks` inside a session) before Codex will run it; only hooks shipped via
  system/MDM/cloud/`requirements.toml` are trusted automatically. A script
  that drops a `hooks.json` into a project cannot make Codex act on it without
  that one-time manual step. Source: [developers.openai.com/codex/hooks](https://developers.openai.com/codex/hooks).
- **MCP**: `codex mcp add <name> (--url <url> | -- <command>...)`, with
  `--env`, OAuth flags, etc. — not used by nod (nod is a CLI, not an MCP
  server).
- **`nod setup`'s approach**: write the `decs` section into the project's
  `AGENTS.md`, same content Claude's plugin injects (`plugin/rules.md`, English in every
  interface language).
  No hook is installed, for the trust-prompt reason above — a hook a script
  drops in place is dead weight until a human clicks through `/hooks` anyway,
  and `AGENTS.md` already carries the same guidance into context on every
  session without needing that step.

## Kimi Code CLI (`kimi`)

- **Instructions file**: also `AGENTS.md`. Kimi reads it from the project root
  or `.kimi-code/AGENTS.md`, and globally from `$KIMI_CODE_HOME/AGENTS.md`
  (default `~/.kimi-code/AGENTS.md`); a generic cross-tool fallback at
  `~/.agents/AGENTS.md` is also read. Precedence (most specific wins):
  `--agent-file` (explicit) > project > extra > user > plugin > built-in.
  Source: [MoonshotAI/kimi-code docs/en/customization/agents.md](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/customization/agents.md).
- **Plugins**: none. Kimi's "Customization" surface is Agent Skills
  (`--skills-dir`, project/user skill directories), sub-agents, MCP, and
  hooks — no plugin manifest or marketplace to install nod into.
- **Hooks**: configured only in `~/.kimi-code/config.toml` (`[[hooks]]`) — there
  is **no project-level hook file**. Events include `SessionStart`,
  `SessionEnd`, `SessionHeartbeat` (every 60s), `TurnStarted`,
  `SubagentStart`/`Stop`, `TaskStarted`. Hooks don't need interactive trust
  (fail-open: a broken hook is skipped, not blocking), but because they only
  live in the user's global config, a project-scoped setup script would have
  to either edit that global file (touching every other project Kimi is used
  in) or skip hooks entirely. `nod setup` skips them.
- **MCP**: `~/.kimi-code/mcp.json` globally, or `.kimi-code/mcp.json` per
  project — again not relevant to nod, which has no MCP server.
- **`nod setup`'s approach**: the same `AGENTS.md` section as Codex, since
  both read the same file. If a project has both Codex and Kimi installed,
  `nod setup` writes the section once and both pick it up — there's no
  reason to track them as separate files.

## Why no hooks or plugin for Codex/Kimi yet

`nod setup` could in principle also drop a `hooks.json` next to the
`AGENTS.md` edit. It doesn't, because of what's above:

- Codex requires a human to approve any non-managed hook via `/hooks` before
  it runs — a script-installed hook sits inert until someone does that, and
  by then the guidance is already in `AGENTS.md`.
- Kimi's hooks are global, not per-project — writing one would affect every
  other Kimi project on the machine, which breaks "never clobber user
  content" for anything outside the one project `nod setup` was asked about.

Both are revisitable later (a real Codex plugin manifest, or a Kimi hook
guarded to check `cwd` itself), but they're follow-up work, not part of this
command's first cut.

## Sources

- Claude Code: `claude --help`, `claude plugin --help`, `claude plugin
  install --help`, `claude plugin marketplace add --help` (local install,
  version 2.1.280 at research time).
- Codex CLI: `codex --help`, `codex plugin --help`, `codex mcp --help`
  (local install, `codex-cli` 0.155.1), plus
  [developers.openai.com/codex/guides/agents-md](https://developers.openai.com/codex/guides/agents-md) and
  [developers.openai.com/codex/hooks](https://developers.openai.com/codex/hooks).
- Kimi Code CLI: `kimi --help`, `kimi doctor --help` (local install, 2.0.2),
  plus [MoonshotAI/kimi-code docs/en/customization/agents.md](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/customization/agents.md)
  and [MoonshotAI/kimi-code docs/en/customization/hooks.md](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/customization/hooks.md).
