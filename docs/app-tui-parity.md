# App / terminal board feature parity

The desktop app (`app/src`) and the terminal board (`src/tui`, opened by running `nod` with no
arguments) are meant to stay at feature parity: anything the owner can do in one, they can do in
the other, unless a row below marks it UI-only. This table is the checklist — a feature added or
changed in either one gets a row here in the same change (see `AGENTS.md`).

Read from the code, not from memory: the app's menus/keys live in `app/src/bench.tsx`,
`header.tsx`, `newnode.tsx`, `quick.tsx`, `settings.tsx`, `views.tsx`, `viewer.tsx`,
`main-agent.tsx`, `nod-meter.tsx`, `sources.tsx`, `cycles.tsx`; the terminal board's keys live in
`src/tui/app.ts` and its help screen (`src/i18n/locales/en/bench.json`, `helpScreen`).

| Feature | App (where) | Terminal board (key) | Note |
|---|---|---|---|
| **Views & navigation** | | | |
| Switch between views | Sidebar click, or `⌘1`–`⌘6` | `Tab` / `⇧Tab` | |
| Filter to one project | Sidebar project click, or `⌘⌥1`–`⌘⌥9` | *(none)* | Tree groups by project and dims ancestors instead — equivalent, different presentation |
| Expand / collapse one node | Triangle, or `←` `→` / `+` `-` | `←` `→` / `+` `-` | |
| Expand / collapse a whole view at once | Right-click a view tab → Expand all / Collapse all | *(none — one node at a time)* | No natural one-key terminal equivalent; low impact |
| Jump to a node by ref or title | `g` / `:` → palette, matches ref or a title substring | `g` / `:` prompts for a ref; falls back to the same title match the palette uses | |
| Jump to the next decision an AI is stuck on | `W` | `w` / `W` | |
| Switch to the Live (all-activity) view | `H` | `h` | |
| Resize the sidebar / list / detail columns | Drag the dividers | *(fixed layout)* | **UI-only** — drag gesture |
| New-row arrival animation, "+N new" toast | Automatic | Rows just appear | **UI-only** |
| Scroll the detail/body pane | Mouse wheel/trackpad, or `j` / `k` | `j` / `k` one line, `Ctrl-F` / `Ctrl-B` a screen, `Ctrl-D` / `Ctrl-U` half a screen, `Home` / `G` top/bottom | Terminal adds screen jumps the GUI's native scrolling doesn't need |
| **Answering & sub-questions** | | | |
| Pick an option | Click the option card, or a digit key | Digit key | |
| Answer with the written default | `Enter` | `Enter` | |
| Step through several sub-questions | All chips shown at once, click to pick each | Sub-question mode: `↑` `↓` picks the question, `←` `→` or the option's own letter picks it | Different layout, same result |
| Sub-question "Other…" free text | Chip "Other…" opens a text box | `o` / `O` | |
| Note on a picked (non-"Other") sub-question answer | Sticky-note icon beside the question opens an inline box | `n` / `N`, in sub-question mode | |
| One overall note after answering all sub-questions | Text box under the sub-questions, before Submit | After stepping through, `Enter` opens a note box, `Enter` again submits | |
| Free-text answer (no options on the node) | "Free answer" composer | Free-text answer / note composer | |
| Change an already-answered decision | Locked — "Change answer" unlocks it | No lock — any digit re-answers | Terminal board is more permissive, not a gap |
| See earlier round(s) of a re-asked question | Collapsible "Previous round(s)" in the detail pane | Same, in the detail pane | |
| **Reply, edit, attachments** | | | |
| Reply without changing the decision | `N`, or a button | `N` / `n` | |
| Attach a file to a reply, answer, or free-text answer | Drag-and-drop or paste anywhere in the composer | `Ctrl-A` while writing a reply or confirming an answer stages file paths/URLs | Mechanism differs (drop/paste vs. a typed path); neither side attaches to a close reason |
| Edit the description, or your own latest reply, in place | Click the pencil / title → inline rich-text editor | `E` (description) / `e` (your latest reply) shells out to `$VISUAL`/`$EDITOR` | Same change-since-you-opened-it conflict check as `nod edit`; different editing surface |
| Retitle a node | Click the title → inline field, `Enter` saves | `T`, prompt pre-filled, `Enter` saves | |
| Close a node with a reason | Right-click → Close | `x` / `X` | |
| Mark done / archive | Right-click → Done / Archive (answered work auto-completes) | `a` / `A` | Same decided-vs-ask-why rule both sides |
| Delay a node (to a day, or waiting on someone/something, with or without a date) | `D` → one dialog (day + optional who) | `d` → asks the day, then who | One idea, two names (`nod defer` / `nod hold`) |
| Delay by the node's own "every N days" | Defer submenu → "every N days" | `D` | |
| Mark important (★) | `!`, or right-click | `!` | |
| Reassign a node (me ↔ AI) | Right-click → Assign to AI / me | `@` | |
| Start a node (not started → running) | Right-click → Start | `s` / `S` | |
| Reorder among siblings | `⌥↑` / `⌥↓`, or drag | `M` move mode, `↑` `↓` | Drag is UI-only; the keyboard path matches |
| Pick several nodes, then act on all of them | `⌘`-click / `⇧`-click / `⇧↑↓` / drag a box; batch actions in the right pane and right-click menu | `Space` marks a row; `d D s @ ! A` then act on every marked node | Mouse selection vs. keyboard marks, same batch actions |
| **New node / quick add** | | | |
| New to-do for yourself | `⌘N` dialog, who = me | `p` / `P` | |
| File a brief for an AI to expand | `⌘N` who = brief, or `⌘K` quick entry | `p` / `P` (the default kind) | |
| New direct AI task (no expand-and-confirm step) | `⌘N` who = AI | `p` / `P`, then `Tab` cycles brief → to-do → task → brief | |
| Nest the new node under the selected node, vs. the project's top level | Chip "under `<ref>`" | `p` (nested) / `P` (top level) | |
| Mark important at creation | Chip in the `⌘N` dialog | Not at creation — `!` right after | Two steps in the terminal, not tracked as a gap |
| Start immediately at creation | Chip "Start now" (not offered for a brief) | Not at creation — `s` right after | Two steps |
| Pick the target project, with several open | Dropdown in the dialog | `P` with more than one project asks first (digit or `↑↓`, `Enter`) | |
| Offer to open a session when nobody is listening | Confirm dialog after filing | `y` / `n` prompt | |
| **Attachments, images, previews** | | | |
| Inline image thumbnails | Real thumbnails | 🖼️ placeholder row | **UI-only** — terminal rendering limit |
| Full-size image view | Lightbox overlay | iTerm2/kitty inline image protocol, or the system viewer | **UI-only** |
| Zoom and pan an image | Scroll-wheel zoom + drag-pan, cursor-anchored | `+` `-` `0` zoom, arrow keys pan a fixed step | **UI-only** — image zoom gestures |
| Flip through several images | `←` `→`, stops at the ends | `←` `→`, names "first/last" at the ends | |
| Before/after compare view | `Compare` component, side by side | Not built — each image viewed on its own | Decided not to build; a terminal can't show two images side by side |
| Preview text/Markdown (first MB) | Inline viewer | `o` / `O` opens paginated text mode | |
| Preview HTML | Sandboxed inline iframe, page/source toggle | `H` opens it in the system browser; `o` shows source text only | **UI-only** — HTML preview |
| Open a file in its system default app | Menu / button | `O` | |
| Outbound attachment approval status | Header chips (pending/approved/declined, coloured) | Coloured approval lines in the detail pane | |
| Copy a node's ref / title / path / Markdown link | Right-click → Copy submenu | *(none)* | Not tracked as a gap — a terminal's own text selection already copies any visible ref, title or path |
| **Projects & sessions** | | | |
| Add a project | `⌘O`, or sidebar "+" (folder picker) | `;` panel → "+ Add project" → type a path | |
| Rename a project | Double-click the name, or right-click → Rename | `;` panel, `Enter` on its row | |
| Change a project's letter | Double-click the letter, or right-click → Change letter | `;` panel, `←` `→` | |
| Unlink a project | Right-click → Unlink (+ confirm) | `;` panel, `u` | |
| Bring a project's own agent terminal forward | Right-click a project → go to session | `l` / `L` (current project) | |
| See who's listening in each project | Dot per project + tooltip | Summary strip: `●` / `○` + project + who + how long | |
| Project's pending-work count | Sidebar badge, per project | Summary strip's overall stale-task count | Coarser grain, not per project |
| Cross-project "main agent": see if it's live, bring its terminal forward, or start one if offline | Sidebar's pinned "Main agent" row | Header line's own dot (`● online` / `○ offline`); `Ctrl-L` goes to it or starts one (`m` / `M` are taken — toggle milestone / move mode) | Closed 2026-11-03 |
| Daily Nod counter: how many owner actions (a reply, a decision answered, a node they filed themselves) landed each day | Sidebar's ⚡ row above "Views": today's count, a 3-bar chart (today / yesterday / 7-day average), click to expand the last 7 days | Header line, after the main-agent dot: `⚡ Today N · Yesterday M · 7d avg K` | Closed 2026-11-03. Every registered project, archived nodes included; AI writes never count; `nod bench --json`'s `nods` field (`core/nods.ts`) |
| Start an agent session directly, without filing a brief first | Right-click a project → Start session | `t` (the cursor node's own project, or the primary project with nothing selected); refuses the same way `nod session start` does when a lead already listens there, saying who | Closed 2026-11-03 |
| **Custom views (the view editor)** | | | |
| Add / edit / reorder / delete a view: filter text, layout, grouping, sort, finished/deferred handling, live match-count preview | Gear icon in the sidebar, or right-click a view → "Edit this view" | `v` panel: `↑↓` picks, `Enter` edits its fields, `a` adds, `x` deletes (refuses the last one), `m` moves it | Closed 2026-11-03. The terminal editor doesn't expose the view's icon (cosmetic — not rendered in terminal tabs) or its `window-days` / `window-max` / `count` fields; set those with `nod view edit` |
| **Settings** | | | |
| Shared settings (language, right-to-left text, mouse, idle-exit, …) | Settings dialog (`⌘,`) | `,` panel | Both read the same `nod config` list |
| Notification style (system / banner / off) | Settings dialog | *(none)* | **UI-only** — a terminal has no independent notification system |
| Notification sounds: "update" / "decide" chimes, each on/off, an A/B variant, one volume slider, preview | Settings dialog — synthesized live with Web Audio, no audio file | *(none)* | **UI-only** — a terminal has no audio API. A bell for "decide" behind its own setting would be possible, but isn't built here: it would touch `src/tui`, `src/core/settings.ts` and all five locale `bench.json` files, left for a separate change rather than risk a conflict with the TUI work landing alongside this one |
| Global hotkey to summon the app | Settings dialog, recorded live | *(none)* | **UI-only** — global hotkey |
| Keep the app running in the tray | Settings dialog, checkbox | *(none)* | **UI-only** — tray |
| **Notifications & external sources** | | | |
| In-app notice stack (reply, decision, claimed, check-in, uncollected answer) | `NoticeStack`, auto-dismiss, click jumps to the node | Top banner (2.6s) + a separate banner for new/decided nodes | |
| Banner window, global-hotkey summon, OS notification centre | Separate window / OS notification | *(none)* | **UI-only** — system notifications |
| External source sync status (unhandled / owner / us buckets, stale heartbeat) | Sidebar panel, under the project list | Summary strip, under the tabs | |
| `after`-cycle warning | Banner pinned above the list while any loop stands | Summary strip, in red | |
