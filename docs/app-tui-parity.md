# Where the desktop app and the TUI differ on purpose

A running list of features the desktop app has that the TUI deliberately
doesn't match, because the terminal can't do the same thing — not bugs to fix.

## Clickable node refs in prose (`G91` → a link)

The app links a node ref mentioned in a note's body, a note's summary, the
node body, an option's text, or the title — `app/src/refs.ts` (match rule) and
`app/src/body.tsx` (`RefLink`/`RefText`) — to that node, if it resolves to one
in a registered project.

The TUI has no clickable links: a terminal has no pointer events to hook, and
the one jump-by-typing-a-ref mechanism it does have (`:` / `g`, `commitGoto`
in `src/tui/app.ts`) isn't tied to any particular ref shown on screen — the
owner already has to type the ref either way, so there's nothing for this
feature to attach to. A ref mentioned in a body or note's prose stays plain
text in the TUI; the structured ones (`after`, `blocking`, `referencedBy`)
already get their own coloured segments in `src/tui/detail.ts`, unchanged by
this.
