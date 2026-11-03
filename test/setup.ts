import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// core/config.ts binds DECS_HOME to a constant the moment it is first imported, not read per
// call — a test that only reassigns process.env.DECS_HOME later (the way bench() redirects fold
// state) would still read and write the real ~/.decs/config.json. Set a throwaway one before
// anything else in this process can import that module. ||= so a file that pins its own (the
// way test/settings-dialog.test.ts must, before any of its own imports) still wins.
// DECS_HOME only, not NODDIT_HOME: core/env.ts's nodditEnv checks NODDIT_<suffix> first — a
// global default under that name would outrank the plain `DECS_HOME: home` nearly every
// decs()/decsResult() call in this suite passes to its own spawned subprocess (test/helpers.ts
// spreads process.env first), silently redirecting dozens of tests to this one shared throwaway
// instead of their own. DECS_HOME alone has nothing to lose to.
const NOD_TEST_HOME = mkdtempSync(join(tmpdir(), 'nod-home-'))
process.env.DECS_HOME ||= NOD_TEST_HOME
// The suite's expectations are written in English; tests about language pick their own.
process.env.DECS_LANG ||= 'en'
// Run as the lead even inside a teammate session, where the monitor would otherwise filter to that teammate.
process.env.DECS_TEAMMATE = ''
// A string printed with a placeholder left unfilled fails the test that printed it.
process.env.DECS_STRICT_I18N = '1'
// node --test sets FORCE_COLOR when run in a terminal; children would then colour plain output like console.log(2).
delete process.env.FORCE_COLOR
// ink stops redrawing when it detects CI; the bench tests read its frames.
process.env.CI = 'false'
process.env.CONTINUOUS_INTEGRATION = 'false'
// Note headings carry local wall-clock time; fixtures are written in +08:00.
process.env.TZ = 'Asia/Shanghai'
// No test may open a terminal window: `nod session start` records its plan here instead.
process.env.NODDIT_LAUNCH_RECORD ||= join(tmpdir(), `nod-launch-${process.pid}.jsonl`)
// Never the user's own tabs: a test that edits views points this at a file of its own.
process.env.NODDIT_VIEWS ||= join(tmpdir(), `nod-views-${process.pid}-absent.json`)
// Which node each session is on is per user; the suite keeps its own, and never keys it by the session running the suite.
process.env.NODDIT_SESSION_NODES ||= join(tmpdir(), `nod-session-nodes-${process.pid}.json`)
delete process.env.CLAUDE_CODE_SESSION_ID
// Same reasoning, for N296's override: a lane running the suite from its own
// worktree must not leak that worktree into session-key expectations either.
delete process.env.NODDIT_WORKTREE
delete process.env.DECS_WORKTREE
